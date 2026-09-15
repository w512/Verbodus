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
    /// Cut off mid-flight by the deadline or a user cancel. Neither a success
    /// nor a failure; `tokens` holds whatever was streamed before the cut.
    pub cancelled: bool,
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
            cancelled: false,
            error: Some(msg),
        }
    }

    fn truncated(tokens: u64, ttft_ms: Option<u64>) -> Self {
        Self {
            ttft_ms,
            tpot_ms: None,
            tps: None,
            tokens,
            success: false,
            cancelled: true,
            error: None,
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
    /// Requests still in flight when the run ended (deadline or user cancel).
    /// Not failures: their partial output is counted in `total_tokens`, and
    /// their TTFT (if the first token arrived) is included in the TTFT
    /// percentiles — dropping them would bias TTFT toward fast requests.
    /// TPOT / per-request TPS come from completed requests only.
    pub truncated: u64,
    /// True when the user stopped the run before the configured duration.
    pub cancelled: bool,
    /// Completion tokens produced inside the measurement window, including the
    /// partial output of `truncated` requests.
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

/// Distinct error messages kept for the summary. Deduplicated at insert time:
/// a dead endpoint fails in ~1 ms, and N workers over a 30 s run would
/// otherwise accumulate hundreds of thousands of identical strings.
const MAX_DISTINCT_ERRORS: usize = 20;

/// Per-worker backoff after a failed request. A failing endpoint (connection
/// refused, 5xx) would otherwise be hammered in a hot loop; back off
/// exponentially from 250 ms to 5 s and reset on the next success.
const BACKOFF_BASE: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

#[derive(Default)]
struct RunningStats {
    completed: u64,
    failed: u64,
    truncated: u64,
    total_tokens: u64,
    ttfts: Vec<u64>,
    tpots: Vec<u64>,
    per_req_tps: Vec<f64>,
    errors: Vec<String>, // distinct, capped at MAX_DISTINCT_ERRORS
    in_flight: u32,
}

fn backoff_for(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }
    let exp = consecutive_failures.saturating_sub(1).min(16);
    BACKOFF_BASE.saturating_mul(1u32 << exp).min(BACKOFF_MAX)
}

// ---------- Tauri-managed cancellation state ----------------------------

#[derive(Default)]
pub struct ConcurrencyState {
    /// User-cancel token for the run in flight. The run itself works on a
    /// *child* of this token (see `run_inner`): the deadline cancels the child
    /// only, the user cancels the parent (which propagates to the child), so at
    /// the end `parent.is_cancelled()` tells the two apart.
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
    let user_token = state.cancel.lock().unwrap().clone().unwrap();

    let result = run_inner(config, on_event, user_token).await;

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
    user_token: CancellationToken,
) -> Result<SummaryResult, String> {
    let concurrency = config.concurrency.max(1);
    let duration = Duration::from_secs(config.duration_secs.max(1) as u64);
    let start = Instant::now();
    let deadline = start + duration;

    // Everything below stops on `cancel_token`; it fires either from the
    // deadline watcher (normal end of run) or via `user_token` (user pressed
    // Cancel). Cancelling the child never cancels the parent.
    let cancel_token = user_token.child_token();

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
            let mut consecutive_failures: u32 = 0;
            while Instant::now() < deadline && !token.is_cancelled() {
                {
                    let mut s = stats.lock().await;
                    s.in_flight += 1;
                }
                // `run_one_request` is itself cancellation-aware (it races the
                // token before `send` and between every chunk) and returns a
                // *truncated* metric carrying the tokens streamed so far. We must
                // await it directly rather than `select!` it against the token:
                // racing here would drop the future on cancel and silently lose
                // every token the in-flight requests had already produced —
                // with long generations that was up to half the run's output,
                // and aggregate TPS was understated accordingly.
                let metric = run_one_request(&client, &cfg, &token).await;
                let failed = !metric.success && !metric.cancelled;
                {
                    let mut s = stats.lock().await;
                    s.in_flight = s.in_flight.saturating_sub(1);
                    record_metric(metric, &mut s);
                }

                // Back off after a failure so a dead/overloaded endpoint isn't
                // hammered in a hot loop (and so `failed` reflects a sane retry
                // cadence rather than how fast connections get refused).
                if failed {
                    consecutive_failures += 1;
                    let wait = backoff_for(consecutive_failures);
                    tokio::select! {
                        biased;
                        _ = token.cancelled() => break,
                        _ = tokio::time::sleep(wait) => {}
                    }
                } else {
                    consecutive_failures = 0;
                }
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
        truncated: s.truncated,
        cancelled: user_token.is_cancelled(),
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
        errors: s.errors.clone(),
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
    if metric.cancelled {
        // Cut off mid-stream by the deadline / user. The tokens it produced were
        // real server work inside the window, so they belong in total_tokens;
        // its TTFT (when measured) is a complete observation too. TPOT/TPS are
        // not recorded — the request never reached a natural end.
        s.truncated += 1;
        s.total_tokens += metric.tokens;
        if let Some(v) = metric.ttft_ms {
            s.ttfts.push(v);
        }
        return;
    }
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
            if s.errors.len() < MAX_DISTINCT_ERRORS && !s.errors.contains(&e) {
                s.errors.push(e);
            }
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
    // `send` resolves on response headers — under heavy queueing that alone can
    // take seconds, so it must be cancellable or Cancel would hang until the
    // server answers (or the 10-minute client timeout).
    let resp = tokio::select! {
        biased;
        _ = cancel_token.cancelled() => return RequestMetrics::truncated(0, None),
        r = req.send() => match r {
            Ok(r) => r,
            Err(e) => return RequestMetrics::failure(format!("Request send failed: {e}")),
        },
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet = truncate_chars(&text, 240);
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
            _ = cancel_token.cancelled() => {
                return RequestMetrics::truncated(
                    chunk_count,
                    first_token.map(|f| (f - start).as_millis() as u64),
                );
            }
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

            // OpenAI-style usage block (sent in the final chunk when
            // include_usage is honoured). Some servers emit `usage` with zeros
            // on intermediate chunks — a zero must not override the chunk
            // count we observed, or the request would be reported as empty.
            if let Some(c) = data
                .get("usage")
                .and_then(|u| u.get("completion_tokens"))
                .and_then(|v| v.as_u64())
                .filter(|c| *c > 0)
            {
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
        cancelled: false,
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

// Truncates to at most `max_chars` characters, appending an ellipsis if cut.
// Slicing by *byte* index (`&s[..n]`) panics when `n` lands inside a multi-byte
// UTF-8 sequence — error bodies routinely contain non-ASCII (Cyrillic, "…",
// emoji), and a panic here would silently kill the worker task.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => format!("{}…", &s[..byte_idx]),
        None => s.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_short_string_untouched() {
        assert_eq!(truncate_chars("hello", 240), "hello");
        assert_eq!(truncate_chars("", 240), "");
    }

    #[test]
    fn truncate_chars_exact_length_untouched() {
        let s = "a".repeat(240);
        assert_eq!(truncate_chars(&s, 240), s);
    }

    #[test]
    fn truncate_chars_cuts_ascii_with_ellipsis() {
        let s = "a".repeat(300);
        let t = truncate_chars(&s, 240);
        assert_eq!(t.chars().count(), 241);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn truncate_chars_does_not_panic_on_multibyte() {
        // 300 Cyrillic chars = 600 bytes; byte 240 lands mid-character for
        // the old `&s[..240]` slicing.
        let s = "ж".repeat(300);
        let t = truncate_chars(&s, 240);
        assert_eq!(t.chars().count(), 241);
        assert!(t.starts_with(&"ж".repeat(240)));
    }

    #[test]
    fn truncate_chars_handles_mixed_width() {
        let s = format!("{}{}", "é".repeat(239), "🦀🦀🦀");
        let t = truncate_chars(&s, 240);
        assert_eq!(t, format!("{}🦀…", "é".repeat(239)));
    }

    fn success_metric(tokens: u64, ttft: u64) -> RequestMetrics {
        RequestMetrics {
            ttft_ms: Some(ttft),
            tpot_ms: Some(20),
            tps: Some(50.0),
            tokens,
            success: true,
            cancelled: false,
            error: None,
        }
    }

    #[test]
    fn record_metric_truncated_counts_tokens_and_ttft_but_not_completion() {
        let mut s = RunningStats::default();
        record_metric(success_metric(100, 200), &mut s);
        record_metric(RequestMetrics::truncated(37, Some(900)), &mut s);
        record_metric(RequestMetrics::truncated(0, None), &mut s); // cut before first token

        assert_eq!(s.completed, 1);
        assert_eq!(s.failed, 0);
        assert_eq!(s.truncated, 2);
        assert_eq!(s.total_tokens, 137, "partial tokens must reach the aggregate");
        assert_eq!(s.ttfts, vec![200, 900], "measured TTFT of a cut request is a valid sample");
        assert_eq!(s.tpots.len(), 1, "no TPOT from a request that never finished");
        assert_eq!(s.per_req_tps.len(), 1);
        assert!(s.errors.is_empty(), "truncation is not an error");
    }

    #[test]
    fn record_metric_failure_is_not_truncated() {
        let mut s = RunningStats::default();
        record_metric(RequestMetrics::failure("HTTP 500".into()), &mut s);
        assert_eq!(s.failed, 1);
        assert_eq!(s.truncated, 0);
        assert_eq!(s.total_tokens, 0);
        assert_eq!(s.errors, vec!["HTTP 500".to_string()]);
    }

    #[test]
    fn record_metric_dedups_and_caps_errors_but_counts_every_failure() {
        let mut s = RunningStats::default();
        for i in 0..1000 {
            record_metric(RequestMetrics::failure(format!("err {}", i % 30)), &mut s);
        }
        assert_eq!(s.failed, 1000);
        assert_eq!(s.errors.len(), MAX_DISTINCT_ERRORS);
        assert_eq!(s.errors[0], "err 0");
        assert_eq!(s.errors[MAX_DISTINCT_ERRORS - 1], format!("err {}", MAX_DISTINCT_ERRORS - 1));
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        assert_eq!(backoff_for(0), Duration::ZERO);
        assert_eq!(backoff_for(1), Duration::from_millis(250));
        assert_eq!(backoff_for(2), Duration::from_millis(500));
        assert_eq!(backoff_for(3), Duration::from_millis(1000));
        assert_eq!(backoff_for(5), Duration::from_millis(4000));
        assert_eq!(backoff_for(6), BACKOFF_MAX);
        assert_eq!(backoff_for(40), BACKOFF_MAX, "must not overflow the shift");
    }

    #[test]
    fn user_cancel_is_distinguishable_from_deadline_via_child_token() {
        // Deadline path: cancel the child only.
        let user = CancellationToken::new();
        let run = user.child_token();
        run.cancel();
        assert!(run.is_cancelled());
        assert!(!user.is_cancelled(), "deadline must not look like a user cancel");

        // User path: cancel the parent, child follows.
        let user = CancellationToken::new();
        let run = user.child_token();
        user.cancel();
        assert!(run.is_cancelled());
        assert!(user.is_cancelled());
    }
}
