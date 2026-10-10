/** @param {()=>void} apply @param {()=>void} discard @param {()=>void} regenerate @param {()=>void} refresh */
export function reviewDialog(apply, discard, regenerate, refresh) {
  const dialog = new Dialog("AI tile review");
  const body = dialog.addTextEdit(""); body.readOnly = true;
  const applyButton = dialog.addButton("Apply (Enter over map)");
  const discardButton = dialog.addButton("Discard");
  const regenerateButton = dialog.addButton("Regenerate");
  const refreshButton = dialog.addButton("Review Status");
  let closed = false;
  applyButton.clicked.connect(() => { if (!closed) apply(); });
  discardButton.clicked.connect(() => { if (!closed) discard(); });
  regenerateButton.clicked.connect(() => { if (!closed) regenerate(); });
  refreshButton.clicked.connect(() => { if (!closed) refresh(); });
  dialog.rejected.connect(() => { if (!closed) discard(); });
  return {
    /** @param {string} text @param {boolean} visible @param {boolean} [canRegenerate] */
    render(text, visible, canRegenerate = true) { body.plainText = text; applyButton.enabled = visible; regenerateButton.enabled = canRegenerate; },
    show() { dialog.show(); },
    close() { if (!closed) { closed = true; dialog.reject(); } },
  };
}
