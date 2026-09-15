import { isTileMapAsset } from "../core/validation.mjs";

// Distinguish actionable editor-state errors from unexpected API failures.
export class SelectionError extends Error {}

/**
 * Read one rectangular selection into plain data without modifying the map.
 * @param {Asset | null} asset
 */
export function readSelectionContext(asset) {
  if (!isTileMapAsset(asset)) {
    throw new SelectionError("Open a tile map first.");
  }

  const map = /** @type {TileMap} */ (asset);
  const currentLayer = map.currentLayer;
  // currentLayer can be absent at runtime, despite its non-nullable typings.
  if (!currentLayer || !currentLayer.isTileLayer) {
    throw new SelectionError("Select a tile layer first.");
  }

  const rectangles = map.selectedArea.get().rects;
  if (rectangles.length === 0) {
    throw new SelectionError("Select a rectangular tile area first.");
  }
  if (rectangles.length !== 1) {
    throw new SelectionError(
      "Iteration 1 supports a single rectangular selection only.",
    );
  }

  const { x, y, width, height } = rectangles[0];
  if (width <= 0 || height <= 0) {
    throw new SelectionError("Select a rectangular tile area first.");
  }

  const layer = /** @type {TileLayer} */ (currentLayer);
  const cells = [];
  for (let row = 0; row < height; row++) {
    const entries = [];
    for (let column = 0; column < width; column++) {
      const tile = layer.tileAt(x + column, y + row);
      // Flip/rotation flags are intentionally omitted from schema version 1.
      entries.push(tile ? { tileset: tile.tileset.name, tileId: tile.id } : null);
    }
    cells.push(entries);
  }

  return {
    schemaVersion: 1,
    map: {
      width: map.width,
      height: map.height,
      tileWidth: map.tileWidth,
      tileHeight: map.tileHeight,
      infinite: map.infinite,
    },
    layer: { id: layer.id, name: layer.name },
    selection: { x, y, width, height },
    cells,
  };
}
