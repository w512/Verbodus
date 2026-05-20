// Light/dark theme toggle. The theme is a `data-theme` attribute on <html>;
// index.css defines the dark default on :root and the light overrides on
// :root[data-theme="light"]. The choice is persisted in localStorage.

import { ref } from "vue";

const STORAGE_KEY = "verbodus_theme";

export const theme = ref(localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark");

export function applyTheme(value) {
  document.documentElement.setAttribute("data-theme", value);
}

export function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  localStorage.setItem(STORAGE_KEY, theme.value);
  applyTheme(theme.value);
}

// Apply the stored choice immediately on load.
applyTheme(theme.value);
