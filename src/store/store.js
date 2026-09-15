import { reactive, watch } from "vue";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
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

// Tracks the in-flight single-run benchmark so it can be cancelled (issue #4).
// Co-tenancy uses its own controllers (see `cotenancyControllers` below).
// Abort cause is read off `controller.signal.reason`, set when we call
// `controller.abort(reason)` ('user' | 'timeout' | 'peer-failed').
let activeController = null;
let cotenancyControllers = null; // { A, B } during a paired run

// History caps to keep localStorage from overflowing its ~5 MB quota (issue #8).
const MAX_RUNS = 50;          // newest runs kept in history
const MAX_CURVE_POINTS = 80;  // throughput-curve points stored per run
const MAX_COTENANCY_RUNS = 20; // newest co-tenancy sessions kept in history
const MAX_CONCURRENCY_RUNS = 20; // newest concurrency sessions kept in history

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

const storedCotenancyRuns = localStorage.getItem("speedometer_cotenancy_runs");
const initialCotenancyRuns = storedCotenancyRuns ? JSON.parse(storedCotenancyRuns) : [];

const storedConcurrencyRuns = localStorage.getItem("speedometer_concurrency_runs");
const initialConcurrencyRuns = storedConcurrencyRuns ? JSON.parse(storedConcurrencyRuns) : [];

export const store = reactive({
  // Navigation & Views
  currentView: "playground", // 'playground' | 'comparison' | 'cotenancy' | 'concurrency' | 'help'
  
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

  // Co-tenancy benchmark: measure how two LLMs degrade each other when running
  // on the same machine. Three phases (Solo A → Solo B → Paired A∥B), each run
  // `iterations` times after `warmup` discarded runs; resulting deltas are the
  // "cost of cohabitation". See `runCotenancy()`.
  cotenancy: {
    status: "idle", // idle | running | completed | error | cancelled
    phase: null,    // null | 'solo-A' | 'solo-B' | 'paired'
    phaseRun: 0,    // 1-based run number within the current phase (incl. warm-up)
    phaseTotal: 0,  // warmup + iterations of the current phase
    phaseWarmup: 0, // warm-up runs within the current phase
    profileAIndex: 0,
    profileBIndex: 1,
    prompt: "",
    iterations: 3,
    warmup: 1,
    live: { A: makeSink(), B: makeSink() }, // streamed during all phases
    result: null,   // populated on completion (see saveCotenancyToHistory)
    error: "",
  },

  // Co-tenancy session history (persisted, capped at MAX_COTENANCY_RUNS).
  cotenancyRuns: initialCotenancyRuns,

  // Concurrency benchmark: drive N parallel SSE workers (in Rust) against one
  // endpoint for a fixed duration. Measures serving throughput + per-request
  // latency distribution (p50/p95/p99). Frontend only orchestrates start/cancel;
  // the actual HTTP & timing happens on the Rust side (see src-tauri/src/concurrency.rs).
  concurrency: {
    // 'cancelled' = user stopped it early; `result` still holds the partial
    // summary (flagged `cancelled: true` by Rust) but it is not saved to history.
    status: "idle",       // idle | running | completed | error | cancelled
    profileIndex: 0,
    prompt: "",
    workers: 8,           // N concurrent in-flight requests
    durationSecs: 30,
    stallTimeoutSecs: 60,
    live: {               // streamed every ~250ms by the Rust backend
      elapsedMs: 0,
      inFlight: 0,
      completed: 0,
      failed: 0,
      aggregateTps: 0,
      ttftP50Ms: null,
      ttftP95Ms: null,
    },
    result: null,         // populated on completion (SummaryResult shape from Rust)
    error: "",
  },

  // Concurrency session history (persisted).
  concurrencyRuns: initialConcurrencyRuns,

  // True while any benchmark is in flight. Profile mutations are refused in
  // this state: the Playground series reads its config once at start, but the
  // Co-Tenancy / Concurrency views resolve profiles by index for their live
  // panels, and the history entry is attributed by profile name — switching or
  // deleting profiles mid-run would mislabel results.
  isBusy() {
    return (
      this.activeRun.status === "running" ||
      this.cotenancy.status === "running" ||
      this.concurrency.status === "running"
    );
  },

  // Actions
  selectProfile(index) {
    if (this.isBusy()) return;
    if (!this.profiles[index]) return;
    this.activeProfileIndex = index;
    this.config = withBenchDefaults(this.profiles[index]);
    // Model list is endpoint-specific — drop it so it isn't shown for a
    // profile pointing at a different server.
    this.models.list = [];
    this.models.status = "idle";
    this.models.error = "";
  },

  // Creates a new profile from the current form values. Names must be unique
  // (case-insensitively — they double as the vault key for the API key, and
  // two visually identical entries in the sidebar would be indistinguishable).
  // Returns { ok: true, index } or { ok: false, error }. Does not select it;
  // the caller decides (the sidebar does, to keep UI flow in one place).
  createProfile(rawName) {
    if (this.isBusy()) return { ok: false, error: "Wait for the running benchmark to finish." };
    const name = (rawName || "").trim();
    if (!name) return { ok: false, error: "Profile name is required." };
    const clash = this.profiles.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (clash) return { ok: false, error: `A profile named "${clash.name}" already exists.` };

    this.profiles.push({ ...this.config, name });
    persistProfiles();
    setApiKey(name, this.config.apiKey || ""); // key goes to the vault, not localStorage
    return { ok: true, index: this.profiles.length - 1 };
  },

  // Persists the current form edits back into the active profile. Called by the
  // auto-save watcher below — explicit Save/Revert UI was removed at user
  // request (the old issue #7 split was reverted: edits now flow to the active
  // profile immediately, including default presets).
  saveActiveProfile() {
    const idx = this.activeProfileIndex;
    const name = this.profiles[idx].name;
    this.profiles[idx] = { ...this.config, name };
    persistProfiles();
    setApiKey(name, this.config.apiKey || "");
  },

  deleteProfile(index) {
    if (this.isBusy()) return;
    if (this.profiles.length <= 1) return;
    if (!this.profiles[index]) return;
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

  saveCotenancyRun(run) {
    this.cotenancyRuns.unshift(run);
    if (this.cotenancyRuns.length > MAX_COTENANCY_RUNS) {
      this.cotenancyRuns.length = MAX_COTENANCY_RUNS;
    }
    persistCotenancyRuns();
  },

  deleteCotenancyRun(id) {
    this.cotenancyRuns = this.cotenancyRuns.filter((r) => r.id !== id);
    persistCotenancyRuns();
  },

  clearCotenancyRuns() {
    this.cotenancyRuns = [];
    persistCotenancyRuns();
  },

  saveConcurrencyRun(run) {
    this.concurrencyRuns.unshift(run);
    if (this.concurrencyRuns.length > MAX_CONCURRENCY_RUNS) {
      this.concurrencyRuns.length = MAX_CONCURRENCY_RUNS;
    }
    persistConcurrencyRuns();
  },

  deleteConcurrencyRun(id) {
    this.concurrencyRuns = this.concurrencyRuns.filter((r) => r.id !== id);
    persistConcurrencyRuns();
  },

  clearConcurrencyRuns() {
    this.concurrencyRuns = [];
    persistConcurrencyRuns();
  },

  resetConcurrency() {
    this.concurrency.status = "idle";
    this.concurrency.result = null;
    this.concurrency.error = "";
    this.concurrency.live = {
      elapsedMs: 0,
      inFlight: 0,
      completed: 0,
      failed: 0,
      aggregateTps: 0,
      ttftP50Ms: null,
      ttftP95Ms: null,
    };
  },

  resetCotenancy() {
    this.cotenancy.status = "idle";
    this.cotenancy.phase = null;
    this.cotenancy.phaseRun = 0;
    this.cotenancy.phaseTotal = 0;
    this.cotenancy.phaseWarmup = 0;
    this.cotenancy.result = null;
    this.cotenancy.error = "";
    resetSink(this.cotenancy.live.A);
    resetSink(this.cotenancy.live.B);
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

// Writes an in-store array to localStorage under `key`, capped at `max`. On a
// QuotaExceededError we drop the oldest half and retry until it fits — better
// than throwing and losing the whole history (issue #8). `get`/`set` are
// accessors so the last-resort `set([])` is visible through the reactive store.
function persistArray({ key, get, set, max, label }) {
  if (get().length > max) get().length = max;
  try {
    localStorage.setItem(key, JSON.stringify(get()));
    return;
  } catch (err) {
    console.error(`Failed to persist ${label}; trimming oldest entries:`, err);
  }
  while (get().length > 1) {
    get().splice(Math.ceil(get().length / 2)); // drop the older half
    try {
      localStorage.setItem(key, JSON.stringify(get()));
      return;
    } catch {
      // still too big — keep trimming
    }
  }
  // Last resort: a single entry that still won't fit — drop the lot.
  try {
    localStorage.setItem(key, JSON.stringify(get()));
  } catch {
    set([]);
    localStorage.removeItem(key);
  }
}

function persistRuns() {
  persistArray({
    key: "speedometer_runs",
    get: () => store.runs,
    set: (v) => { store.runs = v; },
    max: MAX_RUNS,
    label: "run history",
  });
}

function persistCotenancyRuns() {
  persistArray({
    key: "speedometer_cotenancy_runs",
    get: () => store.cotenancyRuns,
    set: (v) => { store.cotenancyRuns = v; },
    max: MAX_COTENANCY_RUNS,
    label: "co-tenancy history",
  });
}

function persistConcurrencyRuns() {
  persistArray({
    key: "speedometer_concurrency_runs",
    get: () => store.concurrencyRuns,
    set: (v) => { store.concurrencyRuns = v; },
    max: MAX_CONCURRENCY_RUNS,
    label: "concurrency history",
  });
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

// Auto-save: every edit in the Engine Parameters panel flows back into the
// active profile (localStorage + vault) without an explicit Save button.
// Debounced so rapid typing (e.g. API key, prompt) doesn't hammer the vault on
// every keystroke. Switching profiles reassigns `store.config` to a new object,
// which also triggers this — the resulting write is idempotent (same data back
// into the same slot) so it's harmless.
let autoSaveTimer = null;
watch(
  () => store.config,
  () => {
    if (!store.profiles[store.activeProfileIndex]) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => store.saveActiveProfile(), 250);
  },
  { deep: true }
);

// Sampling parameters from the config form. Note: `parseFloat(x) || default`
// would silently turn a legitimate `temperature: 0` (deterministic decoding —
// exactly what you want for a reproducible benchmark) into the default, because
// 0 is falsy. Only fall back when the value is genuinely missing/unparseable.
function numberOr(value, fallback) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function temperatureOf(config) {
  return Math.max(0, numberOr(config.temperature, 0.7));
}

function maxTokensOf(config) {
  const n = Math.floor(numberOr(config.maxTokens, 512));
  return n >= 1 ? n : 512;
}

// Builds the OpenAI-compatible chat/completions request from the given config.
function buildRequest(promptText, config) {
  const url = config.url.trim().replace(/\/$/, "");
  const endpoint = `${url}/chat/completions`;

  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const messages = [];
  if (config.systemPrompt) {
    messages.push({ role: "system", content: config.systemPrompt });
  }
  messages.push({ role: "user", content: promptText });

  const body = {
    model: config.model,
    messages,
    temperature: temperatureOf(config),
    max_tokens: maxTokensOf(config),
    stream: config.stream,
    stream_options: config.stream ? { include_usage: true } : undefined,
  };

  return { endpoint, headers, body };
}

// Live-telemetry shape written into during a run. Both the single-run path
// (`store.activeRun`, which embeds these fields) and the co-tenancy slots
// (`store.cotenancy.live.A` / `.live.B`) use objects of this shape.
function makeSink() {
  return {
    responseText: "",
    ttft: 0,
    tpot: 0,
    tps: 0,
    tokenCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    streamDataPoints: [],
  };
}

// Snapshot of one sink's telemetry — one element of a series.
function snapshotRun(sink) {
  return {
    ttft: sink.ttft,
    tpot: sink.tpot,
    tps: sink.tps,
    tokenCount: sink.tokenCount,
    promptTokens: sink.promptTokens,
    completionTokens: sink.completionTokens,
    totalTokens: sink.totalTokens,
    responseText: sink.responseText,
    streamDataPoints: [...sink.streamDataPoints],
  };
}

// Wipes a sink back to neutral state (no status/prompt fields — those belong
// to the caller's wrapper, e.g. `store.activeRun.status`).
function resetSink(sink) {
  sink.responseText = "";
  sink.ttft = 0;
  sink.tpot = 0;
  sink.tps = 0;
  sink.tokenCount = 0;
  sink.promptTokens = 0;
  sink.completionTokens = 0;
  sink.totalTokens = 0;
  sink.streamDataPoints = [];
}

// Executes a single high-fidelity request, updating the given `sink` (a
// makeSink()-shaped object) as it streams. Returns a snapshot of the run's
// metrics; throws on HTTP/abort errors. Abort cause is propagated via
// `controller.signal.reason` ('user' | 'timeout' | 'peer-failed'), so the
// caller can distinguish them. Does not touch series/co-tenancy/history state
// — that is the caller's job. Configurable via the passed `config` (a profile
// snapshot), so multiple runs against different endpoints can fly in parallel.
async function executeRun(promptText, config, controller, sink) {
  resetSink(sink);

  const { endpoint, headers, body } = buildRequest(promptText, config);

  const startTime = performance.now();
  let firstTokenTime = null;
  let lastTokenTime = null;
  let tokenCount = 0;

  // Inactivity timeout for this request (issue #4); aborts only THIS controller
  // (so a peer in a paired run is unaffected by one side stalling).
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort("timeout"), STALL_TIMEOUT_MS);
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

    if (!config.stream) {
      // Non-streaming Mode
      const data = await response.json();
      const totalTime = performance.now() - startTime;

      const text = data.choices?.[0]?.message?.content || "";
      const usage = data.usage || {};

      const compTokens = usage.completion_tokens || text.split(/\s+/).filter(Boolean).length || 1;
      const promptTokens = usage.prompt_tokens || promptText.split(/\s+/).filter(Boolean).length || 1;

      sink.responseText = text;
      sink.tokenCount = compTokens;
      sink.promptTokens = promptTokens;
      sink.completionTokens = compTokens;
      sink.totalTokens = promptTokens + compTokens;

      // TTFT and TPOT cannot be measured without streaming — the response
      // arrives as a single blob, so prefill and decode are indistinguishable.
      // Report them as unavailable (null -> "--") rather than fabricating a split.
      sink.ttft = null;
      sink.tpot = null;
      // Aggregate throughput over the whole request is still meaningful
      sink.tps = parseFloat((compTokens / (totalTime / 1000)).toFixed(2));
      sink.streamDataPoints = [
        { time: 0, tps: 0 },
        { time: totalTime / 1000, tps: sink.tps },
      ];
      return snapshotRun(sink);
    }

    // Streaming Mode — proper SSE parsing per W3C EventSource spec:
    //   - Lines may end in \r\n, \r, or \n.
    //   - Events are separated by a blank line (one or more line terminators in
    //     a row, i.e. >=2 consecutive terminators).
    //   - Within an event: lines starting with ':' are comments; multiple
    //     `data:` lines accumulate (joined by '\n') into one payload; one
    //     optional leading space after the colon is stripped. We ignore
    //     `event:`, `id:`, `retry:` — irrelevant for OpenAI-compatible streams.
    const EVENT_SEP = /(?:\r\n|\r|\n){2,}/;
    const LINE_SEP = /\r\n|\r|\n/;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      armStall(); // bytes arrived — reset the inactivity timer
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(EVENT_SEP);
      buffer = events.pop(); // keep tail (possibly incomplete event) for next chunk

      for (const block of events) {
        let payload = null;
        for (const line of block.split(LINE_SEP)) {
          if (!line || line.startsWith(":")) continue; // empty / comment
          if (line.startsWith("data:")) {
            let v = line.slice(5);
            if (v.startsWith(" ")) v = v.slice(1); // strip single leading space (spec)
            payload = payload == null ? v : payload + "\n" + v;
          }
          // Ignore event: / id: / retry: — unused for OpenAI-compatible streams.
        }
        if (payload == null) continue;
        if (payload === "[DONE]") continue;

        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue; // partial / malformed payload — skip
        }

        // 1. Extract content delta
        const content = data.choices?.[0]?.delta?.content || "";

        // 2. Extract metrics if available (e.g. usage statistics)
        if (data.usage) {
          sink.promptTokens = data.usage.prompt_tokens;
          sink.completionTokens = data.usage.completion_tokens;
          sink.totalTokens = data.usage.total_tokens;
        }

        // 3. Extract custom engine specifics (e.g., Ollama metadata)
        if (data.prompt_eval_count || data.eval_count) {
          sink.promptTokens = data.prompt_eval_count || sink.promptTokens;
          sink.completionTokens = data.eval_count || sink.completionTokens;
          sink.totalTokens = (data.prompt_eval_count || 0) + (data.eval_count || 0);
        }

        if (content) {
          const now = performance.now();
          if (firstTokenTime === null) {
            firstTokenTime = now;
            sink.ttft = Math.round(firstTokenTime - startTime);
          }

          sink.responseText += content;
          tokenCount++;
          sink.tokenCount = tokenCount;
          lastTokenTime = now;

          // Calculate current active TPS
          const elapsedSecs = (now - firstTokenTime) / 1000;
          if (elapsedSecs > 0) {
            const currentTps = parseFloat((tokenCount / elapsedSecs).toFixed(2));
            sink.tps = currentTps;
            sink.streamDataPoints.push({
              time: parseFloat(elapsedSecs.toFixed(2)),
              tps: currentTps,
            });
          }
        }
      }
    }

    // Done reading stream
    const finalTime = performance.now();

    // Prefer the server-reported completion token count for accuracy.
    // The chunk count (tokenCount) is only a fallback: one SSE chunk is not
    // guaranteed to equal one token, so it would skew TPS/TPOT.
    const usageTokens = sink.completionTokens || 0;
    const tokensForMetrics = usageTokens > 0 ? usageTokens : tokenCount;

    // Finalize TTFT / TPOT / TPS using the most accurate token count available
    if (firstTokenTime !== null && lastTokenTime !== null && tokensForMetrics > 0) {
      // TPOT = average time per decoded token. The span first→last token covers
      // (N-1) inter-token intervals, not N, and the very first token belongs to
      // prefill (TTFT), so it is excluded from the decode average. Dividing by N
      // would understate TPOT (issue #10). With <2 tokens there is no interval to
      // measure, so TPOT is undefined.
      sink.tpot =
        tokensForMetrics > 1
          ? Math.round((lastTokenTime - firstTokenTime) / (tokensForMetrics - 1))
          : null;
      const totalTimeSecs = (finalTime - firstTokenTime) / 1000;
      sink.tps = parseFloat((tokensForMetrics / (totalTimeSecs || 0.001)).toFixed(2));

      // Reconcile the live throughput curve with the finalized TPS. During the
      // stream every curve point was computed from the SSE chunk counter, but
      // one chunk ≠ one token; the headline TPS uses server-reported
      // `usage.completion_tokens` (when present). Without this rescale the saved
      // curve would sit on a different scale from the number on the metric card
      // and from historical Comparison runs. We rescale only when usage tokens
      // were actually reported (otherwise scale == 1 and this is a no-op).
      if (usageTokens > 0 && tokenCount > 0 && usageTokens !== tokenCount) {
        const scale = usageTokens / tokenCount;
        for (const pt of sink.streamDataPoints) {
          pt.tps = parseFloat((pt.tps * scale).toFixed(2));
        }
      }
    }

    // Default calculations if usage stats not provided
    if (!sink.promptTokens) {
      sink.promptTokens = promptText.split(/\s+/).filter(Boolean).length;
    }
    if (!sink.completionTokens) {
      sink.completionTokens = tokenCount;
    }
    // Keep the audited token count consistent with the metrics source
    sink.tokenCount = tokensForMetrics;
    sink.totalTokens = sink.promptTokens + sink.completionTokens;

    return snapshotRun(sink);
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

  // Snapshot the config and the profile it belongs to. Every iteration of the
  // series must hit the same endpoint with the same parameters, and the history
  // entry must be attributed to the profile that was active when the run
  // started — not to whatever is selected by the time it finishes. (Profile
  // switching is also blocked while busy, see `store.isBusy()`; this is the
  // belt to that suspenders.)
  const config = { ...store.config };
  const profileName = store.profiles[store.activeProfileIndex]?.name ?? "";

  const iterations = Math.max(1, parseInt(config.iterations) || 1);
  const warmup = Math.max(0, parseInt(config.warmup) || 0);
  const total = iterations + warmup;

  // Shared controller so a single cancel/timeout aborts the whole series.
  const controller = new AbortController();
  activeController = controller;

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
      const result = await executeRun(promptText, config, controller, store.activeRun);
      if (i >= warmup) {
        measured.push(result);
        store.series.kept = measured.length;
      }
    }

    store.series.agg = aggregate(measured);
    store.series.status = "completed";
    store.activeRun.status = "completed";
    saveSeriesToHistory(promptText, measured, store.series.agg, config, profileName);
  } catch (err) {
    const reason = controller.signal.reason;
    if (reason === "user") {
      // Keep any partial output; this was a deliberate stop, not a failure.
      store.activeRun.status = "cancelled";
      store.series.status = "cancelled";
      store.activeRun.error = "Benchmark cancelled.";
    } else if (reason === "timeout") {
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
    activeController.abort("user");
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
// throughput curve come from the last measured run. `config`/`profileName`
// are the snapshot taken when the series started (see runBenchmark).
function saveSeriesToHistory(promptText, measured, agg, config, profileName) {
  if (measured.length === 0) return;
  const last = measured[measured.length - 1];
  const medianOf = (stat, decimals) =>
    stat == null ? null : decimals ? parseFloat(stat.median.toFixed(decimals)) : Math.round(stat.median);

  const newRun = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    configName: profileName,
    modelName: config.model,
    url: config.url,
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

// --- Co-tenancy benchmark -------------------------------------------------
//
// Measures how two LLMs degrade each other when sharing one machine.
// Sequential phases (solo A → solo B → paired A∥B) prevent paired runs from
// thermally pre-warming the GPU before baselines — that order would deflate
// solos and inflate the headline delta.

// Runs `warmup + iterations` of `executeRun(config)` into `sink`, keeping the
// measured snapshots. Updates phase progress on `store.cotenancy` so the UI
// can render "run i/N". Throws if the controller is aborted or an HTTP error
// surfaces — orchestrator handles the catch.
async function runPhase(phaseId, config, sink, controller) {
  const ct = store.cotenancy;
  ct.phase = phaseId;
  ct.phaseTotal = ct.warmup + ct.iterations;
  ct.phaseWarmup = ct.warmup;
  ct.phaseRun = 0;

  const measured = [];
  for (let i = 0; i < ct.phaseTotal; i++) {
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    ct.phaseRun = i + 1;
    const result = await executeRun(ct.prompt, config, controller, sink);
    if (i >= ct.warmup) measured.push(result);
  }
  return aggregate(measured);
}

// Δ = (paired − solo) / solo. Positive means worse for latency metrics
// (TTFT/TPOT), negative means worse for throughput (TPS). Returns null when
// either side is missing (e.g. TTFT/TPOT in non-streaming mode).
function computeDelta(solo, paired) {
  const ratio = (s, p) =>
    s == null || p == null || s.median === 0 ? null : (p.median - s.median) / s.median;
  return {
    ttft: ratio(solo.ttft, paired.ttft),
    tpot: ratio(solo.tpot, paired.tpot),
    tps: ratio(solo.tps, paired.tps),
  };
}

export async function runCotenancy() {
  const ct = store.cotenancy;
  const profA = store.profiles[ct.profileAIndex];
  const profB = store.profiles[ct.profileBIndex];
  if (!profA || !profB) {
    ct.status = "error";
    ct.error = "Select profiles A and B before running.";
    return;
  }
  if (!ct.prompt.trim()) {
    ct.status = "error";
    ct.error = "Prompt is required.";
    return;
  }
  // Snapshot the configs so user edits during the run don't leak in mid-test.
  const configA = { ...profA };
  const configB = { ...profB };

  store.resetCotenancy();
  ct.status = "running";
  ct.iterations = Math.max(1, parseInt(ct.iterations) || 1);
  ct.warmup = Math.max(0, parseInt(ct.warmup) || 0);

  const ctrlA = new AbortController();
  const ctrlB = new AbortController();
  cotenancyControllers = { A: ctrlA, B: ctrlB };

  try {
    // ---- Phase 1: Solo A ----
    const soloA = await runPhase("solo-A", configA, ct.live.A, ctrlA);

    // ---- Phase 2: Solo B ----
    if (ctrlA.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const soloB = await runPhase("solo-B", configB, ct.live.B, ctrlB);

    // ---- Phase 3: Paired A∥B ----
    if (ctrlA.signal.aborted || ctrlB.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    ct.phase = "paired";
    ct.phaseTotal = ct.warmup + ct.iterations;
    ct.phaseWarmup = ct.warmup;
    ct.phaseRun = 0;

    const pairedA = [];
    const pairedB = [];
    for (let i = 0; i < ct.phaseTotal; i++) {
      if (ctrlA.signal.aborted || ctrlB.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      ct.phaseRun = i + 1;

      // Wire each side to abort its peer on failure so we don't waste tokens
      // on a half-paired run. Note: this fires only on hard errors / timeouts,
      // not on normal completion.
      const runA = executeRun(ct.prompt, configA, ctrlA, ct.live.A).catch((err) => {
        if (!ctrlB.signal.aborted) ctrlB.abort("peer-failed");
        throw err;
      });
      const runB = executeRun(ct.prompt, configB, ctrlB, ct.live.B).catch((err) => {
        if (!ctrlA.signal.aborted) ctrlA.abort("peer-failed");
        throw err;
      });
      const [resA, resB] = await Promise.all([runA, runB]);
      if (i >= ct.warmup) {
        pairedA.push(resA);
        pairedB.push(resB);
      }
    }
    const pairAgg = { A: aggregate(pairedA), B: aggregate(pairedB) };

    // ---- Finalize ----
    ct.result = {
      solo: { A: soloA, B: soloB },
      paired: pairAgg,
      delta: { A: computeDelta(soloA, pairAgg.A), B: computeDelta(soloB, pairAgg.B) },
    };
    ct.status = "completed";
    saveCotenancyToHistory(configA, configB);
  } catch (err) {
    const userCancelled =
      ctrlA.signal.reason === "user" || ctrlB.signal.reason === "user";
    const timedOut =
      ctrlA.signal.reason === "timeout" || ctrlB.signal.reason === "timeout";
    if (userCancelled) {
      ct.status = "cancelled";
      ct.error = "Co-tenancy test cancelled.";
    } else if (timedOut) {
      ct.status = "error";
      ct.error = `One endpoint went idle longer than ${STALL_TIMEOUT_MS / 1000}s.`;
    } else {
      ct.status = "error";
      ct.error = err?.message || String(err);
    }
    console.error("Co-tenancy error:", err);
  } finally {
    cotenancyControllers = null;
  }
}

export function cancelCotenancy() {
  if (cotenancyControllers) {
    cotenancyControllers.A.abort("user");
    cotenancyControllers.B.abort("user");
  }
}

// --- Concurrency benchmark -----------------------------------------------
//
// Thin orchestration over the Rust `run_concurrency_benchmark` command. The
// actual N parallel SSE workers run in tokio on the Rust side; we just pass
// the config, subscribe to a Channel for live progress updates, and store the
// final SummaryResult. Web preview (`bun dev`, no Tauri) cannot run this and
// shows an error.
export async function runConcurrency() {
  const c = store.concurrency;
  const profile = store.profiles[c.profileIndex];
  if (!profile) {
    c.status = "error";
    c.error = "Select a profile first.";
    return;
  }
  if (!c.prompt.trim()) {
    c.status = "error";
    c.error = "Prompt is required.";
    return;
  }
  if (!isTauri()) {
    c.status = "error";
    c.error = "Concurrency mode needs the desktop app (Rust backend).";
    return;
  }

  store.resetConcurrency();
  c.status = "running";

  const config = {
    url: (profile.url || "").trim().replace(/\/$/, ""),
    apiKey: profile.apiKey || "",
    model: profile.model || "",
    systemPrompt: profile.systemPrompt || "",
    temperature: temperatureOf(profile),
    maxTokens: maxTokensOf(profile),
    prompt: c.prompt,
    concurrency: Math.max(1, parseInt(c.workers) || 1),
    durationSecs: Math.max(1, parseInt(c.durationSecs) || 30),
    stallTimeoutSecs: Math.max(1, parseInt(c.stallTimeoutSecs) || 60),
  };

  // Channel<ProgressEvent> — Rust pushes ~4 events/sec while running.
  const channel = new Channel();
  channel.onmessage = (event) => {
    if (event?.type === "progress") {
      c.live.elapsedMs = event.elapsedMs;
      c.live.inFlight = event.inFlight;
      c.live.completed = event.completed;
      c.live.failed = event.failed;
      c.live.aggregateTps = event.aggregateTps;
      c.live.ttftP50Ms = event.ttftP50Ms;
      c.live.ttftP95Ms = event.ttftP95Ms;
    }
  };

  try {
    const summary = await invoke("run_concurrency_benchmark", {
      config,
      onEvent: channel,
    });
    c.result = summary;
    if (summary?.cancelled) {
      // Stopped by the user before the configured duration. Keep the partial
      // summary on screen for inspection, but don't persist it: a truncated
      // window isn't comparable with the full-duration sessions in history.
      c.status = "cancelled";
    } else {
      c.status = "completed";
      saveConcurrencyToHistory(profile, config);
    }
  } catch (err) {
    // Both the deadline and a user cancel end the Rust command cleanly with a
    // summary (see `cancelled` above). If we land here it's a real error —
    // the invoke itself threw (re-entry, bad config, HTTP client build).
    c.status = "error";
    c.error = typeof err === "string" ? err : err?.message || String(err);
    console.error("Concurrency benchmark error:", err);
  }
}

export async function cancelConcurrency() {
  if (!isTauri()) return;
  try {
    await invoke("cancel_concurrency_benchmark");
  } catch (err) {
    console.error("Failed to send cancel:", err);
  }
}

function saveConcurrencyToHistory(profile, config) {
  const c = store.concurrency;
  if (!c.result) return;
  store.saveConcurrencyRun({
    id:
      (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    profileName: profile.name,
    modelName: config.model,
    url: config.url,
    prompt: c.prompt,
    workers: config.concurrency,
    durationSecs: config.durationSecs,
    result: c.result,
  });
}

function saveCotenancyToHistory(configA, configB) {
  const ct = store.cotenancy;
  if (!ct.result) return;
  store.saveCotenancyRun({
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    iterations: ct.iterations,
    warmup: ct.warmup,
    prompt: ct.prompt,
    A: {
      profileName: configA.name,
      modelName: configA.model,
      url: configA.url,
    },
    B: {
      profileName: configB.name,
      modelName: configB.model,
      url: configB.url,
    },
    result: ct.result,
  });
}
