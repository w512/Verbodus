import { reactive, watch } from "vue";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "@tauri-apps/api/core";

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
  }
];

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
  config: { ...initialProfiles[0] },

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

  // Actions
  selectProfile(index) {
    this.activeProfileIndex = index;
    this.config = { ...this.profiles[index] };
  },

  saveProfile(name) {
    const existingIndex = this.profiles.findIndex(p => p.name === name);
    const newProfile = { ...this.config, name };
    if (existingIndex >= 0) {
      this.profiles[existingIndex] = newProfile;
    } else {
      this.profiles.push(newProfile);
    }
    localStorage.setItem("speedometer_profiles", JSON.stringify(this.profiles));
  },

  deleteProfile(index) {
    if (this.profiles.length <= 1) return;
    this.profiles.splice(index, 1);
    this.activeProfileIndex = Math.min(this.activeProfileIndex, this.profiles.length - 1);
    this.config = { ...this.profiles[this.activeProfileIndex] };
    localStorage.setItem("speedometer_profiles", JSON.stringify(this.profiles));
  },

  saveRun(run) {
    this.runs.unshift(run);
    localStorage.setItem("speedometer_runs", JSON.stringify(this.runs));
  },

  deleteRun(id) {
    this.runs = this.runs.filter(r => r.id !== id);
    localStorage.setItem("speedometer_runs", JSON.stringify(this.runs));
  },

  clearRuns() {
    this.runs = [];
    localStorage.setItem("speedometer_runs", JSON.stringify([]));
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

// Watch config changes to update the profiles array in memory
watch(
  () => store.config,
  (newVal) => {
    store.profiles[store.activeProfileIndex] = { ...newVal };
    localStorage.setItem("speedometer_profiles", JSON.stringify(store.profiles));
  },
  { deep: true }
);

// High-fidelity SSE Benchmarking stream consumer
export async function runBenchmark(promptText) {
  store.resetActiveRun();
  store.activeRun.status = "running";
  store.activeRun.prompt = promptText;

  const url = store.config.url.trim().replace(/\/$/, "");
  const endpoint = `${url}/chat/completions`;
  const apiKey = store.config.apiKey;

  const headers = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
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
    stream_options: store.config.stream ? { include_usage: true } : undefined
  };

  const startTime = performance.now();
  let firstTokenTime = null;
  let lastTokenTime = null;
  let tokenCount = 0;

  // Set up cancellation + inactivity timeout (issue #4)
  const controller = new AbortController();
  activeController = controller;
  abortKind = null;

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
      const endTime = performance.now();
      const totalTime = endTime - startTime;
      
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
        { time: totalTime / 1000, tps: store.activeRun.tps }
      ];
      store.activeRun.status = "completed";
      
      // Save Run to History
      saveActiveRunToHistory();
      return;
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
                  tps: currentTps
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
    store.activeRun.status = "completed";

    // Save Run to History
    saveActiveRunToHistory();

  } catch (err) {
    const aborted = abortKind || err.name === "AbortError";
    if (aborted && abortKind === "user") {
      // Keep any partial output; this was a deliberate stop, not a failure.
      store.activeRun.status = "cancelled";
      store.activeRun.error = "Benchmark cancelled.";
    } else if (aborted) {
      store.activeRun.status = "error";
      store.activeRun.error = `Request timed out after ${STALL_TIMEOUT_MS / 1000}s with no response.`;
    } else {
      store.activeRun.status = "error";
      store.activeRun.error = err.message;
    }
    console.error("Benchmark error:", err);
  } finally {
    clearTimeout(stallTimer);
    activeController = null;
  }
}

// Abort the in-flight benchmark, if any (issue #4).
export function cancelBenchmark() {
  if (activeController) {
    abortKind = "user";
    activeController.abort();
  }
}

function saveActiveRunToHistory() {
  const newRun = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    configName: store.profiles[store.activeProfileIndex].name,
    modelName: store.config.model,
    url: store.config.url,
    prompt: store.activeRun.prompt,
    responseText: store.activeRun.responseText,
    ttft: store.activeRun.ttft,
    tpot: store.activeRun.tpot,
    tps: store.activeRun.tps,
    tokenCount: store.activeRun.tokenCount,
    promptTokens: store.activeRun.promptTokens,
    completionTokens: store.activeRun.completionTokens,
    totalTokens: store.activeRun.totalTokens,
    streamDataPoints: [...store.activeRun.streamDataPoints]
  };
  store.saveRun(newRun);
}
