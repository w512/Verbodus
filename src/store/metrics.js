// Single source of truth for the performance color bands (mirrors the README
// "Performance Thresholds" table). Each helper maps a metric value to a CSS
// class — stat-excellent | stat-good | stat-slow — defined globally in index.css
// so any component can colour-code metrics consistently.

export function ttftClass(ms) {
  if (ms == null || ms <= 0) return "";
  if (ms < 250) return "stat-excellent";
  if (ms < 800) return "stat-good";
  return "stat-slow";
}

export function tpotClass(ms) {
  if (ms == null || ms <= 0) return "";
  if (ms < 22) return "stat-excellent";
  if (ms < 66) return "stat-good";
  return "stat-slow";
}

export function tpsClass(tps) {
  if (tps == null || tps <= 0) return "";
  if (tps > 45) return "stat-excellent";
  if (tps > 15) return "stat-good";
  return "stat-slow";
}

// Maps a band class to its CSS colour, for places that colour via inline style
// instead of a class (e.g. small text where scoped CSS would otherwise win).
// Returns "inherit" for the empty band so the element keeps its default colour.
const BAND_COLORS = {
  "stat-excellent": "var(--color-success)",
  "stat-good": "var(--color-warning)",
  "stat-slow": "var(--color-danger)",
};

export function classColor(bandClass) {
  return BAND_COLORS[bandClass] || "inherit";
}

