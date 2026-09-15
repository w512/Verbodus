<script setup>
import { computed } from "vue";
import { store, runCotenancy, cancelCotenancy } from "../store/store.js";
import { ttftClass, tpotClass, tpsClass } from "../store/metrics.js";
import { confirmDialog } from "../store/dialog.js";

const ct = store.cotenancy;

const isRunning = computed(() => ct.status === "running");

const phaseLabel = computed(() => {
  switch (ct.phase) {
    case "solo-A": return "Phase 1/3 · Solo A (baseline)";
    case "solo-B": return "Phase 2/3 · Solo B (baseline)";
    case "paired": return "Phase 3/3 · Paired A∥B";
    default: return "";
  }
});

const isWarmupRun = computed(() => ct.phaseRun > 0 && ct.phaseRun <= ct.phaseWarmup);

// Same host warning: co-tenancy delta is meaningful only when both endpoints
// share hardware. If hosts differ, the delta will reflect network/event-loop
// noise rather than GPU contention — we surface that, but don't block.
const hostsDiffer = computed(() => {
  try {
    const a = store.profiles[ct.profileAIndex]?.url;
    const b = store.profiles[ct.profileBIndex]?.url;
    if (!a || !b) return false;
    return new URL(a).host !== new URL(b).host;
  } catch {
    return false;
  }
});

function start() {
  if (isRunning.value) return;
  runCotenancy();
}

async function clearHistory() {
  const ok = await confirmDialog({
    title: "Clear co-tenancy history",
    message: "Wipe all saved co-tenancy sessions? This cannot be undone.",
    confirmText: "Clear",
    danger: true,
  });
  if (ok) store.clearCotenancyRuns();
}

async function deleteSession(id) {
  const ok = await confirmDialog({
    title: "Delete session",
    message: "Delete this co-tenancy session from history?",
    confirmText: "Delete",
    danger: true,
  });
  if (ok) store.deleteCotenancyRun(id);
}

// Format helpers
const fmtMs = (v) => (v == null ? "--" : Math.round(v) + " ms");
const fmtTps = (v) => (v == null ? "--" : v.toFixed(2));
const fmtDelta = (v) => {
  if (v == null) return "--";
  const pct = (v * 100).toFixed(1);
  return (v >= 0 ? "+" : "") + pct + "%";
};
// Coloring: latency delta worse when positive; TPS delta worse when negative.
function deltaClass(value, kind /* 'latency' | 'tps' */) {
  if (value == null) return "";
  const worse = kind === "latency" ? value > 0.05 : value < -0.05;
  const better = kind === "latency" ? value < -0.05 : value > 0.05;
  if (worse) return "stat-slow";
  if (better) return "stat-excellent";
  return "stat-good";
}
function classForLive(metric, val) {
  if (metric === "ttft") return ttftClass(val);
  if (metric === "tpot") return tpotClass(val);
  return tpsClass(val);
}
const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};
</script>

<template>
  <div class="cotenancy-layout">
    <div class="main-content">
      <header class="view-header">
        <div>
          <h2>🧪 Co-Tenancy Test</h2>
          <p class="desc">
            Measures how two LLMs running on the same machine degrade each other.
            Phases: <strong>Solo A → Solo B → Paired A∥B</strong>. The Δ% column is the
            "cost of cohabitation".
          </p>
        </div>
        <div class="header-actions">
          <span v-if="isRunning" class="phase-tag">
            {{ phaseLabel }} · run {{ ct.phaseRun }}/{{ ct.phaseTotal }}
            <span v-if="isWarmupRun" class="warmup-tag">warm-up</span>
          </span>
          <button v-if="!isRunning" class="btn btn-primary" :disabled="!ct.prompt.trim()" @click="start">
            Run Co-Tenancy
          </button>
          <button v-else class="btn btn-danger" @click="cancelCotenancy">
            <span class="spinner"></span> Cancel
          </button>
        </div>
      </header>

      <!-- Setup form -->
      <div class="card glass-card setup-card">
        <div class="setup-grid">
          <div class="form-row">
            <label>Profile A</label>
            <select v-model.number="ct.profileAIndex" :disabled="isRunning">
              <option v-for="(p, idx) in store.profiles" :key="`a-${idx}`" :value="idx">
                {{ p.name }} — {{ p.model }}
              </option>
            </select>
          </div>
          <div class="form-row">
            <label>Profile B</label>
            <select v-model.number="ct.profileBIndex" :disabled="isRunning">
              <option v-for="(p, idx) in store.profiles" :key="`b-${idx}`" :value="idx">
                {{ p.name }} — {{ p.model }}
              </option>
            </select>
          </div>
          <div class="form-row narrow">
            <label>Iterations</label>
            <input v-model.number="ct.iterations" type="number" min="1" max="50" :disabled="isRunning" />
          </div>
          <div class="form-row narrow">
            <label>Warm-up</label>
            <input v-model.number="ct.warmup" type="number" min="0" max="10" :disabled="isRunning" />
          </div>
        </div>
        <div class="form-row">
          <label>Prompt (sent to both endpoints)</label>
          <textarea
            v-model="ct.prompt"
            rows="2"
            placeholder="A prompt long enough that both models actually generate something meaningful…"
            :disabled="isRunning"
          ></textarea>
        </div>
        <div class="notes">
          <p v-if="ct.profileAIndex === ct.profileBIndex" class="note">
            ⓘ Profiles A and B are the same — you're measuring pure contention of the
            model with a second copy of itself.
          </p>
          <p v-if="hostsDiffer" class="note warn">
            ⚠️ Endpoints A and B are on different hosts. Deltas will reflect network /
            event-loop noise rather than shared-hardware contention.
          </p>
          <p class="note muted">
            ⓘ Paired-mode TPOT inherits ~few ms of jitter from the JS event loop (two
            SSE streams share one thread). Negligible on local models, noticeable on
            very fast cloud endpoints (Groq etc.).
          </p>
        </div>
      </div>

      <!-- Live panels -->
      <div class="live-grid">
        <div
          v-for="side in ['A', 'B']"
          :key="side"
          class="card glass-card live-panel"
          :class="{ 'is-active': isRunning && ((ct.phase === 'solo-' + side) || ct.phase === 'paired') }"
        >
          <div class="card-header">
            <span class="title">Live · {{ side }}</span>
            <span class="profile-tag">
              {{ store.profiles[side === 'A' ? ct.profileAIndex : ct.profileBIndex]?.name || '—' }}
            </span>
          </div>
          <div class="live-metrics">
            <div>
              <span class="metric-label">TTFT</span>
              <span class="metric-val" :class="classForLive('ttft', ct.live[side].ttft)">
                {{ fmtMs(ct.live[side].ttft) }}
              </span>
            </div>
            <div>
              <span class="metric-label">TPOT</span>
              <span class="metric-val" :class="classForLive('tpot', ct.live[side].tpot)">
                {{ fmtMs(ct.live[side].tpot) }}
              </span>
            </div>
            <div>
              <span class="metric-label">TPS</span>
              <span class="metric-val" :class="classForLive('tps', ct.live[side].tps)">
                {{ fmtTps(ct.live[side].tps) }}
              </span>
            </div>
          </div>
          <div class="live-response scroller">
            <pre v-if="ct.live[side].responseText">{{ ct.live[side].responseText }}</pre>
            <p v-else class="loading-text">No output yet.</p>
          </div>
        </div>
      </div>

      <!-- Error -->
      <div v-if="ct.status === 'error'" class="card glass-card error-card">
        <strong>❌ Error:</strong> {{ ct.error }}
      </div>
      <div v-else-if="ct.status === 'cancelled'" class="card glass-card cancel-card">
        <strong>⏹ Cancelled.</strong> Partial state retained for inspection; nothing was saved.
      </div>

      <!-- Result -->
      <div v-if="ct.result" class="card glass-card result-card">
        <div class="card-header">
          <span class="title">Result — cost of cohabitation</span>
        </div>
        <table class="result-table">
          <thead>
            <tr>
              <th>Side · Metric</th>
              <th>Solo (baseline)</th>
              <th>Paired A∥B</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="side in ['A', 'B']" :key="side">
              <tr>
                <td><strong>{{ side }}</strong> · TTFT</td>
                <td>{{ fmtMs(ct.result.solo[side].ttft?.median) }}</td>
                <td>{{ fmtMs(ct.result.paired[side].ttft?.median) }}</td>
                <td :class="deltaClass(ct.result.delta[side].ttft, 'latency')">
                  {{ fmtDelta(ct.result.delta[side].ttft) }}
                </td>
              </tr>
              <tr>
                <td><strong>{{ side }}</strong> · TPOT</td>
                <td>{{ fmtMs(ct.result.solo[side].tpot?.median) }}</td>
                <td>{{ fmtMs(ct.result.paired[side].tpot?.median) }}</td>
                <td :class="deltaClass(ct.result.delta[side].tpot, 'latency')">
                  {{ fmtDelta(ct.result.delta[side].tpot) }}
                </td>
              </tr>
              <tr>
                <td><strong>{{ side }}</strong> · TPS</td>
                <td>{{ fmtTps(ct.result.solo[side].tps?.median) }}</td>
                <td>{{ fmtTps(ct.result.paired[side].tps?.median) }}</td>
                <td :class="deltaClass(ct.result.delta[side].tps, 'tps')">
                  {{ fmtDelta(ct.result.delta[side].tps) }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <p class="result-legend">
          Δ &gt; 0 worse for latency · Δ &lt; 0 worse for TPS · |Δ| &lt; 5 % treated as no-impact.
        </p>
      </div>

      <!-- History -->
      <div class="card glass-card history-card" v-if="store.cotenancyRuns.length">
        <div class="card-header">
          <span class="title">Saved sessions ({{ store.cotenancyRuns.length }})</span>
          <button class="btn btn-secondary btn-sm" @click="clearHistory">🗑️ Clear</button>
        </div>
        <div class="sessions-list scroller">
          <div v-for="s in store.cotenancyRuns" :key="s.id" class="session-row">
            <div class="session-head">
              <span class="session-models">
                <strong>A:</strong> {{ s.A.modelName }} <span class="muted">({{ s.A.profileName }})</span>
                &nbsp;∥&nbsp;
                <strong>B:</strong> {{ s.B.modelName }} <span class="muted">({{ s.B.profileName }})</span>
              </span>
              <span class="session-meta">
                ×{{ s.iterations }}+{{ s.warmup }}wu · {{ fmtDate(s.timestamp) }}
              </span>
              <button class="delete-row-btn" aria-label="Delete session" @click="deleteSession(s.id)">×</button>
            </div>
            <div class="session-deltas">
              <span :class="deltaClass(s.result.delta.A.tps, 'tps')">
                A · TPS Δ {{ fmtDelta(s.result.delta.A.tps) }}
              </span>
              <span :class="deltaClass(s.result.delta.A.ttft, 'latency')">
                · TTFT Δ {{ fmtDelta(s.result.delta.A.ttft) }}
              </span>
              <span class="sep">|</span>
              <span :class="deltaClass(s.result.delta.B.tps, 'tps')">
                B · TPS Δ {{ fmtDelta(s.result.delta.B.tps) }}
              </span>
              <span :class="deltaClass(s.result.delta.B.ttft, 'latency')">
                · TTFT Δ {{ fmtDelta(s.result.delta.B.ttft) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cotenancy-layout {
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
  gap: 20px;
}
.view-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.view-header h2 { font-size: 22px; color: var(--text-primary); }
.desc { font-size: 13px; color: var(--text-secondary); margin-top: 4px; max-width: 620px; line-height: 1.5; }

.header-actions { display: flex; align-items: center; gap: 14px; }

.phase-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.warmup-tag {
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background-color: var(--color-warning-bg);
  color: var(--color-warning);
  border: 1px solid rgba(245, 158, 11, 0.2);
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

/* Setup */
.setup-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 100px 100px;
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
.notes { margin-top: 12px; display: flex; flex-direction: column; gap: 4px; }
.note {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--surface-1);
}
.note.warn { color: var(--color-warning); background: var(--color-warning-bg); }
.note.muted { color: var(--text-muted); background: transparent; padding-left: 0; }

/* Live panels */
.live-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.live-panel { display: flex; flex-direction: column; min-height: 220px; }
.live-panel.is-active { box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.35); }
.profile-tag {
  font-size: 10px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-indigo);
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
}
.live-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 10px;
}
.live-metrics > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--surface-1);
  border-radius: 8px;
}
.metric-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
}
.metric-val {
  font-family: 'Outfit', sans-serif;
  font-size: 18px;
  font-weight: 700;
}
.live-response {
  flex: 1;
  background: var(--inset-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  overflow-y: auto;
  max-height: 220px;
  font-size: 12px;
  line-height: 1.5;
}
.live-response pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  color: var(--text-primary);
  user-select: text;
  margin: 0;
}
.loading-text { color: var(--text-muted); font-style: italic; }

/* Result */
.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.result-table th, .result-table td {
  text-align: left;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}
.result-table th {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.result-table tbody tr:last-child td { border-bottom: none; }
.result-legend {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-muted);
}

/* Status cards */
.error-card { color: var(--color-danger); background: var(--color-danger-bg); border: 1px solid var(--color-danger); }
.cancel-card { color: var(--text-secondary); border: 1px solid var(--border-color); }

/* Sessions */
.sessions-list { display: flex; flex-direction: column; gap: 8px; max-height: 260px; overflow-y: auto; }
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
  position: relative;
}
.session-models { font-size: 12px; color: var(--text-primary); }
.session-meta { font-size: 10px; color: var(--text-muted); margin-left: auto; font-variant-numeric: tabular-nums; }
.session-deltas { font-size: 11px; display: flex; gap: 6px; flex-wrap: wrap; }
.session-deltas .sep { color: var(--text-muted); }
.muted { color: var(--text-muted); }
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
