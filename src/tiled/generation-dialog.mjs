/** Non-modal status UI only. Every callback belongs to one session.
 * @param {() => void} check @param {() => void} cancel */
export function generationDialog(check, cancel) {
  const dialog = new Dialog("AI Generation");
  const body = dialog.addTextEdit("");
  body.readOnly = true;
  const checkButton = dialog.addButton("Check Status");
  const cancelButton = dialog.addButton("Cancel");
  let closing = false;
  checkButton.clicked.connect(() => { if (!closing) check(); });
  cancelButton.clicked.connect(() => { if (!closing) cancel(); });
  dialog.rejected.connect(() => { if (!closing) cancel(); });
  return {
    /** @param {string} text @param {string|null} [checkText] @param {string} [cancelText] */
    render(text, checkText = "Check Status", cancelText = "Cancel") {
      body.plainText = text;
      checkButton.enabled = checkText !== null;
      checkButton.text = checkText || "Check Status";
      cancelButton.text = cancelText;
      cancelButton.enabled = true;
    },
    collecting() { body.plainText = "Collecting and validating the result…"; checkButton.enabled = false; cancelButton.enabled = false; },
    show() { dialog.show(); },
    close() { if (closing) return; closing = true; dialog.reject(); },
  };
}
