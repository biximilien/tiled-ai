import { EditError, requireValid } from "../core/edit-protocol.mjs";
import { validateEditPlan } from "../core/edit-validation.mjs";
import { readSelectionContext } from "./map-reader.mjs";

/** @param {TileMap} map @param {TileLayer} layer */
export function requireCurrentTarget(map, layer) {
  requireValid(tiled.activeAsset === map && map.currentLayer === layer,
    "The map or selected layer changed before the edit could be applied.");
  requireValid(layer && layer.isTileLayer, "Select a tile layer first.");
  requireValid(!map.readOnly, "The active map is read-only.");
  // A locked parent group also prevents editing its children.
  for (let current = /** @type {Layer | null} */ (layer); current; current = current.parentLayer) {
    requireValid(!current.locked && !current.readOnly, "The selected layer or its parent is locked or read-only.");
  }
}

/** Validate and resolve without mutation, also used before user confirmation.
 * @param {unknown} plan @param {import('../core/edit-protocol.mjs').SelectionContext} context
 * @param {TileMap} map @param {TileLayer} layer
 */
export function validateAndResolveEditPlan(plan, context, map, layer) {
  const validated = validateEditPlan(plan, context);
  requireCurrentTarget(map, layer);
  const live = readSelectionContext(map, context.selection.width * context.selection.height);
  // Catch selection/content changes too, including newly occupied target cells.
  requireValid(JSON.stringify(live) === JSON.stringify(context),
    "The map selection or its contents changed before the edit could be applied.");

  const resolved = validated.edits.map(change => {
    const matches = map.tilesets.filter(candidate => candidate.name === change.tile.tileset);
    if (matches.length !== 1) throw new EditError(
      `The generated edit plan is invalid: ${matches.length ? "Ambiguous" : "Unknown"} tileset "${change.tile.tileset}".`,
    );
    // Tiled 1.11.2 throws for missing IDs; also guard null from other hosts.
    /** @type {Tile | null} */
    let tile;
    try {
      tile = matches[0].tile(change.tile.tileId);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Invalid tile ID") throw error;
      tile = null;
    }
    requireValid(tile && tile.id === change.tile.tileId,
      `The generated edit plan is invalid: Missing local tile ID ${change.tile.tileId} in "${change.tile.tileset}".`);
    return { x: change.x, y: change.y, tile };
  });

  requireCurrentTarget(map, layer);
  for (const change of resolved) {
    requireValid(layer.tileAt(change.x, change.y) === null,
      "A target cell is no longer empty. Inspect the selection again.");
  }
  return resolved;
}

/** Always revalidate immediately before mutation, including after confirmation.
 * @param {unknown} plan @param {import('../core/edit-protocol.mjs').SelectionContext} context
 * @param {TileMap} map @param {TileLayer} layer
 */
export function applyEditPlan(plan, context, map, layer) {
  const resolved = validateAndResolveEditPlan(plan, context, map, layer);
  if (!resolved.length) return 0;

  const edit = layer.edit();
  edit.mergeable = false;
  for (const change of resolved) edit.setTile(change.x, change.y, change.tile);
  edit.apply();
  return resolved.length;
}
