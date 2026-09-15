<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { store, fetchModels } from "../store/store.js";

const modelOpen = ref(false);
const modelWrap = ref(null);
const modelInput = ref(null);
const modelListEl = ref(null);
const activeIndex = ref(-1); // keyboard-highlighted index in the dropdown

// All form controls are locked while a benchmark is running — changing the
// endpoint / model / sampling mid-stream would invalidate the in-flight run's
// measurements (and a series uses the current `store.config` per iteration).
const isRunning = computed(() => store.activeRun.status === "running");

// Filter the fetched catalogue by whatever is currently typed (combobox).
const filteredModels = computed(() => {
  const q = (store.config.model || "").toLowerCase().trim();
  if (!q) return store.models.list;
  return store.models.list.filter((m) => m.toLowerCase().includes(q));
});

async function loadModels() {
  await fetchModels();
  if (store.models.status === "loaded" && store.models.list.length) {
    modelOpen.value = true;
  }
}

function selectModel(m) {
  store.config.model = m;
  modelOpen.value = false;
}

function clearModel() {
  store.config.model = "";
  // Return focus so the user can immediately type or pick from the dropdown.
  modelInput.value?.focus();
  if (store.models.list.length) modelOpen.value = true;
}

function onModelFocus() {
  if (store.models.list.length) modelOpen.value = true;
}

// Keyboard navigation for the combobox: ↓ opens / moves down, ↑ moves up,
// Enter confirms the highlighted option, Esc closes.
function onModelKeydown(e) {
  if (isRunning.value) return;
  const items = filteredModels.value;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!modelOpen.value && items.length) {
      modelOpen.value = true;
      activeIndex.value = 0;
    } else if (items.length) {
      activeIndex.value = Math.min(activeIndex.value + 1, items.length - 1);
    }
    scrollActiveIntoView();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (modelOpen.value && items.length) {
      activeIndex.value = Math.max(activeIndex.value - 1, 0);
      scrollActiveIntoView();
    }
  } else if (e.key === "Enter") {
    if (modelOpen.value && activeIndex.value >= 0 && items[activeIndex.value]) {
      e.preventDefault();
      selectModel(items[activeIndex.value]);
    }
  } else if (e.key === "Escape") {
    if (modelOpen.value) {
      e.preventDefault();
      modelOpen.value = false;
    }
  }
}

function scrollActiveIntoView() {
  // Defer so the rendered <li> with .highlighted is in the DOM before scrolling.
  requestAnimationFrame(() => {
    const ul = modelListEl.value;
    if (!ul) return;
    const li = ul.querySelector("li.highlighted");
    if (li) li.scrollIntoView({ block: "nearest" });
  });
}

// Reset highlight whenever the dropdown opens or the filter changes.
watch([modelOpen, filteredModels], () => {
  activeIndex.value = modelOpen.value && filteredModels.value.length ? 0 : -1;
});

function handleClickOutside(e) {
  if (modelWrap.value && !modelWrap.value.contains(e.target)) {
    modelOpen.value = false;
  }
}

onMounted(() => document.addEventListener("mousedown", handleClickOutside));
onBeforeUnmount(() => document.removeEventListener("mousedown", handleClickOutside));
</script>

<template>
  <div class="config-panel glass-panel">
    <div class="panel-header">
      <h3>⚙️ Engine Parameters</h3>
      <p class="subtitle">Customize connection & sampling settings</p>
    </div>

    <div class="panel-body scroller">
      <!-- Connection Settings -->
      <div class="settings-group">
        <h4>API CONNECTION</h4>
        
        <div class="form-row">
          <label for="api-url">Base API Endpoint</label>
          <input
            id="api-url"
            v-model="store.config.url"
            type="url"
            placeholder="http://localhost:11434/v1"
            :disabled="isRunning"
          />
        </div>

        <div class="form-row">
          <label for="api-key">API Key (Optional)</label>
          <input
            id="api-key"
            v-model="store.config.apiKey"
            type="password"
            placeholder="••••••••••••••••"
            :disabled="isRunning"
          />
        </div>

        <div class="form-row">
          <label for="api-model">Model Name / ID</label>
          <div class="model-combobox" ref="modelWrap">
            <input
              id="api-model"
              ref="modelInput"
              v-model="store.config.model"
              type="text"
              placeholder="e.g. llama3, mixtral"
              autocomplete="off"
              role="combobox"
              aria-controls="model-listbox"
              aria-autocomplete="list"
              :aria-expanded="modelOpen && filteredModels.length > 0 && !isRunning"
              :aria-activedescendant="activeIndex >= 0 ? `model-opt-${activeIndex}` : undefined"
              :disabled="isRunning"
              @focus="onModelFocus"
              @keydown="onModelKeydown"
            />
            <button
              v-if="store.config.model"
              class="model-clear-btn"
              type="button"
              title="Clear model name"
              aria-label="Clear model name"
              :disabled="isRunning"
              @click="clearModel"
            >
              ×
            </button>
            <button
              class="model-fetch-btn"
              type="button"
              :disabled="isRunning || store.models.status === 'loading'"
              title="Fetch available models from the endpoint"
              @click="loadModels"
            >
              <span v-if="store.models.status === 'loading'" class="spinner-sm"></span>
              <span v-else>↻</span>
            </button>

            <ul
              v-if="modelOpen && filteredModels.length && !isRunning"
              id="model-listbox"
              ref="modelListEl"
              class="model-dropdown scroller"
              role="listbox"
            >
              <li
                v-for="(m, idx) in filteredModels"
                :key="m"
                :id="`model-opt-${idx}`"
                role="option"
                :aria-selected="m === store.config.model"
                :class="{ active: m === store.config.model, highlighted: idx === activeIndex }"
                @mousedown.prevent="selectModel(m)"
                @mousemove="activeIndex = idx"
              >
                {{ m }}
              </li>
            </ul>
          </div>
          <p v-if="store.models.status === 'error'" class="model-status err">
            {{ store.models.error }}
          </p>
          <p
            v-else-if="store.models.status === 'loaded'"
            class="model-status"
          >
            {{ store.models.list.length }} model(s) available — type to filter or pick from the list.
          </p>
        </div>
      </div>

      <!-- Inference Configurations -->
      <div class="settings-group">
        <h4>SAMPLING & PARAMETERS</h4>

        <div class="form-row">
          <div class="slider-header">
            <label for="temp">Temperature: {{ store.config.temperature }}</label>
          </div>
          <input
            id="temp"
            v-model.number="store.config.temperature"
            type="range"
            min="0"
            max="2"
            step="0.1"
            class="slider"
            :disabled="isRunning"
          />
        </div>

        <div class="form-row">
          <label for="max-tokens">Max Output Tokens</label>
          <input
            id="max-tokens"
            v-model.number="store.config.maxTokens"
            type="number"
            min="1"
            max="8192"
            :disabled="isRunning"
          />
        </div>

        <div class="form-row two-col">
          <div>
            <label for="iterations">Benchmark Runs</label>
            <input
              id="iterations"
              v-model.number="store.config.iterations"
              type="number"
              min="1"
              max="100"
              :disabled="isRunning"
            />
          </div>
          <div>
            <label for="warmup">Warm-up</label>
            <input
              id="warmup"
              v-model.number="store.config.warmup"
              type="number"
              min="0"
              max="20"
              :disabled="isRunning"
            />
          </div>
        </div>
        <p class="hint">Runs are averaged (median); warm-up runs are discarded to skip cold-start.</p>

        <div class="form-row flex-row">
          <label for="stream-toggle">Enable Token Streaming</label>
          <label class="switch">
            <input
              id="stream-toggle"
              type="checkbox"
              v-model="store.config.stream"
              :disabled="isRunning"
            />
            <span class="slider-switch"></span>
          </label>
        </div>
      </div>

      <!-- System Prompt -->
      <div class="settings-group last">
        <h4>SYSTEM PROMPT</h4>
        <div class="form-row">
          <label for="sys-prompt">System Instructions</label>
          <textarea
            id="sys-prompt"
            v-model="store.config.systemPrompt"
            rows="3"
            placeholder="Define the behavior of the model..."
            :disabled="isRunning"
          ></textarea>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-radius: 12px;
}

.panel-header {
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
}

.panel-header h3 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.subtitle {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.panel-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border-color);
}

.settings-group.last {
  border-bottom: none;
  padding-bottom: 0;
}

.settings-group h4 {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent-cyan);
  letter-spacing: 0.08em;
}

.form-row {
  display: flex;
  flex-direction: column;
}

/* Model combobox (type or pick from fetched catalogue) */
.model-combobox {
  position: relative;
}

.model-combobox input {
  padding-right: 66px; /* room for the clear (×) + fetch (↻) buttons */
}

.model-fetch-btn,
.model-clear-btn {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: color 0.2s;
}

.model-fetch-btn {
  right: 0;
  width: 36px;
  border-radius: 0 8px 8px 0;
  font-size: 15px;
}

.model-clear-btn {
  right: 32px;
  width: 28px;
  font-size: 18px;
  line-height: 1;
}

.model-fetch-btn:hover:not(:disabled),
.model-clear-btn:hover {
  color: var(--accent-cyan);
}

.model-fetch-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.model-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  max-height: 220px;
  overflow-y: auto;
  list-style: none;
  background: var(--popover-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 4px;
}

.model-dropdown li {
  padding: 8px 10px;
  font-size: 13px;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: background 0.15s, color 0.15s;
}

.model-dropdown li:hover,
.model-dropdown li.highlighted {
  background: var(--surface-3);
  color: var(--text-primary);
}

.model-dropdown li.active {
  background: rgba(99, 102, 241, 0.2);
  color: var(--text-primary);
}

.model-dropdown li.active.highlighted {
  background: rgba(99, 102, 241, 0.3);
}

.model-status {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}

.model-status.err {
  color: var(--color-danger);
}

.spinner-sm {
  display: inline-block;
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: var(--accent-cyan);
  border-radius: 50%;
  animation: spin-sm 0.8s linear infinite;
}

@keyframes spin-sm {
  to { transform: rotate(360deg); }
}

.flex-row {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.two-col {
  flex-direction: row;
  gap: 12px;
}

.two-col > div {
  flex: 1;
}

.hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: -8px;
  line-height: 1.4;
}

.slider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.slider {
  -webkit-appearance: none;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--track-bg);
  outline: none;
  padding: 0;
  cursor: pointer;
  border: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent-indigo);
  cursor: pointer;
  box-shadow: 0 0 10px rgba(99, 102, 241, 0.5);
  transition: transform 0.1s;
}

.slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

/* Custom Switch styling */
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  margin-bottom: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider-switch {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--track-bg);
  transition: .3s;
  border-radius: 24px;
  border: 1px solid var(--border-color);
}

.slider-switch:before {
  position: absolute;
  content: "";
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .3s;
  border-radius: 50%;
  box-shadow: 0 2px 4px rgba(0,0,0,0.2);
}

input:checked + .slider-switch {
  background: var(--accent-gradient);
}

input:checked + .slider-switch:before {
  transform: translateX(20px);
}

textarea {
  resize: vertical;
}
</style>
