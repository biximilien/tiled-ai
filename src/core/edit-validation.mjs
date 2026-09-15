import {
  EditError, integer, requireArray, requireObject, requireRectangle,
  requireSelectionContext, requireTileReference, requireValid, sameRectangle,
} from "./edit-protocol.mjs";

/** Validate the entire command list and return an independent plain-data copy.
 * Tile existence and current editor state are checked by the Tiled adapter.
 * @param {unknown} plan @param {unknown} context
 * @returns {import('./edit-protocol.mjs').EditPlan}
 */
export function validateEditPlan(plan, context) {
  try {
    requireSelectionContext(context);
    requireObject(plan, ["schemaVersion", "target", "edits"], "Plan");
    requireValid(plan.schemaVersion === 1, "Unsupported plan schema version.");
    requireObject(plan.target, ["layerId", "selection"], "Target");
    requireValid(plan.target.layerId === context.layer.id, "Target layer ID differs from inspected layer.");
    requireRectangle(plan.target.selection);
    requireValid(sameRectangle(plan.target.selection, context.selection), "Target selection differs from inspected selection.");
    requireArray(plan.edits, "Edits");
    const { x, y, width, height } = context.selection;
    requireValid(plan.edits.length <= width * height, "Edit count exceeds selected area.");
    const seen = new Set();
    /** @type {import('./edit-protocol.mjs').TileCommand[]} */
    const edits = [];
    for (const edit of plan.edits) {
      requireObject(edit, ["operation", "x", "y", "tile"], "Edit");
      requireValid(edit.operation === "setTile", "Unsupported operation.");
      requireValid(integer(edit.x) && integer(edit.y), "Edit coordinates must be integers.");
      requireValid(edit.x >= x && edit.x < x + width && edit.y >= y && edit.y < y + height,
        "Edit coordinate lies outside the selection.");
      const key = `${edit.x},${edit.y}`;
      requireValid(!seen.has(key), "Duplicate edit coordinate.");
      seen.add(key);
      requireValid(context.cells[edit.y - y][edit.x - x] === null, "Edit targets an originally populated cell.");
      requireTileReference(edit.tile);
      edits.push({
        operation: "setTile", x: edit.x, y: edit.y,
        tile: { tileset: edit.tile.tileset, tileId: edit.tile.tileId },
      });
    }
    return {
      schemaVersion: 1,
      target: { layerId: context.layer.id, selection: { x, y, width, height } },
      edits,
    };
  } catch (error) {
    if (error instanceof EditError) throw new EditError(`The generated edit plan is invalid: ${error.message}`);
    throw error;
  }
}
