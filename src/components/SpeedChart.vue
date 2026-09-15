<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { Chart, CHART_COLORS, CHART_FONT, tooltipTheme } from "../store/chartTheme.js";

const props = defineProps({
  dataPoints: {
    type: Array,
    required: true,
    default: () => []
  }
});

const canvasRef = ref(null);
let chartInstance = null;

function initChart() {
  const ctx = canvasRef.value.getContext("2d");
  
  // Create gradient stroke
  const gradient = ctx.createLinearGradient(0, 0, canvasRef.value.width, 0);
  gradient.addColorStop(0, CHART_COLORS.indigo);
  gradient.addColorStop(1, CHART_COLORS.cyan);

  // Create gradient fill
  const fillGradient = ctx.createLinearGradient(0, 0, 0, 300);
  fillGradient.addColorStop(0, "rgba(99, 102, 241, 0.15)");
  fillGradient.addColorStop(1, "rgba(6, 182, 212, 0)");

  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Throughput (TPS)",
          data: [],
          borderColor: gradient,
          backgroundColor: fillGradient,
          fill: true,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointBackgroundColor: CHART_COLORS.cyan,
          tension: 0.35,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false, // Disable animations for real-time rendering performance
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          ...tooltipTheme,
          callbacks: {
            title: (context) => `Time: ${context[0].label}s`,
            label: (context) => `Speed: ${context.parsed.y} tps`
          }
        }
      },
      scales: {
        x: {
          type: "linear",
          title: {
            display: true,
            text: "Elapsed Time (Seconds)",
            color: CHART_COLORS.axisTitle,
            font: CHART_FONT
          },
          grid: {
            color: CHART_COLORS.grid
          },
          ticks: {
            color: CHART_COLORS.tick,
            callback: (val) => `${parseFloat(val).toFixed(1)}s`
          }
        },
        y: {
          title: {
            display: true,
            text: "Tokens Per Second",
            color: CHART_COLORS.axisTitle,
            font: CHART_FONT
          },
          grid: {
            color: CHART_COLORS.grid
          },
          ticks: {
            color: CHART_COLORS.tick
          },
          min: 0,
          suggestedMax: 50
        }
      }
    }
  });
}

// --- Incremental, frame-coalesced updates -----------------------------------
//
// The store pushes one point per streamed token. A deep watcher that rebuilt
// the whole dataset (`map` over every point, `Math.max(...spread)`) and called
// `chart.update()` per push made each token cost O(n) main-thread work — on
// the thread that timestamps the SSE chunks. Instead:
//   * mirror the source array into the dataset and only append points that
//     arrived since the last sync (O(new points));
//   * coalesce redraws with requestAnimationFrame, so a burst of tokens inside
//     one frame costs one `update()`;
//   * fall back to a full resync only when the source array is replaced (new
//     run) or its existing values are edited in place — the store rescales
//     every point's TPS once at the end of a run to match server-reported
//     token counts, which we detect via first/last point values.
let mirrored = null;   // the source array currently reflected in the chart
let rendered = 0;      // how many of its points are in the dataset
let maxTps = 0;        // running max, for the y-axis suggestedMax
let rafId = 0;

function fullSync(points) {
  const ds = chartInstance.data.datasets[0];
  ds.data = points.map((pt) => ({ x: pt.time, y: pt.tps }));
  maxTps = 0;
  for (const pt of points) if (pt.tps > maxTps) maxTps = pt.tps;
  mirrored = points;
  rendered = points.length;
}

function appendNew(points) {
  const data = chartInstance.data.datasets[0].data;
  for (let i = rendered; i < points.length; i++) {
    const pt = points[i];
    data.push({ x: pt.time, y: pt.tps });
    if (pt.tps > maxTps) maxTps = pt.tps;
  }
  rendered = points.length;
}

function scheduleDraw() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!chartInstance) return;
    // Auto-scale the y-axis; never below 50 so slow models don't look spiky.
    chartInstance.options.scales.y.suggestedMax = Math.max(50, Math.ceil(maxTps * 1.15));
    chartInstance.update("none"); // no animation — this is a live readout
  });
}

function syncFromProps() {
  if (!chartInstance) return;
  const pts = props.dataPoints;
  if (pts !== mirrored || pts.length < rendered) {
    fullSync(pts);             // new run (array replaced) or reset
  } else if (pts.length > rendered) {
    appendNew(pts);            // the common streaming case
  } else {
    fullSync(pts);             // same array, same length → values edited in place
  }
  scheduleDraw();
}

// Shallow dependencies only: array identity, length, and the first/last TPS
// values (which change when the store rescales the curve at end of run).
watch(
  () => {
    const pts = props.dataPoints;
    const n = pts.length;
    return [pts, n, n ? pts[0].tps : 0, n ? pts[n - 1].tps : 0];
  },
  syncFromProps
);

onMounted(() => {
  initChart();
  syncFromProps(); // reflect whatever is already there (KeepAlive re-mounts, etc.)
});

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
});
</script>

<template>
  <div class="chart-wrapper">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<style scoped>
.chart-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 200px;
}
canvas {
  width: 100% !important;
  height: 100% !important;
}
</style>
