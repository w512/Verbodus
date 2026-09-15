<script setup>
import { computed } from "vue";
import { store, runConcurrency, cancelConcurrency } from "../store/store.js";
import { ttftClass, tpotClass, tpsClass } from "../store/metrics.js";
import { confirmDialog } from "../store/dialog.js";

const c = store.concurrency;
const isRunning = computed(() => c.status === "running");

const progressPct = computed(() => {
  const total = c.durationSecs * 1000;
  if (total <= 0) return 0;
  return Math.min(100, (c.live.elapsedMs / total) * 100);
});

const successRate = computed(() => {
  const done = c.live.completed + c.live.failed;
  if (done === 0) return null;
  return (c.live.completed / done) * 100;
});

const finalSuccessRate = computed(() => {
  if (!c.result) return null;
  const done = c.result.completed + c.result.failed;
  if (done === 0) return null;
  return (c.result.completed / done) * 100;
});

function start() {
  if (isRunning.value) return;
  runConcurrency();
}

async function clearHistory() {
  const ok = await confirmDialog({
    title: "Clear concurrency history",
    message: "Wipe all saved concurrency sessions? This cannot be undone.",
    confirmText: "Clear",
    danger: true,
  });
  if (ok) store.clearConcurrencyRuns();
}

async function deleteSession(id) {
  const ok = await confirmDialog({
    title: "Delete session",
    message: "Delete this session from history?",
    confirmText: "Delete",
    danger: true,
  });
  if (ok) store.deleteConcurrencyRun(id);
}

// Formatters
const fmtMs = (v) => (v == null ? "—" : Math.round(v) + " ms");
const fmtNum = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const fmtPct = (v) => (v == null ? "—" : v.toFixed(1) + "%");
const fmtSecs = (ms) => (ms / 1000).toFixed(1) + " s";
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
</script>

<template>
  <div class="conc-layout">
    <div class="main-content">
      <header class="view-header">
        <div>
          <h2>⚡ Concurrency Test</h2>
          <p class="desc">
            Drives <strong>N parallel SSE workers</strong> against one endpoint for a
            fixed duration. Reports aggregate throughput, request rate, and the
            <strong>p50/p95/p99 latency distribution</strong> — what serving engines
            (vLLM, Triton, Ollama under load) actually need to be judged on.
            The work runs natively in Rust (no JS event-loop jitter).
          </p>
        </div>
        <div class="header-actions">
          <span v-if="isRunning" class="phase-tag">
            {{ fmtSecs(c.live.elapsedMs) }} / {{ c.durationSecs }} s ·
            in-flight {{ c.live.inFlight }}
          </span>
          <button v-if="!isRunning" class="btn btn-primary" :disabled="!c.prompt.trim()" @click="start">
            Run Concurrency
          </button>
          <button v-else class="btn btn-danger" @click="cancelConcurrency">
            <span class="spinner"></span> Cancel
          </button>
        </div>
      </header>

      <!-- Setup -->
      <div class="card glass-card setup-card">
        <div class="setup-grid">
          <div class="form-row wide">
            <label>Profile</label>
            <select v-model.number="c.profileIndex" :disabled="isRunning">
              <option v-for="(p, idx) in store.profiles" :key="idx" :value="idx">
                {{ p.name }} — {{ p.model }}
              </option>
            </select>
          </div>
          <div class="form-row narrow">
            <label>Workers (N)</label>
            <input v-model.number="c.workers" type="number" min="1" max="128" :disabled="isRunning" />
          </div>
          <div class="form-row narrow">
            <label>Duration (s)</label>
            <input v-model.number="c.durationSecs" type="number" min="1" max="3600" :disabled="isRunning" />
          </div>
          <div class="form-row narrow">
            <label>Stall TO (s)</label>
            <input v-model.number="c.stallTimeoutSecs" type="number" min="1" max="600" :disabled="isRunning" />
          </div>
        </div>
        <div class="form-row">
          <label>Prompt (sent on every request)</label>
          <textarea
            v-model="c.prompt"
            rows="2"
            placeholder="A prompt that triggers a non-trivial generation — short prompts skew percentile data."
            :disabled="isRunning"
          ></textarea>
        </div>
        <p class="note muted">
          ⓘ N workers start at once and keep firing new requests until the duration
          ends or a single request stalls past the stall timeout. The headline
          number is <strong>aggregate TPS</strong> — sum of all completion tokens
          across the wall-clock duration. Watch p95/p99 TTFT — that's where queue
          buildup shows up first.
        </p>
      </div>

      <!-- Live progress -->
      <div class="card glass-card live-card" v-if="isRunning || c.live.elapsedMs > 0">
        <div class="card-header">
          <span class="title">Live</span>
          <span class="muted" v-if="successRate != null">{{ fmtPct(successRate) }} success</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="live-grid">
          <div class="live-cell">
            <span class="live-label">Completed</span>
            <span class="live-val">{{ c.live.completed }}</span>
          </div>
          <div class="live-cell">
            <span class="live-label">Failed</span>
            <span class="live-val" :class="{ 'stat-slow': c.live.failed > 0 }">{{ c.live.failed }}</span>
          </div>
          <div class="live-cell">
            <span class="live-label">In-flight</span>
            <span class="live-val">{{ c.live.inFlight }}</span>
          </div>
          <div class="live-cell">
            <span class="live-label">Aggregate TPS</span>
            <span class="live-val" :class="tpsClass(c.live.aggregateTps)">
              {{ fmtNum(c.live.aggregateTps) }}
            </span>
          </div>
          <div class="live-cell">
            <span class="live-label">TTFT p50</span>
            <span class="live-val" :class="ttftClass(c.live.ttftP50Ms)">
              {{ fmtMs(c.live.ttftP50Ms) }}
            </span>
          </div>
          <div class="live-cell">
            <span class="live-label">TTFT p95</span>
            <span class="live-val" :class="ttftClass(c.live.ttftP95Ms)">
              {{ fmtMs(c.live.ttftP95Ms) }}
            </span>
          </div>
        </div>
      </div>

      <!-- Error / cancelled status -->
      <div v-if="c.status === 'error'" class="card glass-card error-card">
        <strong>❌ Error:</strong> {{ c.error }}
      </div>
      <div v-else-if="c.status === 'cancelled'" class="card glass-card cancel-card">
        <strong>⏹ Cancelled.</strong>
      </div>

      <!-- Result -->
      <div v-if="c.result" class="card glass-card result-card">
        <div class="card-header">
          <span class="title">Result</span>
          <span class="muted">
            {{ c.result.completed }} ok · {{ c.result.failed }} failed
            ({{ fmtPct(finalSuccessRate) }} success) over {{ fmtSecs(c.result.durationMs) }}
          </span>
        </div>
        <div class="result-headline">
          <div class="headline-cell">
            <span class="headline-label">Aggregate TPS</span>
            <span class="headline-val" :class="tpsClass(c.result.aggregateTps)">
              {{ fmtNum(c.result.aggregateTps) }}
            </span>
            <span class="headline-sub">total tokens / wall-time</span>
          </div>
          <div class="headline-cell">
            <span class="headline-label">Req / s</span>
            <span class="headline-val">
              {{ fmtNum((c.result.completed * 1000) / Math.max(c.result.durationMs, 1)) }}
            </span>
            <span class="headline-sub">successful requests / wall-time</span>
          </div>
          <div class="headline-cell">
            <span class="headline-label">Median per-req TPS</span>
            <span class="headline-val">{{ fmtNum(c.result.perRequestTpsMedian) }}</span>
            <span class="headline-sub">what one user feels</span>
          </div>
        </div>

        <table class="result-table">
          <thead>
            <tr><th>Metric</th><th>p50</th><th>p95</th><th>p99</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>TTFT</strong></td>
              <td :class="ttftClass(c.result.ttftP50Ms)">{{ fmtMs(c.result.ttftP50Ms) }}</td>
              <td :class="ttftClass(c.result.ttftP95Ms)">{{ fmtMs(c.result.ttftP95Ms) }}</td>
              <td :class="ttftClass(c.result.ttftP99Ms)">{{ fmtMs(c.result.ttftP99Ms) }}</td>
            </tr>
            <tr>
              <td><strong>TPOT</strong></td>
              <td :class="tpotClass(c.result.tpotP50Ms)">{{ fmtMs(c.result.tpotP50Ms) }}</td>
              <td :class="tpotClass(c.result.tpotP95Ms)">{{ fmtMs(c.result.tpotP95Ms) }}</td>
              <td :class="tpotClass(c.result.tpotP99Ms)">{{ fmtMs(c.result.tpotP99Ms) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="c.result.errors && c.result.errors.length" class="errors-block">
          <strong>Distinct errors:</strong>
          <ul>
            <li v-for="(e, idx) in c.result.errors" :key="idx"><code>{{ e }}</code></li>
          </ul>
        </div>
      </div>

      <!-- History -->
      <div v-if="store.concurrencyRuns.length" class="card glass-card history-card">
        <div class="card-header">
          <span class="title">Saved sessions ({{ store.concurrencyRuns.length }})</span>
          <button class="btn btn-secondary btn-sm" @click="clearHistory">🗑️ Clear</button>
        </div>
        <div class="sessions-list scroller">
          <div v-for="s in store.concurrencyRuns" :key="s.id" class="session-row">
            <div class="session-head">
              <span class="session-model">
                <strong>{{ s.modelName }}</strong>
                <span class="muted">({{ s.profileName }})</span>
              </span>
              <span class="session-meta">
                N={{ s.workers }} · {{ s.durationSecs }}s · {{ fmtDate(s.timestamp) }}
              </span>
              <button class="delete-row-btn" aria-label="Delete" @click="deleteSession(s.id)">×</button>
            </div>
            <div class="session-stats">
              <span :class="tpsClass(s.result.aggregateTps)">agg {{ fmtNum(s.result.aggregateTps) }} tps</span>
              <span class="sep">·</span>
              <span :class="ttftClass(s.result.ttftP50Ms)">p50 {{ fmtMs(s.result.ttftP50Ms) }}</span>
              <span :class="ttftClass(s.result.ttftP95Ms)">p95 {{ fmtMs(s.result.ttftP95Ms) }}</span>
              <span class="sep">·</span>
              <span class="muted">{{ s.result.completed }} ok / {{ s.result.failed }} fail</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conc-layout {
  display: flex;
  height: 100vh;
  width: 100%;
  overflow: hidden;
}
.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
  min-width: 0;
  gap: 16px;
}
.view-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.view-header h2 { font-size: 22px; color: var(--text-primary); }
.desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
  max-width: 680px;
  line-height: 1.5;
}
.header-actions { display: flex; align-items: center; gap: 14px; }
.phase-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.card { border-radius: 12px; padding: 16px 20px; }
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
.muted { color: var(--text-muted); font-size: 11px; }

/* Setup */
.setup-grid {
  display: grid;
  grid-template-columns: 1fr 120px 120px 120px;
  gap: 14px;
  margin-bottom: 14px;
}
.form-row label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.note {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 10px;
  color: var(--text-muted);
  background: var(--surface-1);
}

/* Live */
.progress-bar {
  height: 4px;
  background: var(--surface-1);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 12px;
}
.progress-fill {
  height: 100%;
  background: var(--accent-gradient);
  transition: width 0.3s ease;
}
.live-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}
.live-cell {
  padding: 10px 12px;
  background: var(--surface-1);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.live-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
}
.live-val {
  font-family: 'Outfit', sans-serif;
  font-size: 18px;
  font-weight: 700;
}

/* Result */
.result-headline {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 18px;
}
.headline-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: var(--surface-1);
  border-radius: 10px;
}
.headline-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.headline-val {
  font-family: 'Outfit', sans-serif;
  font-size: 28px;
  font-weight: 700;
}
.headline-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.result-table th, .result-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
}
.result-table th {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.result-table tbody tr:last-child td { border-bottom: none; }

.errors-block {
  margin-top: 14px;
  padding: 10px 14px;
  background: var(--color-danger-bg);
  border-radius: 8px;
  border-left: 3px solid var(--color-danger);
  font-size: 12px;
}
.errors-block ul {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--text-secondary);
}
.errors-block code {
  background: rgba(110, 118, 129, 0.2);
  color: var(--text-primary);
  padding: 0.1em 0.4em;
  border-radius: 4px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.9em;
}

/* Status cards */
.error-card { color: var(--color-danger); background: var(--color-danger-bg); border: 1px solid var(--color-danger); }
.cancel-card { color: var(--text-secondary); border: 1px solid var(--border-color); }

/* Sessions */
.sessions-list { display: flex; flex-direction: column; gap: 8px; max-height: 280px; overflow-y: auto; }
.session-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--surface-1);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.session-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.session-model { font-size: 12px; color: var(--text-primary); }
.session-meta { font-size: 10px; color: var(--text-muted); margin-left: auto; font-variant-numeric: tabular-nums; }
.session-stats { font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
.session-stats .sep { color: var(--text-muted); }
.delete-row-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  opacity: 0.6;
  padding: 0 4px;
}
.delete-row-btn:hover { color: var(--color-danger); opacity: 1; }

.btn-sm { padding: 4px 8px; font-size: 11px; border-radius: 4px; }

/* Cancel button */
.btn-danger {
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
}
.btn-danger:hover { filter: brightness(1.2); }
.btn-danger .spinner { border-top-color: var(--color-danger); }
.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
