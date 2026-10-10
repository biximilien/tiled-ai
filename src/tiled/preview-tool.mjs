/** Manual toolbar activation works on Tiled 1.11. Do not use 1.12's selectedTool setter. */
/** @type {Tool|null} */ let tool = null;
let active = false;
let inside = false;
let refresh = () => {};
let discard = () => {};
let apply = () => {};

export function registerPreviewTool() {
  if (tool) return;
  tool = tiled.registerTool("TiledAiPreview", {
    name: "AI Preview", icon: "tiled-ai/preview.svg", usesSelectedTiles: true, usesWangSets: true,
    activated() { active = true; refresh(); },
    deactivated() { active = false; inside = false; clearPreview(); refresh(); },
    mapChanged() { inside = false; clearPreview(); refresh(); },
    updateEnabledState() { this.enabled = Boolean(this.map); refresh(); },
    mouseEntered() { inside = true; refresh(); },
    mouseLeft() { inside = false; clearPreview(); refresh(); },
    // No cursor-coordinate translation and no painting in any mouse handler.
    mousePressed() { refresh(); }, mouseReleased() {}, mouseDoubleClicked() {},
    keyPressed(key) {
      // Qt::Key enum values; the bundled typings omit these runtime constants.
      if (key === 0x01000000) discard();
      else if (key === 0x01000004 || key === 0x01000005) apply();
    },
  });
}

/** @param {TileMap} map */
export function previewToolActive(map) { return active && inside && tool !== null && tool.map === map; }
/** @param {TileMap} map */
export function showPreview(map) {
  if (!tool || !active) throw new Error("Select the AI Preview toolbar tool first.");
  tool.preview = map;
}
export function clearPreview() { if (tool) tool.preview = new TileMap(); }

/** Binding token prevents old callbacks/cleanup from affecting a newer review.
 * @param {()=>void} onRefresh @param {()=>void} onDiscard @param {()=>void} onApply */
export function bindPreviewTool(onRefresh, onDiscard, onApply) {
  registerPreviewTool();
  refresh = onRefresh; discard = onDiscard; apply = onApply;
  return () => {
    if (refresh !== onRefresh) return;
    refresh = () => {}; discard = () => {}; apply = () => {}; clearPreview();
  };
}
