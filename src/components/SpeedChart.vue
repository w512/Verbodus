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

// Watch data points and update chart
watch(
  () => props.dataPoints,
  (newPoints) => {
    if (!chartInstance) return;

    if (newPoints.length === 0) {
      chartInstance.data.labels = [];
      chartInstance.data.datasets[0].data = [];
      chartInstance.update("none");
      return;
    }

    // Map data points into labels (X) and coordinates (Y)
    // Using coordinate layout: {x, y} for a scatter/line structure
    const data = newPoints.map(pt => ({ x: pt.time, y: pt.tps }));
    
    chartInstance.data.datasets[0].data = data;
    
    // Auto-scale suggest max if speed exceeds 50
    const maxTps = Math.max(...newPoints.map(p => p.tps), 0);
    chartInstance.options.scales.y.suggestedMax = Math.max(50, Math.ceil(maxTps * 1.15));

    chartInstance.update("none"); // Update instantly without animation
  },
  { deep: true }
);

onMounted(() => {
  initChart();
});

onBeforeUnmount(() => {
  if (chartInstance) {
    chartInstance.destroy();
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
