<script setup>
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import { dialogState, resolveDialog } from "../store/dialog.js";

const cardRef = ref(null);
const cancelBtn = ref(null);
const confirmBtn = ref(null);
let previouslyFocused = null; // element to give focus back to on close

function confirm() {
  resolveDialog(true);
}

function cancel() {
  resolveDialog(false);
}

// Keyboard handling while a dialog is open:
//   Escape — cancel.
//   Enter  — activates the *focused* button (native behaviour) rather than
//            always confirming. For danger dialogs focus starts on Cancel, so a
//            reflexive Enter can no longer delete something; for the rest it
//            starts on Confirm, so Enter still means "OK".
//   Tab    — kept inside the dialog (the page behind is aria-hidden by
//            aria-modal, but focus would otherwise still escape to it).
function onKeydown(e) {
  if (!dialogState.open) return;
  if (e.key === "Escape") {
    e.preventDefault();
    cancel();
    return;
  }
  if (e.key === "Tab") {
    const focusables = cardRef.value?.querySelectorAll("button:not([disabled])");
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!cardRef.value.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}

watch(
  () => dialogState.open,
  async (open) => {
    if (open) {
      previouslyFocused = document.activeElement;
      document.addEventListener("keydown", onKeydown);
      await nextTick();
      const target =
        dialogState.kind === "confirm" && dialogState.danger ? cancelBtn.value : confirmBtn.value;
      (target || confirmBtn.value)?.focus();
    } else {
      document.removeEventListener("keydown", onKeydown);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
      previouslyFocused = null;
    }
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
        <div
          ref="cardRef"
          class="modal-card glass-panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="dialogState.title ? 'modal-title' : undefined"
          aria-describedby="modal-message"
        >
          <h3 v-if="dialogState.title" id="modal-title" class="modal-title">{{ dialogState.title }}</h3>
          <p id="modal-message" class="modal-message">{{ dialogState.message }}</p>

          <div class="modal-actions">
            <button
              v-if="dialogState.kind === 'confirm'"
              ref="cancelBtn"
              class="btn btn-secondary"
              @click="cancel"
            >
              {{ dialogState.cancelText }}
            </button>
            <button
              ref="confirmBtn"
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
  white-space: pre-line; /* honour explicit \n in messages (e.g. file paths) */
  overflow-wrap: anywhere;
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
