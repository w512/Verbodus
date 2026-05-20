import { reactive } from "vue";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@tauri-apps/api/core";
import { getApiKey, setApiKey, deleteApiKey } from "./secrets.js";

// Issue #5: route HTTP through the Rust stack when running inside Tauri. This
// bypasses the WebView's CORS restrictions (so remote OpenAI-compatible APIs
// actually work) and lets us keep a real CSP. Fall back to the browser fetch
// for the `bun dev` web-only preview, where the Tauri runtime is absent.
const httpFetch = isTauri() ? tauriFetch : globalThis.fetch.bind(globalThis);

// Inactivity window: abort a benchmark if no bytes arrive within this many ms.
// A stall timer (reset on every chunk) is more useful than a fixed total
// timeout, since legitimate long generations keep streaming.
const STALL_TIMEOUT_MS = 60000;

// Tracks the in-flight request so it can be cancelled (issue #4).
let activeController = null;
let abortKind = null; // 'user' | 'timeout' | null

// History caps to keep localStorage from overflowing its ~5 MB quota (issue #8).
const MAX_RUNS = 50;          // newest runs kept in history
const MAX_CURVE_POINTS = 80;  // throughput-curve points stored per run

// Default configuration presets
const DEFAULT_PRESETS = [
  {
    name: "Ollama (Default)",
    url: "http://localhost:11434/v1",
    apiKey: "",
    model: "llama3",
    temperature: 0.7,
    maxTokens: 512,
    systemPrompt: "You are a helpful assistant.",
    stream: true,
    iterations: 1, // benchmark runs to average (issue #3)
    warmup: 0,     // leading runs discarded (cold-start) before averaging
  },
  {
    name: "LM Studio (Default)",
    url: "http://localhost:1234/v1",
    apiKey: "",
    model: "lmstudio-community",
    temperature: 0.7,
    maxTokens: 512,
    systemPrompt: "You are a helpful assistant.",
    stream: true,
    iterations: 1, // benchmark runs to average (issue #3)
    warmup: 0,     // leading runs discarded (cold-start) before averaging
  },
  {
    name: "vLLM / Local Engine",
    url: "http://localhost:8000/v1",
    apiKey: "",
    model: "meta-llama/Meta-Llama-3-8B-Instruct",
    temperature: 0.7,
    maxTokens: 512,
    systemPrompt: "You are a helpful assistant.",
    stream: true,
    iterations: 1,
    warmup: 0,
  }
];

// Older saved profiles may predate the iterations/warmup fields — backfill them.
function withBenchDefaults(profile) {
  return { iterations: 1, warmup: 0, ...profile };
}

// Load saved data from localStorage
const storedProfiles = localStorage.getItem("speedometer_profiles");
const initialProfiles = storedProfiles ? JSON.parse(storedProfiles) : DEFAULT_PRESETS;

const storedRuns = localStorage.getItem("speedometer_runs");
const initialRuns = storedRuns ? JSON.parse(storedRuns) : [];

export const store = reactive({
  // Navigation & Views
  currentView: "playground", // 'playground' | 'comparison' | 'settings'
  
  // Configurations & Profiles
  profiles: initialProfiles,
  activeProfileIndex: 0,
  
  // Active Configuration form values
  config: withBenchDefaults(initialProfiles[0]),

  // Benchmarked runs history
  runs: initialRuns,

  // Active run telemetry
  activeRun: {
    status: "idle", // 'idle' | 'running' | 'completed' | 'error' | 'cancelled'
    prompt: "",
    responseText: "",
    ttft: 0, // ms
    tpot: 0, // ms
    tps: 0,  // tokens/sec
    tokenCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    streamDataPoints: [], // array of { time: s, tps: val }
    error: ""
  },

  // Multi-run series telemetry (issue #3). When total === 1 this stays inert
  // and the UI shows the single live run as before.
  series: {
    status: "idle",   // 'idle' | 'running' | 'completed' | 'error' | 'cancelled'
    total: 1,         // warmup + measured runs
    warmup: 0,        // leading runs discarded
    current: 0,       // 1-based index of the in-flight run
    kept: 0,          // number of measured (non-warmup) runs collected
    agg: null,        // { ttft, tpot, tps } each { median, min, max } | null
  },

  // Models advertised by the active endpoint's GET /models (OpenAI-compatible).
  models: {
    status: "idle", // 'idle' | 'loading' | 'loaded' | 'error'
    list: [],       // array of model id strings
    error: "",
  },

  // Actions
  selectProfile(index) {
    this.activeProfileIndex = index;
    this.config = withBenchDefaults(this.profiles[index]);
    // Model list is endpoint-specific — drop it so it isn't shown for a
    // profile pointing at a different server.
    this.models.list = [];
    this.models.status = "idle";
    this.models.error = "";
  },

  saveProfile(name) {
    const existingIndex = this.profiles.findIndex(p => p.name === name);
    const newProfile = { ...this.config, name };
    if (existingIndex >= 0) {
      this.profiles[existingIndex] = newProfile;
    } else {
      this.profiles.push(newProfile);
    }
    persistProfiles();
    setApiKey(name, this.config.apiKey || ""); // key goes to the vault, not localStorage
  },

  // Persists the current form edits back into the active profile (issue #7 —
  // edits no longer auto-overwrite the saved preset; this is the explicit save).
  saveActiveProfile() {
    const idx = this.activeProfileIndex;
    const name = this.profiles[idx].name;
    this.profiles[idx] = { ...this.config, name };
    persistProfiles();
    setApiKey(name, this.config.apiKey || "");
  },

  // Discards unsaved form edits, restoring the active profile's saved values.
  revertActiveProfile() {
    this.config = withBenchDefaults(this.profiles[this.activeProfileIndex]);
  },

  // True when the form differs from the saved profile (drives the Save/Revert UI).
  isDirty() {
    const saved = this.profiles[this.activeProfileIndex];
    if (!saved) return false;
    const keys = ["url", "apiKey", "model", "temperature", "maxTokens", "systemPrompt", "stream", "iterations", "warmup"];
    return keys.some((k) => (this.config[k] ?? "") !== (saved[k] ?? ""));
  },

  deleteProfile(index) {
    if (this.profiles.length <= 1) return;
    const name = this.profiles[index].name;
    this.profiles.splice(index, 1);
    this.activeProfileIndex = Math.min(this.activeProfileIndex, this.profiles.length - 1);
    this.config = withBenchDefaults(this.profiles[this.activeProfileIndex]);
    persistProfiles();
    deleteApiKey(name);
  },

  saveRun(run) {
    // Downsample the throughput curve before storing — the live chart uses
    // activeRun, so the per-token history copy is only dead weight (issue #8).
    if (run.streamDataPoints) run.streamDataPoints = downsampleCurve(run.streamDataPoints);
    this.runs.unshift(run);
    if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
    persistRuns();
  },

  deleteRun(id) {
    this.runs = this.runs.filter(r => r.id !== id);
    persistRuns();
  },

  clearRuns() {
    this.runs = [];
    persistRuns();
  },

  resetActiveRun() {
    this.activeRun.status = "idle";
    this.activeRun.prompt = "";
    this.activeRun.responseText = "";
    this.activeRun.ttft = 0;
    this.activeRun.tpot = 0;
    this.activeRun.tps = 0;
    this.activeRun.tokenCount = 0;
    this.activeRun.promptTokens = 0;
    this.activeRun.completionTokens = 0;
    this.activeRun.totalTokens = 0;
    this.activeRun.streamDataPoints = [];
    this.activeRun.error = "";
  }
});

// Persists profiles to localStorage WITHOUT the apiKey (issue #6 — keys live in
// the encrypted vault, never in plaintext localStorage).
function persistProfiles() {
  const sanitized = store.profiles.map(({ apiKey, ...rest }) => rest);
  localStorage.setItem("speedometer_profiles", JSON.stringify(sanitized));
}

// Evenly thins a throughput curve down to MAX_CURVE_POINTS, always keeping the
// last point so the tail of the curve is preserved (issue #8).
function downsampleCurve(points) {
  if (!Array.isArray(points) || points.length <= MAX_CURVE_POINTS) return points || [];
  const step = points.length / MAX_CURVE_POINTS;
  const out = [];
  for (let i = 0; i < MAX_CURVE_POINTS; i++) out.push(points[Math.floor(i * step)]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// Persists run history with quota handling: on a QuotaExceededError, drop the
// oldest half and retry until it fits, rather than throwing and losing data.
function persistRuns() {
  if (store.runs.length > MAX_RUNS) store.runs.length = MAX_RUNS;
  try {
    localStorage.setItem("speedometer_runs", JSON.stringify(store.runs));
  } catch (err) {
    console.error("Failed to persist run history; trimming oldest entries:", err);
    while (store.runs.length > 1) {
      store.runs.splice(Math.ceil(store.runs.length / 2)); // drop the older half
      try {
        localStorage.setItem("speedometer_runs", JSON.stringify(store.runs));
        return;
      } catch {
        // still too big — keep trimming
      }
    }
    // Last resort: a single run that still won't fit — drop history entirely.
    try {
      localStorage.setItem("speedometer_runs", JSON.stringify(store.runs));
    } catch {
      store.runs = [];
      localStorage.removeItem("speedometer_runs");
    }
  }
}

// On startup, reconcile each profile's key with secure storage: migrate any
// legacy plaintext key (from older localStorage) into the vault, otherwise load
// the key from the vault into memory. Finally strip keys from localStorage.
async function initSecrets() {
  for (const profile of store.profiles) {
    if (profile.apiKey) {
      await setApiKey(profile.name, profile.apiKey); // migrate legacy plaintext key
    } else {
      const key = await getApiKey(profile.name);
      if (key) profile.apiKey = key;
    }
  }
  const active = store.profiles[store.activeProfileIndex];
  if (active) store.config.apiKey = active.apiKey || "";
  persistProfiles(); // ensure no plaintext keys remain in localStorage
}

initSecrets();

// Builds the OpenAI-compatible chat/completions request from the active config.
function buildRequest(promptText) {
  const url = store.config.url.trim().replace(/\/$/, "");
  const endpoint = `${url}/chat/completions`;

  const headers = { "Content-Type": "application/json" };
  if (store.config.apiKey) {
    headers["Authorization"] = `Bearer ${store.config.apiKey}`;
  }

  const messages = [];
  if (store.config.systemPrompt) {
    messages.push({ role: "system", content: store.config.systemPrompt });
  }
  messages.push({ role: "user", content: promptText });

  const body = {
    model: store.config.model,
    messages,
    temperature: parseFloat(store.config.temperature) || 0.7,
    max_tokens: parseInt(store.config.maxTokens) || 512,
    stream: store.config.stream,
    stream_options: store.config.stream ? { include_usage: true } : undefined,
  };

  return { endpoint, headers, body };
}

// Snapshot of the live telemetry — one element of a series.
function snapshotRun() {
  return {
    ttft: store.activeRun.ttft,
    tpot: store.activeRun.tpot,
    tps: store.activeRun.tps,
    tokenCount: store.activeRun.tokenCount,
    promptTokens: store.activeRun.promptTokens,
    completionTokens: store.activeRun.completionTokens,
    totalTokens: store.activeRun.totalTokens,
    responseText: store.activeRun.responseText,
    streamDataPoints: [...store.activeRun.streamDataPoints],
  };
}

// Executes a single high-fidelity request, updating the live telemetry as it
// streams. Returns a snapshot of the run's metrics; throws on HTTP/abort errors
// (the orchestrator decides how to surface them). Does not touch series state
// or history — that is the caller's job.
async function executeRun(promptText, controller) {
  // Reset only the per-run live fields, leaving status/error/prompt to the caller.
  store.activeRun.responseText = "";
  store.activeRun.ttft = 0;
  store.activeRun.tpot = 0;
  store.activeRun.tps = 0;
  store.activeRun.tokenCount = 0;
  store.activeRun.promptTokens = 0;
  store.activeRun.completionTokens = 0;
  store.activeRun.totalTokens = 0;
  store.activeRun.streamDataPoints = [];

  const { endpoint, headers, body } = buildRequest(promptText);

  const startTime = performance.now();
  let firstTokenTime = null;
  let lastTokenTime = null;
  let tokenCount = 0;

  // Inactivity timeout for this request (issue #4); aborts the shared controller.
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      abortKind = "timeout";
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    armStall();
    const response = await httpFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Error (${response.status}): ${errText || response.statusText}`);
    }

    if (!store.config.stream) {
      // Non-streaming Mode
      const data = await response.json();
      const totalTime = performance.now() - startTime;

      const text = data.choices?.[0]?.message?.content || "";
      const usage = data.usage || {};

      const compTokens = usage.completion_tokens || text.split(/\s+/).filter(Boolean).length || 1;
      const promptTokens = usage.prompt_tokens || promptText.split(/\s+/).filter(Boolean).length || 1;

      store.activeRun.responseText = text;
      store.activeRun.tokenCount = compTokens;
      store.activeRun.promptTokens = promptTokens;
      store.activeRun.completionTokens = compTokens;
      store.activeRun.totalTokens = promptTokens + compTokens;

      // TTFT and TPOT cannot be measured without streaming — the response
      // arrives as a single blob, so prefill and decode are indistinguishable.
      // Report them as unavailable (null -> "--") rather than fabricating a split.
      store.activeRun.ttft = null;
      store.activeRun.tpot = null;
      // Aggregate throughput over the whole request is still meaningful
      store.activeRun.tps = parseFloat((compTokens / (totalTime / 1000)).toFixed(2));
      store.activeRun.streamDataPoints = [
        { time: 0, tps: 0 },
        { time: totalTime / 1000, tps: store.activeRun.tps },
      ];
      return snapshotRun();
    }

    // Streaming Mode
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      armStall(); // bytes arrived — reset the inactivity timer
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") continue;

        if (trimmed.startsWith("data: ")) {
          try {
            const rawJson = trimmed.slice(6);
            const data = JSON.parse(rawJson);

            // 1. Extract content delta
            const content = data.choices?.[0]?.delta?.content || "";

            // 2. Extract metrics if available (e.g. usage statistics)
            if (data.usage) {
              store.activeRun.promptTokens = data.usage.prompt_tokens;
              store.activeRun.completionTokens = data.usage.completion_tokens;
              store.activeRun.totalTokens = data.usage.total_tokens;
            }

            // 3. Extract custom engine specifics (e.g., Ollama metadata)
            if (data.prompt_eval_count || data.eval_count) {
              store.activeRun.promptTokens = data.prompt_eval_count || store.activeRun.promptTokens;
              store.activeRun.completionTokens = data.eval_count || store.activeRun.completionTokens;
              store.activeRun.totalTokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);
            }

            if (content) {
              const now = performance.now();
              if (firstTokenTime === null) {
                firstTokenTime = now;
                store.activeRun.ttft = Math.round(firstTokenTime - startTime);
              }

              store.activeRun.responseText += content;
              tokenCount++;
              store.activeRun.tokenCount = tokenCount;
              lastTokenTime = now;

              // Calculate current active TPS
              const elapsedSecs = (now - firstTokenTime) / 1000;
              if (elapsedSecs > 0) {
                const currentTps = parseFloat((tokenCount / elapsedSecs).toFixed(2));
                store.activeRun.tps = currentTps;
                store.activeRun.streamDataPoints.push({
                  time: parseFloat(elapsedSecs.toFixed(2)),
                  tps: currentTps,
                });
              }
            }
          } catch (e) {
            // Ignore JSON parsing errors for partial or malformed chunks
          }
        }
      }
    }

    // Done reading stream
    const finalTime = performance.now();

    // Prefer the server-reported completion token count for accuracy.
    // The chunk count (tokenCount) is only a fallback: one SSE chunk is not
    // guaranteed to equal one token, so it would skew TPS/TPOT.
    const usageTokens = store.activeRun.completionTokens || 0;
    const tokensForMetrics = usageTokens > 0 ? usageTokens : tokenCount;

    // Finalize TTFT / TPOT / TPS using the most accurate token count available
    if (firstTokenTime !== null && lastTokenTime !== null && tokensForMetrics > 0) {
      store.activeRun.tpot = Math.round((lastTokenTime - firstTokenTime) / tokensForMetrics);
      const totalTimeSecs = (finalTime - firstTokenTime) / 1000;
      store.activeRun.tps = parseFloat((tokensForMetrics / (totalTimeSecs || 0.001)).toFixed(2));
    }

    // Default calculations if usage stats not provided
    if (!store.activeRun.promptTokens) {
      store.activeRun.promptTokens = promptText.split(/\s+/).filter(Boolean).length;
    }
    if (!store.activeRun.completionTokens) {
      store.activeRun.completionTokens = tokenCount;
    }
    // Keep the audited token count consistent with the metrics source
    store.activeRun.tokenCount = tokensForMetrics;
    store.activeRun.totalTokens = store.activeRun.promptTokens + store.activeRun.completionTokens;

    return snapshotRun();
  } finally {
    clearTimeout(stallTimer);
  }
}

// Orchestrates a benchmark series: `warmup` discarded runs followed by
// `iterations` measured runs, then aggregates the measured ones (issue #3).
// With iterations=1/warmup=0 this is a single run, exactly as before.
export async function runBenchmark(promptText) {
  store.resetActiveRun();
  store.activeRun.status = "running";
  store.activeRun.prompt = promptText;

  const iterations = Math.max(1, parseInt(store.config.iterations) || 1);
  const warmup = Math.max(0, parseInt(store.config.warmup) || 0);
  const total = iterations + warmup;

  // Shared controller so a single cancel/timeout aborts the whole series.
  const controller = new AbortController();
  activeController = controller;
  abortKind = null;

  store.series.status = "running";
  store.series.total = total;
  store.series.warmup = warmup;
  store.series.current = 0;
  store.series.kept = 0;
  store.series.agg = null;

  const measured = [];
  try {
    for (let i = 0; i < total; i++) {
      store.series.current = i + 1;
      const result = await executeRun(promptText, controller);
      if (i >= warmup) {
        measured.push(result);
        store.series.kept = measured.length;
      }
    }

    store.series.agg = aggregate(measured);
    store.series.status = "completed";
    store.activeRun.status = "completed";
    saveSeriesToHistory(promptText, measured, store.series.agg);
  } catch (err) {
    const aborted = abortKind || err.name === "AbortError";
    if (aborted && abortKind === "user") {
      // Keep any partial output; this was a deliberate stop, not a failure.
      store.activeRun.status = "cancelled";
      store.series.status = "cancelled";
      store.activeRun.error = "Benchmark cancelled.";
    } else if (aborted) {
      store.activeRun.status = "error";
      store.series.status = "error";
      store.activeRun.error = `Request timed out after ${STALL_TIMEOUT_MS / 1000}s with no response.`;
    } else {
      store.activeRun.status = "error";
      store.series.status = "error";
      store.activeRun.error = err.message;
    }
    console.error("Benchmark error:", err);
  } finally {
    activeController = null;
  }
}

// Abort the in-flight benchmark/series, if any (issue #4).
export function cancelBenchmark() {
  if (activeController) {
    abortKind = "user";
    activeController.abort();
  }
}

// Fetches the model catalogue from the active endpoint's GET /models
// (OpenAI-compatible: Ollama, LM Studio, vLLM, cloud APIs all expose it).
export async function fetchModels() {
  store.models.status = "loading";
  store.models.error = "";
  store.models.list = [];

  const url = store.config.url.trim().replace(/\/$/, "");
  const headers = {};
  if (store.config.apiKey) {
    headers["Authorization"] = `Bearer ${store.config.apiKey}`;
  }

  try {
    const response = await httpFetch(`${url}/models`, { method: "GET", headers });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
    }
    const data = await response.json();
    // OpenAI shape is { data: [{ id }] }; fall back to a bare array just in case.
    const raw = Array.isArray(data) ? data : data?.data || [];
    const ids = raw
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    store.models.list = ids;
    store.models.status = "loaded";
  } catch (err) {
    store.models.status = "error";
    store.models.error = err.message;
    console.error("Failed to fetch models:", err);
  }
}

// --- Aggregation helpers (issue #3) ---

function median(sortedNums) {
  const n = sortedNums.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedNums[mid] : (sortedNums[mid - 1] + sortedNums[mid]) / 2;
}

// Per-metric { median, min, max } over the measured runs. Returns null for a
// metric when no run reported it (e.g. TTFT/TPOT in non-streaming mode).
function aggregate(runs) {
  const statsFor = (key) => {
    const vals = runs.map((r) => r[key]).filter((v) => typeof v === "number");
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    return { median: median(sorted), min: sorted[0], max: sorted[sorted.length - 1] };
  };
  return { ttft: statsFor("ttft"), tpot: statsFor("tpot"), tps: statsFor("tps") };
}

// Saves one aggregated entry per series. The displayed ttft/tpot/tps use the
// median (so the Comparison view contrasts medians); the response text and
// throughput curve come from the last measured run.
function saveSeriesToHistory(promptText, measured, agg) {
  if (measured.length === 0) return;
  const last = measured[measured.length - 1];
  const medianOf = (stat, decimals) =>
    stat == null ? null : decimals ? parseFloat(stat.median.toFixed(decimals)) : Math.round(stat.median);

  const newRun = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    configName: store.profiles[store.activeProfileIndex].name,
    modelName: store.config.model,
    url: store.config.url,
    prompt: promptText,
    responseText: last.responseText,
    ttft: medianOf(agg.ttft, 0),
    tpot: medianOf(agg.tpot, 0),
    tps: medianOf(agg.tps, 2) ?? 0,
    tokenCount: last.tokenCount,
    promptTokens: last.promptTokens,
    completionTokens: last.completionTokens,
    totalTokens: last.totalTokens,
    streamDataPoints: [...last.streamDataPoints],
    iterations: measured.length, // number of measured runs averaged
    agg,                         // full { median, min, max } per metric
  };
  store.saveRun(newRun);
}
