import { EditError, requireSelectionContext } from "./edit-protocol.mjs";

/** @param {unknown} context @returns {import('./edit-protocol.mjs').EditPlan} */
export function planFillEmptyCells(context) {
  requireSelectionContext(context);
  /** @type {Map<string, { tile: import('./edit-protocol.mjs').TileReference, count: number }>} */
  const counts = new Map();
  for (const row of context.cells) {
    for (const tile of row) {
      if (tile === null) continue;
      const key = JSON.stringify([tile.tileset, tile.tileId]);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { tile, count: 1 });
    }
  }
  // Ties use lexicographic (UTF-16, locale-independent) name, then numeric ID.
  const candidates = [...counts.values()].sort((a, b) =>
    b.count - a.count ||
    (a.tile.tileset < b.tile.tileset ? -1 : a.tile.tileset > b.tile.tileset ? 1 : 0) ||
    a.tile.tileId - b.tile.tileId);
  if (!candidates.length) throw new EditError("No source tile exists in the selection.");

  /** @type {import('./edit-protocol.mjs').EditPlan} */
  const plan = {
    schemaVersion: 1,
    target: { layerId: context.layer.id, selection: { ...context.selection } },
    edits: [],
  };
  const source = candidates[0].tile;
  context.cells.forEach((row, y) => row.forEach((tile, x) => {
    if (tile === null) plan.edits.push({
      operation: "setTile",
      x: context.selection.x + x,
      y: context.selection.y + y,
      tile: { ...source },
    });
  }));
  return plan;
}
