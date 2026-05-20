<script setup>
import { store } from "../store/store.js";
import { ref } from "vue";

const newProfileName = ref("");
const isCreating = ref(false);

function triggerCreate() {
  isCreating.value = true;
  newProfileName.value = `Profile ${store.profiles.length + 1}`;
}

function confirmCreate() {
  if (newProfileName.value.trim()) {
    store.saveProfile(newProfileName.value.trim());
    store.selectProfile(store.profiles.length - 1);
    isCreating.value = false;
  }
}

function cancelCreate() {
  isCreating.value = false;
}

function removeProfile(index, event) {
  event.stopPropagation();
  if (confirm("Are you sure you want to delete this profile?")) {
    store.deleteProfile(index);
  }
}
</script>

<template>
  <aside class="sidebar glass-panel">
    <div class="brand">
      <div class="logo-icon">⚡</div>
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
    </nav>

    <div class="profiles-section">
      <div class="section-header">
        <span>API PROFILES</span>
        <button class="add-btn" @click="triggerCreate" title="Add profile">+</button>
      </div>

      <div class="profile-creator" v-if="isCreating">
        <input 
          v-model="newProfileName" 
          placeholder="Profile name..." 
          @keyup.enter="confirmCreate"
          ref="nameInput"
        />
        <div class="creator-actions">
          <button class="btn btn-primary btn-sm" @click="confirmCreate">Save</button>
          <button class="btn btn-secondary btn-sm" @click="cancelCreate">Cancel</button>
        </div>
      </div>

      <ul class="profiles-list scroller">
        <li 
          v-for="(prof, idx) in store.profiles" 
          :key="prof.name"
          :class="{ active: store.activeProfileIndex === idx }"
          @click="store.selectProfile(idx)"
        >
          <span class="profile-name">🔌 {{ prof.name }}</span>
          <button 
            v-if="store.profiles.length > 1"
            class="delete-btn" 
            @click="removeProfile(idx, $event)" 
            title="Delete profile"
          >
            ×
          </button>
        </li>
      </ul>
    </div>

    <div class="footer">
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

.logo-icon {
  font-size: 24px;
  background: var(--accent-gradient);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
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
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-primary);
}

.nav-btn.active {
  background: rgba(99, 102, 241, 0.1);
  border-color: rgba(99, 102, 241, 0.2);
  color: #fff;
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

.profile-creator {
  background: rgba(255, 255, 255, 0.02);
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
  background: rgba(255, 255, 255, 0.02);
  color: var(--text-primary);
}

.profiles-list li.active {
  background: rgba(255, 255, 255, 0.04);
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

.footer {
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
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
