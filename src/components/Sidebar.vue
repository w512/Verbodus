<script setup>
import { store } from "../store/store.js";
import { confirmDialog } from "../store/dialog.js";
import { theme, toggleTheme } from "../store/theme.js";
import { ref, computed, nextTick, watch } from "vue";

const newProfileName = ref("");
const isCreating = ref(false);
const createError = ref("");
const nameInput = ref(null);

// Profile list is read-only while any benchmark runs (see store.isBusy()) —
// switching mid-run would mislabel results or change the endpoint under a
// running series.
const isBusy = computed(() => store.isBusy());

// Pick a default name that doesn't collide with an existing profile.
function suggestName() {
  const taken = new Set(store.profiles.map((p) => p.name.toLowerCase()));
  let n = store.profiles.length + 1;
  while (taken.has(`profile ${n}`)) n++;
  return `Profile ${n}`;
}

function triggerCreate() {
  if (isBusy.value) return;
  isCreating.value = true;
  createError.value = "";
  newProfileName.value = suggestName();
  nextTick(() => nameInput.value?.select());
}

function confirmCreate() {
  const res = store.createProfile(newProfileName.value);
  if (!res.ok) {
    createError.value = res.error;
    nameInput.value?.focus();
    return;
  }
  store.selectProfile(res.index);
  isCreating.value = false;
  createError.value = "";
}

function cancelCreate() {
  isCreating.value = false;
  createError.value = "";
}

// Clear a stale validation message as soon as the user edits the name.
watch(newProfileName, () => { createError.value = ""; });

function pickProfile(idx) {
  if (isBusy.value) return;
  store.selectProfile(idx);
}

async function removeProfile(index, event) {
  event.stopPropagation();
  if (isBusy.value) return;
  const ok = await confirmDialog({
    title: "Delete profile",
    message: `Delete the profile "${store.profiles[index].name}"?`,
    confirmText: "Delete",
    danger: true,
  });
  if (ok) {
    store.deleteProfile(index);
  }
}
</script>

<template>
  <aside class="sidebar glass-panel">
    <div class="brand">
      <img src="../assets/logo.png" alt="Verbodus Logo" class="logo-img" />
      <h2>Verbodus</h2>
    </div>

    <nav class="nav-links">
      <button 
        class="nav-btn" 
        :class="{ active: store.currentView === 'playground' }"
        @click="store.currentView = 'playground'"
      >
        <span class="icon">🎮</span> Playground
      </button>
      <button
        class="nav-btn"
        :class="{ active: store.currentView === 'comparison' }"
        @click="store.currentView = 'comparison'"
      >
        <span class="icon">📊</span> Run Comparison
      </button>
      <button
        class="nav-btn"
        :class="{ active: store.currentView === 'cotenancy' }"
        @click="store.currentView = 'cotenancy'"
      >
        <span class="icon">🧪</span> Co-Tenancy
      </button>
      <button
        class="nav-btn"
        :class="{ active: store.currentView === 'concurrency' }"
        @click="store.currentView = 'concurrency'"
      >
        <span class="icon">⚡</span> Concurrency
      </button>
      <button
        class="nav-btn"
        :class="{ active: store.currentView === 'help' }"
        @click="store.currentView = 'help'"
      >
        <span class="icon">📖</span> Metrics &amp; Help
      </button>
    </nav>

    <div class="profiles-section">
      <div class="section-header">
        <span>API PROFILES</span>
        <button
          class="add-btn"
          @click="triggerCreate"
          :disabled="isBusy"
          :title="isBusy ? 'Unavailable while a benchmark is running' : 'Add profile'"
        >+</button>
      </div>

      <div class="profile-creator" v-if="isCreating">
        <input
          v-model="newProfileName"
          placeholder="Profile name..."
          :class="{ invalid: createError }"
          :aria-invalid="!!createError"
          aria-describedby="profile-name-error"
          @keyup.enter="confirmCreate"
          @keyup.esc="cancelCreate"
          ref="nameInput"
        />
        <p v-if="createError" id="profile-name-error" class="creator-error" role="alert">
          {{ createError }}
        </p>
        <div class="creator-actions">
          <button class="btn btn-primary btn-sm" @click="confirmCreate">Save</button>
          <button class="btn btn-secondary btn-sm" @click="cancelCreate">Cancel</button>
        </div>
      </div>

      <ul class="profiles-list scroller" :class="{ locked: isBusy }" :aria-disabled="isBusy">
        <li
          v-for="(prof, idx) in store.profiles"
          :key="prof.name"
          :class="{ active: store.activeProfileIndex === idx }"
          :title="isBusy && store.activeProfileIndex !== idx ? 'Unavailable while a benchmark is running' : undefined"
          @click="pickProfile(idx)"
        >
          <span class="profile-name">🔌 {{ prof.name }}</span>
          <button
            v-if="store.profiles.length > 1"
            class="delete-btn"
            :disabled="isBusy"
            @click="removeProfile(idx, $event)"
            title="Delete profile"
          >
            ×
          </button>
        </li>
      </ul>
    </div>

    <div class="footer">
      <button class="theme-toggle" @click="toggleTheme" :title="`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`">
        <span class="theme-icon">{{ theme === 'dark' ? '🌙' : '☀️' }}</span>
        <span>{{ theme === 'dark' ? 'Dark' : 'Light' }} theme</span>
        <span class="theme-hint">Switch</span>
      </button>
      <p class="status-indicator">
        <span class="dot pulse"></span> Web Engine: Native Safari WebView
      </p>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 280px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding: 24px;
  border-radius: 0;
  border-top: none;
  border-bottom: none;
  border-left: none;
  background: var(--bg-sidebar);
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 32px;
}

.logo-img {
  width: 28px;
  height: 28px;
  object-fit: contain;
  border-radius: 6px;
  filter: drop-shadow(0 2px 8px rgba(6, 182, 212, 0.4));
}

.brand h2 {
  font-size: 20px;
  font-weight: 800;
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.nav-links {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 32px;
}

.nav-btn {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-btn:hover {
  background: var(--surface-2);
  color: var(--text-primary);
}

.nav-btn.active {
  background: rgba(99, 102, 241, 0.18);
  border-color: rgba(99, 102, 241, 0.35);
  color: var(--text-primary);
  box-shadow: 0 4px 20px rgba(99, 102, 241, 0.05);
}

.profiles-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.add-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
  transition: color 0.2s;
  line-height: 1;
}

.add-btn:hover {
  color: var(--accent-cyan);
}

.add-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  color: var(--text-secondary);
}

.profile-creator {
  background: var(--surface-1);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px;
  margin-bottom: 12px;
}

.profile-creator input {
  padding: 6px 10px;
  font-size: 12px;
  margin-bottom: 8px;
}

.profile-creator input.invalid {
  border-color: var(--color-danger);
}

.creator-error {
  font-size: 11px;
  color: var(--color-danger);
  margin: -4px 2px 8px;
  line-height: 1.4;
}

.creator-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 4px;
}

.profiles-list {
  list-style: none;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.profiles-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 13px;
  color: var(--text-secondary);
}

.profiles-list li:hover {
  background: var(--surface-1);
  color: var(--text-primary);
}

/* While a benchmark runs the list is read-only: keep the active row legible,
   dim the rest and drop the pointer affordance. */
.profiles-list.locked li {
  cursor: not-allowed;
}
.profiles-list.locked li:not(.active) {
  opacity: 0.5;
}
.profiles-list.locked li:not(.active):hover {
  background: transparent;
  color: var(--text-secondary);
}

.profiles-list li.active {
  background: var(--surface-2);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.profile-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.delete-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s, color 0.2s;
  padding: 0 4px;
}

.profiles-list li:hover .delete-btn {
  opacity: 1;
}

.delete-btn:hover {
  color: var(--color-danger);
}

.delete-btn:disabled,
.profiles-list li:hover .delete-btn:disabled {
  opacity: 0;
  cursor: not-allowed;
}

.footer {
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.theme-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 12px;
  background: var(--surface-1);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.2s ease;
}

.theme-toggle:hover {
  background: var(--surface-2);
  border-color: var(--border-color-hover);
  color: var(--text-primary);
}

.theme-icon {
  font-size: 15px;
  line-height: 1;
}

.theme-hint {
  margin-left: auto;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.status-indicator {
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 6px;
  height: 6px;
  background-color: var(--color-success);
  border-radius: 50%;
}

.pulse {
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}
</style>
