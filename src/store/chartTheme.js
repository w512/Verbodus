// Shared Chart.js setup and dark-theme styling, used by both the live
// throughput line chart (SpeedChart.vue) and the comparison bar chart
// (Comparison.vue) so the registration and look-and-feel live in one place.

import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";

// Register the union of pieces both charts need (idempotent).
Chart.register(
  LineController,
  LineElement,
  PointElement,
  BarController,
  BarElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler
);

export { Chart };

export const CHART_COLORS = {
  indigo: "#6366F1",
  cyan: "#06B6D4",
  // Neutral greys so axis text and gridlines read on both light and dark
  // backgrounds (charts pick up these JS colors at init, not CSS vars).
  axisTitle: "#9CA3AF",
  tick: "#94A3B8",
  grid: "rgba(148, 163, 184, 0.18)",
  gridFaint: "rgba(148, 163, 184, 0.12)",
};

export const CHART_FONT = { family: "Inter", size: 11 };

// Shared tooltip styling (spread it, then add per-chart callbacks if needed).
export const tooltipTheme = {
  backgroundColor: "rgba(11, 15, 25, 0.9)",
  titleColor: "#9CA3AF",
  bodyColor: "#F3F4F6",
  borderColor: "rgba(255, 255, 255, 0.08)",
  borderWidth: 1,
  displayColors: false,
};
