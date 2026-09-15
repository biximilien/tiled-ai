/** Explicit plainText avoids Qt's HTML auto-detection for all model prose.
 * @param {string} text @param {boolean} [canApply] */
export function showPlanDialog(text, canApply = true) {
  const dialog = new Dialog("AI generation");
  // Tiled 1.11 requires the label argument despite newer optional typings.
  const body = dialog.addTextEdit("");
  body.readOnly = true;
  body.plainText = text;
  if (canApply) dialog.addButton("Apply").clicked.connect(() => dialog.accept());
  dialog.addButton(canApply ? "Cancel" : "Close").clicked.connect(() => dialog.reject());
  return dialog.exec() === Dialog.Accepted;
}
