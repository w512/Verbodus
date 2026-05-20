<script setup>
import { watch, onBeforeUnmount } from "vue";
import { dialogState, resolveDialog } from "../store/dialog.js";

function confirm() {
  resolveDialog(true);
}

function cancel() {
  resolveDialog(false);
}

// Keyboard: Enter confirms, Escape cancels — only while a dialog is open.
function onKeydown(e) {
  if (!dialogState.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
  } else if (e.key === "Enter") {
    e.preventDefault();
    confirm();
  }
}

watch(
  () => dialogState.open,
  (open) => {
    if (open) document.addEventListener("keydown", onKeydown);
    else document.removeEventListener("keydown", onKeydown);
  }
);

onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="dialogState.open"
        class="modal-overlay"
        @mousedown.self="cancel"
      >
        <div class="modal-card glass-panel" role="dialog" aria-modal="true">
          <h3 v-if="dialogState.title" class="modal-title">{{ dialogState.title }}</h3>
          <p class="modal-message">{{ dialogState.message }}</p>

          <div class="modal-actions">
            <button
              v-if="dialogState.kind === 'confirm'"
              class="btn btn-secondary"
              @click="cancel"
            >
              {{ dialogState.cancelText }}
            </button>
            <button
              class="btn"
              :class="dialogState.danger ? 'btn-danger' : 'btn-primary'"
              @click="confirm"
            >
              {{ dialogState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(5, 8, 15, 0.6);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.modal-card {
  width: 100%;
  max-width: 400px;
  padding: 24px;
  background: var(--bg-card);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}

.modal-title {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 10px;
}

.modal-message {
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}

/* Danger confirm button (e.g. destructive deletes) */
.btn-danger {
  background: var(--color-danger-bg);
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
}

.btn-danger:hover {
  filter: brightness(1.2);
  transform: translateY(-1px);
}

/* Enter/leave transition */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 0.18s ease;
}

.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: translateY(8px) scale(0.98);
}
</style>
