import { isTileMapAsset } from "../core/validation.mjs";

// Distinguish actionable editor-state errors from unexpected API failures.
export class SelectionError extends Error {}

/**
 * Read one rectangular selection into plain data without modifying the map.
 * @param {Asset | null} asset
 * @param {number} [maxCells] Optional cap checked before reading cells.
 */
export function readSelectionContext(asset, maxCells = Infinity) {
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
  if (!Number.isSafeInteger(width * height) || width * height > maxCells) {
    throw new SelectionError(`Select at most ${maxCells.toLocaleString("en-US")} cells.`);
  }

  return readRegionContext(map, /** @type {TileLayer} */ (currentLayer), { x, y, width, height });
}

/** Read captured coordinates independently of current layer/selection.
 * @param {TileMap} map @param {TileLayer} layer
 * @param {import('../core/edit-protocol.mjs').Rectangle} region */
export function readRegionContext(map, layer, region) {
  const { x, y, width, height } = region;
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
