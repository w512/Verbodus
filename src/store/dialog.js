// Unified dialog system — replaces native alert()/confirm() with a single
// themed modal driven by an imperative, promise-based API.
//
//   if (await confirmDialog({ title, message, danger: true })) { ... }
//   await alertDialog({ title, message });
//
// A single <ModalDialog /> (mounted once in App.vue) renders whatever is in
// `dialogState`; resolveDialog() closes it and settles the pending promise.

import { reactive } from "vue";

export const dialogState = reactive({
  open: false,
  kind: "confirm", // 'confirm' | 'alert'
  title: "",
  message: "",
  confirmText: "Confirm",
  cancelText: "Cancel",
  danger: false,
  _resolve: null,
});

function show(opts) {
  // Settle any dialog still pending before opening a new one.
  if (dialogState._resolve) resolveDialog(false);
  return new Promise((resolve) => {
    dialogState.open = true;
    dialogState.kind = opts.kind || "confirm";
    dialogState.title = opts.title || "";
    dialogState.message = opts.message || "";
    dialogState.danger = !!opts.danger;
    dialogState.confirmText = opts.confirmText || (opts.kind === "alert" ? "OK" : "Confirm");
    dialogState.cancelText = opts.cancelText || "Cancel";
    dialogState._resolve = resolve;
  });
}

export function confirmDialog(opts) {
  return show({ ...opts, kind: "confirm" });
}

export function alertDialog(opts) {
  return show({ ...opts, kind: "alert" });
}

// Closes the dialog and resolves the pending promise with the given result
// (true = confirmed, false = cancelled/dismissed).
export function resolveDialog(result) {
  const resolve = dialogState._resolve;
  dialogState.open = false;
  dialogState._resolve = null;
  if (resolve) resolve(result);
}
