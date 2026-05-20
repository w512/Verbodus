<script setup>
import { store } from "../store/store.js";
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
          />
        </div>

        <div class="form-row">
          <label for="api-key">API Key (Optional)</label>
          <input 
            id="api-key" 
            v-model="store.config.apiKey" 
            type="password" 
            placeholder="••••••••••••••••" 
          />
        </div>

        <div class="form-row">
          <label for="api-model">Model Name / ID</label>
          <input 
            id="api-model" 
            v-model="store.config.model" 
            type="text" 
            placeholder="e.g. llama3, mixtral" 
          />
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
            />
          </div>
        </div>
        <p class="hint">Runs are averaged (median); warm-up runs are discarded to skip cold-start.</p>

        <div class="form-row flex-row">
          <label for="stream-toggle">Enable Token Streaming</label>
          <label class="switch">
            <input id="stream-toggle" type="checkbox" v-model="store.config.stream" />
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
  background: rgba(255, 255, 255, 0.1);
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
  background-color: rgba(255, 255, 255, 0.1);
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
