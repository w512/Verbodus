<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { store } from "../store/store.js";
import { confirmDialog, alertDialog } from "../store/dialog.js";
import { ttftClass, tpotClass, tpsClass, classColor } from "../store/metrics.js";
import { Chart, CHART_COLORS, CHART_FONT, tooltipTheme } from "../store/chartTheme.js";

const canvasRef = ref(null);
let chartInstance = null;
const selectedRunIds = ref([]);

// Default select the first 2 runs in history if available
onMounted(() => {
  if (store.runs.length > 0) {
    selectedRunIds.value = store.runs.slice(0, 2).map(r => r.id);
  }
  initChart();
});

const selectedRuns = computed(() => {
  return store.runs.filter(r => selectedRunIds.value.includes(r.id));
});

function toggleSelection(id) {
  const index = selectedRunIds.value.indexOf(id);
  if (index >= 0) {
    selectedRunIds.value.splice(index, 1);
  } else {
    // Limit to comparing 4 runs simultaneously to avoid chart clutter
    if (selectedRunIds.value.length >= 4) {
      alertDialog({
        title: "Comparison limit",
        message: "You can compare a maximum of 4 runs simultaneously.",
      });
      return;
    }
    selectedRunIds.value.push(id);
  }
}

function formatDate(isoString) {
  const d = new Date(isoString);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function deleteRun(id, event) {
  event.stopPropagation();
  const ok = await confirmDialog({
    title: "Delete run",
    message: "Delete this run from history?",
    confirmText: "Delete",
    danger: true,
  });
  if (ok) {
    store.deleteRun(id);
    selectedRunIds.value = selectedRunIds.value.filter(runId => runId !== id);
  }
}

async function clearAllHistory() {
  const ok = await confirmDialog({
    title: "Clear history",
    message: "Wipe all benchmark history? This cannot be undone.",
    confirmText: "Clear history",
    danger: true,
  });
  if (ok) {
    store.clearRuns();
    selectedRunIds.value = [];
  }
}

function initChart() {
  if (!canvasRef.value) return;
  const ctx = canvasRef.value.getContext("2d");

  chartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: [],
      datasets: [
        {
          label: "TTFT (ms - Lower is Better)",
          data: [],
          backgroundColor: "rgba(99, 102, 241, 0.75)",
          borderColor: CHART_COLORS.indigo,
          borderWidth: 1,
          yAxisID: "y-ttft"
        },
        {
          label: "Avg Speed (TPS - Higher is Better)",
          data: [],
          backgroundColor: "rgba(6, 182, 212, 0.75)",
          borderColor: CHART_COLORS.cyan,
          borderWidth: 1,
          yAxisID: "y-tps"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: {
            color: CHART_COLORS.axisTitle,
            font: CHART_FONT
          }
        },
        tooltip: tooltipTheme
      },
      scales: {
        x: {
          grid: { color: CHART_COLORS.gridFaint },
          ticks: { color: CHART_COLORS.axisTitle, font: { ...CHART_FONT, size: 10 } }
        },
        "y-ttft": {
          type: "linear",
          position: "left",
          title: {
            display: true,
            text: "TTFT (ms)",
            color: CHART_COLORS.indigo,
            font: { ...CHART_FONT, size: 10 }
          },
          grid: { color: CHART_COLORS.gridFaint },
          ticks: { color: CHART_COLORS.axisTitle },
          min: 0
        },
        "y-tps": {
          type: "linear",
          position: "right",
          title: {
            display: true,
            text: "Throughput (TPS)",
            color: CHART_COLORS.cyan,
            font: { ...CHART_FONT, size: 10 }
          },
          grid: { drawOnChartArea: false }, // avoid duplicate horizontal gridlines
          ticks: { color: CHART_COLORS.axisTitle },
          min: 0
        }
      }
    }
  });
}

// Watch selected runs and redraw chart datasets
watch(
  selectedRuns,
  (runs) => {
    if (!chartInstance) return;

    if (runs.length === 0) {
      chartInstance.data.labels = [];
      chartInstance.data.datasets[0].data = [];
      chartInstance.data.datasets[1].data = [];
      chartInstance.update();
      return;
    }

    // Set labels as "Model name (Profile)"
    chartInstance.data.labels = runs.map(r => `${r.modelName.substring(0, 10)}.. (${r.configName})`);
    
    // Set datasets
    chartInstance.data.datasets[0].data = runs.map(r => r.ttft);
    chartInstance.data.datasets[1].data = runs.map(r => r.tps);

    chartInstance.update();
  },
  { deep: true }
);

onBeforeUnmount(() => {
  if (chartInstance) {
    chartInstance.destroy();
  }
});
</script>

<template>
  <div class="comparison-layout">
    <div class="main-content">
      <header class="view-header">
        <div>
          <h2>📊 Engine Comparison Dashboard</h2>
          <p class="desc">Select historical run reports to evaluate side-by-side performance metrics</p>
        </div>
        <button 
          class="btn btn-secondary" 
          v-if="store.runs.length > 0"
          @click="clearAllHistory"
        >
          🗑️ Clear History
        </button>
      </header>

      <div class="view-grid">
        <!-- History List (Left) -->
        <div class="history-section card glass-card">
          <div class="section-title">
            <span>BENCHMARK HISTORY ({{ store.runs.length }})</span>
          </div>

          <div class="runs-list scroller" v-if="store.runs.length > 0">
            <div 
              v-for="run in store.runs" 
              :key="run.id"
              class="run-row"
              :class="{ selected: selectedRunIds.includes(run.id) }"
              @click="toggleSelection(run.id)"
            >
              <div class="selection-indicator">
                <div class="checkbox" :class="{ checked: selectedRunIds.includes(run.id) }"></div>
              </div>
              <div class="run-info">
                <div class="run-model-meta">
                  <span class="model-name">🤖 {{ run.modelName }}</span>
                  <span class="profile-tag">🔌 {{ run.configName }}</span>
                  <span v-if="run.iterations > 1" class="runs-tag">×{{ run.iterations }} median</span>
                </div>
                <div class="run-stats">
                  <span>Speed: <strong :style="{ color: classColor(tpsClass(run.tps)) }">{{ run.tps }} tps</strong></span>
                  <span>TTFT: <strong :style="{ color: classColor(ttftClass(run.ttft)) }">{{ run.ttft != null ? `${run.ttft} ms` : 'N/A' }}</strong></span>
                  <span>Tokens: <strong>{{ run.tokenCount }}</strong></span>
                </div>
                <div class="run-date">{{ formatDate(run.timestamp) }}</div>
              </div>
              <button class="delete-row-btn" @click="deleteRun(run.id, $event)">×</button>
            </div>
          </div>
          <div class="empty-state" v-else>
            <p>No benchmarks run yet. Go to the 🎮 Playground view and complete some performance trials.</p>
          </div>
        </div>

        <!-- Comparative Chart & Details (Right) -->
        <div class="chart-section">
          <!-- Comparison Chart Card -->
          <div class="card glass-card chart-container-card">
            <div class="card-header">
              <span class="title">PERFORMANCE METRICS CONTRAST (MAX 4)</span>
            </div>
            <div class="chart-box" v-show="selectedRuns.length > 0">
              <canvas ref="canvasRef"></canvas>
            </div>
            <div class="chart-empty-state" v-show="selectedRuns.length === 0">
              <p>Check the box next to runs on the left to display their performance comparison graph here.</p>
            </div>
          </div>

          <!-- Selection Summary Details -->
          <div class="runs-detail-grid" v-if="selectedRuns.length > 0">
            <div 
              v-for="run in selectedRuns" 
              :key="run.id"
              class="detail-card glass-card"
            >
              <div class="detail-header">
                <h5>{{ run.modelName }}</h5>
                <span class="detail-tag">{{ run.configName }}</span>
              </div>
              <div class="detail-body">
                <div class="detail-metric">
                  <span>TTFT:</span>
                  <strong :style="{ color: classColor(ttftClass(run.ttft)) }">{{ run.ttft != null ? `${run.ttft} ms` : 'N/A' }}</strong>
                </div>
                <div class="detail-metric">
                  <span>TPOT:</span>
                  <strong :style="{ color: classColor(tpotClass(run.tpot)) }">{{ run.tpot != null ? `${run.tpot} ms` : 'N/A' }}</strong>
                </div>
                <div class="detail-metric">
                  <span>Speed:</span>
                  <strong :style="{ color: classColor(tpsClass(run.tps)) }">{{ run.tps }} tps</strong>
                </div>
                <div class="detail-metric">
                  <span>Tokens:</span>
                  <strong>{{ run.tokenCount }} (P:{{ run.promptTokens }}/C:{{ run.completionTokens }})</strong>
                </div>
                <div class="detail-prompt">
                  <span>Prompt:</span>
                  <p class="truncate">"{{ run.prompt }}"</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.comparison-layout {
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
}

.view-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.view-header h2 {
  font-size: 22px;
  color: var(--text-primary);
}

.desc {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.view-grid {
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  gap: 24px;
  flex: 1;
  min-height: 0;
}

.card {
  border-radius: 12px;
  padding: 16px 20px;
}

.section-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-bottom: 16px;
  flex-shrink: 0;
}

/* History Section */
.history-section {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 400px;
}

.runs-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.run-row {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  background: var(--surface-1);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
}

.run-row:hover {
  background: var(--surface-2);
  border-color: var(--border-color-hover);
}

.run-row.selected {
  background: rgba(99, 102, 241, 0.06);
  border-color: rgba(99, 102, 241, 0.3);
}

.selection-indicator {
  margin-right: 14px;
}

.checkbox {
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--text-muted);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.checkbox.checked {
  background: var(--accent-indigo);
  border-color: var(--accent-indigo);
}

.checkbox.checked:after {
  content: "✓";
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}

.run-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.run-model-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
}

.profile-tag {
  font-size: 10px;
  background: var(--surface-3);
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
}

.runs-tag {
  font-size: 10px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-indigo);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.run-stats {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-secondary);
}

.run-stats strong {
  color: var(--text-primary);
}

.run-date {
  font-size: 10px;
  color: var(--text-muted);
}

.delete-row-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s, color 0.2s;
  padding: 0 4px;
}

.run-row:hover .delete-row-btn {
  opacity: 1;
}

.delete-row-btn:hover {
  color: var(--color-danger);
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-muted);
  font-style: italic;
  padding: 40px;
}

/* Chart and Details styling */
.chart-section {
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
}

.chart-container-card {
  height: 320px;
  display: flex;
  flex-direction: column;
}

.card-header .title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

.chart-box {
  flex: 1;
  min-height: 0;
}

.chart-empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-muted);
  font-style: italic;
}

.runs-detail-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  overflow-y: auto;
  max-height: 250px;
  padding-bottom: 8px;
}

.detail-card {
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--surface-1);
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 6px;
}

.detail-header h5 {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}

.detail-tag {
  font-size: 9px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--accent-indigo);
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-metric {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary);
}

.detail-metric strong {
  color: var(--text-primary);
}

.detail-prompt {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 4px;
  border-top: 1px dashed var(--border-color);
  padding-top: 4px;
}

.truncate {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-style: italic;
  margin-top: 2px;
}
</style>
