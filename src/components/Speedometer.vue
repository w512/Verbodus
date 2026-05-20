<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { store, runBenchmark } from "../store/store.js";
import ConfigPanel from "./ConfigPanel.vue";
import SpeedChart from "./SpeedChart.vue";

const promptText = ref("Explain quantum computing in three clear sentences.");
const responseContainer = ref(null);

const QUICK_PROMPTS = [
  { label: "Quantum Intro", text: "Explain quantum computing in three clear sentences." },
  { label: "JS String Reverse", text: "Write a JavaScript function to reverse a string, with brief comments." },
  { label: "SQL vs NoSQL", text: "List 4 key structural differences between SQL databases and NoSQL databases." },
  { label: "Rust Parsing", text: "Write a short Rust snippet illustrating how to serialize and deserialize JSON using Serde." }
];

function selectQuickPrompt(text) {
  promptText.value = text;
}

async function startTest() {
  if (!promptText.value.trim() || store.activeRun.status === "running") return;
  await runBenchmark(promptText.value.trim());
}

// Auto-scroll response panel to the bottom during generation
watch(
  () => store.activeRun.responseText,
  () => {
    nextTick(() => {
      if (responseContainer.value) {
        responseContainer.value.scrollTop = responseContainer.value.scrollHeight;
      }
    });
  }
);

// Performance color-coding helper functions
function getTtftClass(val) {
  if (!val) return "";
  if (val < 250) return "stat-excellent";
  if (val < 800) return "stat-good";
  return "stat-slow";
}

function getTpsClass(val) {
  if (!val) return "";
  if (val > 45) return "stat-excellent";
  if (val > 15) return "stat-good";
  return "stat-slow";
}

function getTpotClass(val) {
  if (!val) return "";
  if (val < 22) return "stat-excellent";
  if (val < 66) return "stat-good";
  return "stat-slow";
}
</script>

<template>
  <div class="playground-layout">
    <!-- Main Workbench Area -->
    <div class="workbench">
      <header class="workbench-header">
        <div>
          <h2>⚡ Performance Playground</h2>
          <p class="model-badge">Active Engine: <span>{{ store.config.model }}</span> ({{ store.config.url }})</p>
        </div>
        <button 
          class="btn btn-primary" 
          :disabled="store.activeRun.status === 'running' || !promptText.trim()"
          @click="startTest"
        >
          <span v-if="store.activeRun.status === 'running'" class="spinner"></span>
          {{ store.activeRun.status === 'running' ? 'Benchmarking...' : 'Run Verbodus' }}
        </button>
      </header>

      <div class="workbench-grid">
        <!-- Prompts & Text Outputs -->
        <div class="text-sections">
          <!-- Prompt Input Card -->
          <div class="card glass-card prompt-card">
            <div class="card-header">
              <span class="title">PROMPT INPUT</span>
              <div class="quick-prompts">
                <button 
                  v-for="p in QUICK_PROMPTS" 
                  :key="p.label"
                  class="btn btn-secondary btn-xs"
                  @click="selectQuickPrompt(p.text)"
                  :disabled="store.activeRun.status === 'running'"
                >
                  {{ p.label }}
                </button>
              </div>
            </div>
            <textarea 
              v-model="promptText"
              placeholder="Enter your prompt here..."
              rows="3"
              :disabled="store.activeRun.status === 'running'"
            ></textarea>
          </div>

          <!-- Response Output Card -->
          <div class="card glass-card response-card">
            <div class="card-header">
              <span class="title">STREAMING OUTPUT</span>
              <span v-if="store.activeRun.status === 'running'" class="status-pill running">GENERATE STREAM</span>
              <span v-else-if="store.activeRun.status === 'completed'" class="status-pill completed">COMPLETED</span>
              <span v-else-if="store.activeRun.status === 'error'" class="status-pill error">ERROR</span>
            </div>
            <div 
              ref="responseContainer"
              class="response-box scroller"
              :class="{ placeholder: !store.activeRun.responseText && store.activeRun.status === 'idle' }"
            >
              <pre v-if="store.activeRun.responseText">{{ store.activeRun.responseText }}<span v-if="store.activeRun.status === 'running'" class="caret"></span></pre>
              <p v-else-if="store.activeRun.status === 'running'" class="loading-text">Starting generation...</p>
              <p v-else-if="store.activeRun.status === 'error'" class="error-text">{{ store.activeRun.error }}</p>
              <p v-else>The engine response will render here in real time...</p>
            </div>
          </div>
        </div>

        <!-- Metrics Dashboard & Charts -->
        <div class="dashboard-sections">
          <!-- Metrics Grid -->
          <div class="metrics-grid">
            <!-- TTFT Card -->
            <div class="metric-card glass-card">
              <span class="metric-label">TTFT (Prefill Latency)</span>
              <span class="metric-val" :class="getTtftClass(store.activeRun.ttft)">
                {{ store.activeRun.ttft ? `${store.activeRun.ttft} ms` : '--' }}
              </span>
              <span class="metric-desc">Time to first token</span>
            </div>

            <!-- TPOT Card -->
            <div class="metric-card glass-card">
              <span class="metric-label">TPOT (Decode Latency)</span>
              <span class="metric-val" :class="getTpotClass(store.activeRun.tpot)">
                {{ store.activeRun.tpot ? `${store.activeRun.tpot} ms` : '--' }}
              </span>
              <span class="metric-desc">Time per output token</span>
            </div>

            <!-- TPS Card -->
            <div class="metric-card glass-card">
              <span class="metric-label">Generation Speed</span>
              <span class="metric-val" :class="getTpsClass(store.activeRun.tps)">
                {{ store.activeRun.tps ? `${store.activeRun.tps} tps` : '--' }}
              </span>
              <span class="metric-desc">Tokens per second</span>
            </div>

            <!-- Token Counts -->
            <div class="metric-card glass-card">
              <span class="metric-label">Token Auditing</span>
              <span class="metric-val stat-normal">
                {{ store.activeRun.tokenCount || '--' }}
              </span>
              <span class="metric-desc">
                P: {{ store.activeRun.promptTokens }} | C: {{ store.activeRun.completionTokens }}
              </span>
            </div>
          </div>

          <!-- Chart Card -->
          <div class="card glass-card chart-card-container">
            <div class="card-header">
              <span class="title">REAL-TIME THROUGHPUT CURVE</span>
            </div>
            <div class="chart-box">
              <SpeedChart :dataPoints="store.activeRun.streamDataPoints" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Right Side Parameters Panel -->
    <div class="parameters-sidebar">
      <ConfigPanel />
    </div>
  </div>
</template>

<style scoped>
.playground-layout {
  display: flex;
  height: 100vh;
  width: 100%;
  overflow: hidden;
}

.workbench {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
  min-width: 0;
}

.workbench-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.workbench-header h2 {
  font-size: 22px;
  color: var(--text-primary);
}

.model-badge {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.model-badge span {
  color: var(--accent-cyan);
  font-weight: 600;
}

.workbench-grid {
  display: grid;
  grid-template-columns: 1.1fr 0.9fr;
  gap: 24px;
  flex: 1;
  min-height: 0;
}

.text-sections {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
}

.dashboard-sections {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
}

.parameters-sidebar {
  width: 320px;
  height: 100vh;
  padding: 24px 24px 24px 0;
}

/* Cards Design */
.card {
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  padding: 16px 20px;
}

.prompt-card {
  flex-shrink: 0;
}

.response-card {
  flex: 1;
  min-height: 250px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.card-header .title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

.quick-prompts {
  display: flex;
  gap: 6px;
}

.btn-xs {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 6px;
}

textarea {
  resize: none;
}

.response-box {
  flex: 1;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.6;
}

.response-box.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-style: italic;
}

.response-box pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--text-primary);
  user-select: text;
}

.caret {
  display: inline-block;
  width: 6px;
  height: 14px;
  background-color: var(--accent-cyan);
  margin-left: 4px;
  animation: blink 0.8s infinite;
  vertical-align: middle;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

.status-pill {
  padding: 3px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.status-pill.running {
  background-color: var(--color-warning-bg);
  color: var(--color-warning);
  border: 1px solid rgba(245, 158, 11, 0.2);
}

.status-pill.completed {
  background-color: var(--color-success-bg);
  color: var(--color-success);
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.status-pill.error {
  background-color: var(--color-danger-bg);
  color: var(--color-danger);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.loading-text {
  color: var(--text-secondary);
  font-style: italic;
}

.error-text {
  color: var(--color-danger);
}

/* Metrics Dashboards */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}

.metric-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-radius: 10px;
}

.metric-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
}

.metric-val {
  font-family: 'Outfit', sans-serif;
  font-size: 24px;
  font-weight: 700;
}

.metric-desc {
  font-size: 11px;
  color: var(--text-secondary);
}

/* Stat color code classes */
.stat-excellent {
  color: var(--color-success);
  text-shadow: 0 0 10px rgba(16, 185, 129, 0.2);
}

.stat-good {
  color: var(--color-warning);
  text-shadow: 0 0 10px rgba(245, 158, 11, 0.2);
}

.stat-slow {
  color: var(--color-danger);
  text-shadow: 0 0 10px rgba(239, 68, 68, 0.2);
}

.stat-normal {
  color: var(--text-primary);
}

/* Chart Container styling */
.chart-card-container {
  flex: 1;
  min-height: 280px;
}

.chart-box {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
}

/* Spinner indicator */
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
