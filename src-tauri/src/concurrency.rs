// Concurrency benchmark: drives N parallel HTTP+SSE workers against a single
// OpenAI-compatible endpoint for a fixed duration, measures per-request TTFT /
// TPOT / TPS, and reports percentile distributions + aggregate throughput.
//
// Lives on the Rust side (not in the WebView) for honest parallelism — N tokio
// tasks each on its own future, with reqwest doing the network. The frontend
// only orchestrates start/cancel and renders the streamed progress events.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex as TokioMutex;
use tokio_util::sync::CancellationToken;

// ---------- Config & data shapes ----------------------------------------

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConcurrencyConfig {
    pub url: String,
    pub api_key: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub prompt: String,
    pub concurrency: u32,
    pub duration_secs: u32,
    pub stall_timeout_secs: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequestMetrics {
    pub ttft_ms: Option<u64>,
    pub tpot_ms: Option<u64>,
    pub tps: Option<f64>,
    pub tokens: u64,
    pub success: bool,
    pub error: Option<String>,
}

impl RequestMetrics {
    fn failure(msg: String) -> Self {
        Self {
            ttft_ms: None,
            tpot_ms: None,
            tps: None,
            tokens: 0,
            success: false,
            error: Some(msg),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProgressEvent {
    Progress {
        elapsed_ms: u64,
        in_flight: u32,
        completed: u64,
        failed: u64,
        aggregate_tps: f64,
        ttft_p50_ms: Option<u64>,
        ttft_p95_ms: Option<u64>,
    },
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub completed: u64,
    pub failed: u64,
    pub total_tokens: u64,
    pub duration_ms: u64,
    pub aggregate_tps: f64,
    pub ttft_p50_ms: Option<u64>,
    pub ttft_p95_ms: Option<u64>,
    pub ttft_p99_ms: Option<u64>,
    pub tpot_p50_ms: Option<u64>,
    pub tpot_p95_ms: Option<u64>,
    pub tpot_p99_ms: Option<u64>,
    pub per_request_tps_median: Option<f64>,
    pub errors: Vec<String>, // up to 20 distinct error messages
}

#[derive(Default)]
struct RunningStats {
    completed: u64,
    failed: u64,
    total_tokens: u64,
    ttfts: Vec<u64>,
    tpots: Vec<u64>,
    per_req_tps: Vec<f64>,
    errors: Vec<String>,
    in_flight: u32,
}

// ---------- Tauri-managed cancellation state ----------------------------

#[derive(Default)]
pub struct ConcurrencyState {
    pub cancel: Mutex<Option<CancellationToken>>,
}

// ---------- Commands ----------------------------------------------------

#[tauri::command]
pub async fn run_concurrency_benchmark(
    config: ConcurrencyConfig,
    on_event: Channel<ProgressEvent>,
    state: State<'_, ConcurrencyState>,
) -> Result<SummaryResult, String> {
    // Reject re-entry: a second invocation while one is in flight would leak
    // the first cancellation token. UI also disables Run while running.
    {
        let mut guard = state.cancel.lock().unwrap();
        if guard.is_some() {
            return Err("A concurrency benchmark is already running.".into());
        }
        *guard = Some(CancellationToken::new());
    }
    let cancel_token = state.cancel.lock().unwrap().clone().unwrap();

    let result = run_inner(config, on_event, cancel_token).await;

    // Always release the cancel slot so the next run can start.
    *state.cancel.lock().unwrap() = None;
    result
}

#[tauri::command]
pub fn cancel_concurrency_benchmark(state: State<'_, ConcurrencyState>) {
    if let Some(token) = state.cancel.lock().unwrap().as_ref() {
        token.cancel();
    }
}

// ---------- Orchestrator ------------------------------------------------

async fn run_inner(
    config: ConcurrencyConfig,
    on_event: Channel<ProgressEvent>,
    cancel_token: CancellationToken,
) -> Result<SummaryResult, String> {
    let concurrency = config.concurrency.max(1);
    let duration = Duration::from_secs(config.duration_secs.max(1) as u64);
    let start = Instant::now();
    let deadline = start + duration;

    let client = reqwest::Client::builder()
        // Per-request hard ceiling; the per-chunk stall timer fires first under
        // normal conditions.
        .timeout(Duration::from_secs(60 * 10))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let stats = Arc::new(TokioMutex::new(RunningStats::default()));
    let config = Arc::new(config);

    // ---- Workers ----
    let mut handles = Vec::with_capacity(concurrency as usize);
    for _worker_id in 0..concurrency {
        let client = client.clone();
        let cfg = config.clone();
        let stats = stats.clone();
        let token = cancel_token.clone();
        handles.push(tokio::spawn(async move {
            while Instant::now() < deadline && !token.is_cancelled() {
                {
                    let mut s = stats.lock().await;
                    s.in_flight += 1;
                }
                let metric = tokio::select! {
                    biased;
                    _ = token.cancelled() => {
                        let mut s = stats.lock().await;
                        s.in_flight = s.in_flight.saturating_sub(1);
                        break;
                    }
                    m = run_one_request(&client, &cfg, &token) => m,
                };
                let mut s = stats.lock().await;
                s.in_flight = s.in_flight.saturating_sub(1);
                record_metric(metric, &mut s);
            }
        }));
    }

    // ---- Progress emitter: ticks every 250ms with running aggregates ----
    let progress_handle = {
        let stats = stats.clone();
        let token = cancel_token.clone();
        let channel = on_event.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(250));
            // Skip the immediate first tick — we want measurable progress.
            tick.tick().await;
            loop {
                tokio::select! {
                    biased;
                    _ = token.cancelled() => break,
                    _ = tick.tick() => {
                        emit_progress(&stats, &channel, start).await;
                    }
                }
            }
        })
    };

    // ---- Deadline watcher: cancel when duration elapses ----
    let deadline_handle = {
        let token = cancel_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep_until(deadline.into()).await;
            token.cancel();
        })
    };

    // Wait for all workers (they exit on deadline or cancel).
    for h in handles {
        let _ = h.await;
    }
    cancel_token.cancel(); // ensure progress + deadline tasks shut down
    let _ = progress_handle.await;
    let _ = deadline_handle.await;

    // One last progress emit so the UI shows the final pre-summary state.
    emit_progress(&stats, &on_event, start).await;

    // ---- Summarise ----
    let s = stats.lock().await;
    let duration_ms = start.elapsed().as_millis() as u64;
    let aggregate_tps = if duration_ms > 0 {
        (s.total_tokens as f64 * 1000.0) / duration_ms as f64
    } else {
        0.0
    };
    let mut ttfts = s.ttfts.clone();
    let mut tpots = s.tpots.clone();
    let mut tpses = s.per_req_tps.clone();
    ttfts.sort_unstable();
    tpots.sort_unstable();
    tpses.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    Ok(SummaryResult {
        completed: s.completed,
        failed: s.failed,
        total_tokens: s.total_tokens,
        duration_ms,
        aggregate_tps,
        ttft_p50_ms: percentile_u64(&ttfts, 0.50),
        ttft_p95_ms: percentile_u64(&ttfts, 0.95),
        ttft_p99_ms: percentile_u64(&ttfts, 0.99),
        tpot_p50_ms: percentile_u64(&tpots, 0.50),
        tpot_p95_ms: percentile_u64(&tpots, 0.95),
        tpot_p99_ms: percentile_u64(&tpots, 0.99),
        per_request_tps_median: percentile_f64(&tpses, 0.50),
        errors: dedup_errors(&s.errors, 20),
    })
}

async fn emit_progress(
    stats: &Arc<TokioMutex<RunningStats>>,
    channel: &Channel<ProgressEvent>,
    start: Instant,
) {
    let s = stats.lock().await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let aggregate_tps = if elapsed_ms > 0 {
        (s.total_tokens as f64 * 1000.0) / elapsed_ms as f64
    } else {
        0.0
    };
    // Sorted copies — cheap for percentiles at progress cadence (each tick is
    // 250 ms; even at 10k completed reqs this is microseconds of work).
    let mut ttfts = s.ttfts.clone();
    ttfts.sort_unstable();
    let _ = channel.send(ProgressEvent::Progress {
        elapsed_ms,
        in_flight: s.in_flight,
        completed: s.completed,
        failed: s.failed,
        aggregate_tps,
        ttft_p50_ms: percentile_u64(&ttfts, 0.50),
        ttft_p95_ms: percentile_u64(&ttfts, 0.95),
    });
}

fn record_metric(metric: RequestMetrics, s: &mut RunningStats) {
    if metric.success {
        s.completed += 1;
        s.total_tokens += metric.tokens;
        if let Some(v) = metric.ttft_ms {
            s.ttfts.push(v);
        }
        if let Some(v) = metric.tpot_ms {
            s.tpots.push(v);
        }
        if let Some(v) = metric.tps {
            s.per_req_tps.push(v);
        }
    } else {
        s.failed += 1;
        if let Some(e) = metric.error {
            s.errors.push(e);
        }
    }
}

// ---------- One streamed POST + SSE parse -------------------------------

async fn run_one_request(
    client: &reqwest::Client,
    config: &ConcurrencyConfig,
    cancel_token: &CancellationToken,
) -> RequestMetrics {
    let endpoint = format!("{}/chat/completions", config.url.trim_end_matches('/'));

    let mut messages = Vec::new();
    if !config.system_prompt.is_empty() {
        messages.push(serde_json::json!({
            "role": "system",
            "content": config.system_prompt
        }));
    }
    messages.push(serde_json::json!({
        "role": "user",
        "content": config.prompt
    }));

    let body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "temperature": config.temperature,
        "max_tokens": config.max_tokens,
        "stream": true,
        "stream_options": {"include_usage": true},
    });

    let mut req = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .json(&body);
    if !config.api_key.is_empty() {
        req = req.bearer_auth(&config.api_key);
    }

    let start = Instant::now();
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return RequestMetrics::failure(format!("Request send failed: {e}")),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet = if text.len() > 240 {
            format!("{}…", &text[..240])
        } else {
            text
        };
        return RequestMetrics::failure(format!("HTTP {status}: {snippet}"));
    }

    let stall = Duration::from_secs(config.stall_timeout_secs.max(1) as u64);
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut first_token: Option<Instant> = None;
    let mut last_token: Option<Instant> = None;
    let mut chunk_count: u64 = 0;
    let mut usage_completion: Option<u64> = None;

    loop {
        let next = tokio::select! {
            biased;
            _ = cancel_token.cancelled() => return RequestMetrics::failure("Cancelled".into()),
            _ = tokio::time::sleep(stall) => return RequestMetrics::failure(
                format!("Stream stalled (> {}s without data)", stall.as_secs()),
            ),
            n = stream.next() => n,
        };

        let bytes = match next {
            Some(Ok(b)) => b,
            Some(Err(e)) => return RequestMetrics::failure(format!("Stream read: {e}")),
            None => break,
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Drain complete SSE events; keep the trailing partial event in buffer.
        let events = drain_events(&mut buffer);
        for block in events {
            let payload = match extract_data(&block) {
                Some(p) => p,
                None => continue,
            };
            if payload == "[DONE]" {
                continue;
            }
            let data: serde_json::Value = match serde_json::from_str(&payload) {
                Ok(v) => v,
                Err(_) => continue, // malformed event — ignore
            };

            // Content delta: a single token chunk (per OpenAI shape).
            let content = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c0| c0.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !content.is_empty() {
                let now = Instant::now();
                if first_token.is_none() {
                    first_token = Some(now);
                }
                last_token = Some(now);
                chunk_count += 1;
            }

            // OpenAI-style usage block (sent in final chunk when include_usage).
            if let Some(c) = data
                .get("usage")
                .and_then(|u| u.get("completion_tokens"))
                .and_then(|v| v.as_u64())
            {
                usage_completion = Some(c);
            }
            // Ollama-specific.
            if let Some(c) = data.get("eval_count").and_then(|v| v.as_u64()) {
                usage_completion = Some(c);
            }
        }
    }

    let tokens = usage_completion.unwrap_or(chunk_count);
    let ttft_ms = first_token.map(|f| (f - start).as_millis() as u64);
    let (tpot_ms, tps) = match (first_token, last_token) {
        (Some(f), Some(l)) if tokens >= 1 => {
            let span = (l - f).as_secs_f64().max(0.001);
            let tpot = if tokens >= 2 {
                Some(((l - f).as_millis() as u64) / (tokens - 1))
            } else {
                None
            };
            let tps = tokens as f64 / span;
            (tpot, Some(tps))
        }
        _ => (None, None),
    };

    RequestMetrics {
        ttft_ms,
        tpot_ms,
        tps,
        tokens,
        success: tokens > 0,
        error: if tokens > 0 {
            None
        } else {
            Some("Empty response (0 tokens)".into())
        },
    }
}

// ---------- SSE helpers -------------------------------------------------

fn drain_events(buffer: &mut String) -> Vec<String> {
    // Normalise CR/LF; cheap as buffer is just the not-yet-dispatched tail.
    let normalised = buffer.replace("\r\n", "\n").replace('\r', "\n");
    let mut parts: Vec<&str> = normalised.split("\n\n").collect();
    // Last chunk is the (possibly incomplete) tail — preserve it.
    let tail = parts.pop().unwrap_or("").to_string();
    let events: Vec<String> = parts.iter().map(|s| s.to_string()).collect();
    *buffer = tail;
    events
}

fn extract_data(event_block: &str) -> Option<String> {
    let mut payload = String::new();
    let mut has_data = false;
    for line in event_block.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            let v = rest.strip_prefix(' ').unwrap_or(rest);
            if has_data {
                payload.push('\n');
            }
            payload.push_str(v);
            has_data = true;
        }
        // event:/id:/retry: are ignored — OpenAI-compatible streams don't use them.
    }
    if has_data {
        Some(payload)
    } else {
        None
    }
}

// ---------- Stats helpers -----------------------------------------------

fn percentile_u64(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    Some(sorted[idx.min(sorted.len() - 1)])
}

fn percentile_f64(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * p).round() as usize;
    Some(sorted[idx.min(sorted.len() - 1)])
}

fn dedup_errors(errors: &[String], max: usize) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for e in errors {
        if seen.insert(e.clone()) {
            out.push(e.clone());
            if out.len() >= max {
                break;
            }
        }
    }
    out
}
