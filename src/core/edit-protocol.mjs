/** @typedef {{ x: number, y: number, width: number, height: number }} Rectangle */
/** @typedef {{ tileset: string, tileId: number }} TileReference */
/** @typedef {{ schemaVersion: number, map: { width: number, height: number, tileWidth: number, tileHeight: number, infinite: boolean }, layer: { id: number, name: string }, selection: Rectangle, cells: (TileReference | null)[][] }} SelectionContext */
/** @typedef {{ operation: "setTile", x: number, y: number, tile: TileReference }} TileCommand */
/** @typedef {{ schemaVersion: number, target: { layerId: number, selection: Rectangle }, edits: TileCommand[] }} EditPlan */

export class EditError extends Error {}

/** @param {unknown} condition @param {string} reason @returns {asserts condition} */
export function requireValid(condition, reason) {
  if (!condition) throw new EditError(reason);
}

/** Reject extra fields and API objects instead of silently stripping them.
 * @param {unknown} value @param {string[]} keys @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
export function requireObject(value, keys, label) {
  requireValid(value !== null && typeof value === "object", `${label} must be a plain object.`);
  const prototype = Object.getPrototypeOf(value);
  requireValid(prototype === Object.prototype || prototype === null, `${label} must be a plain object.`);
  const ownKeys = Reflect.ownKeys(value);
  requireValid(ownKeys.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && descriptor.enumerable;
  }), `${label} has missing, extra, or non-data fields.`);
}

/** @param {unknown} value @param {string} label @returns {asserts value is unknown[]} */
export function requireArray(value, label) {
  requireValid(Array.isArray(value), `${label} must be an array.`);
  requireValid(Object.getPrototypeOf(value) === Array.prototype, `${label} must be a plain array.`);
  requireValid(Reflect.ownKeys(value).length === value.length + 1, `${label} must be a dense plain array.`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireValid(descriptor && "value" in descriptor && descriptor.enumerable, `${label} must contain data entries.`);
  }
}

/** @param {unknown} value @returns {value is number} */
export function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** @param {unknown} value @returns {asserts value is Rectangle} */
export function requireRectangle(value) {
  requireObject(value, ["x", "y", "width", "height"], "Selection");
  requireValid(integer(value.x) && integer(value.y) && integer(value.width) &&
    integer(value.height) && value.width > 0 && value.height > 0,
  "Selection must have integer coordinates and positive integer dimensions.");
  requireValid(integer(value.x + value.width) && integer(value.y + value.height) &&
    integer(value.width * value.height), "Selection exceeds safe integer limits.");
}

/** @param {unknown} value @returns {asserts value is TileReference} */
export function requireTileReference(value) {
  requireObject(value, ["tileset", "tileId"], "Tile reference");
  requireValid(typeof value.tileset === "string" && value.tileset.trim().length > 0,
    "Tileset name is missing.");
  requireValid(integer(value.tileId) && value.tileId >= 0, "Tile ID must be a non-negative integer.");
}

/** Validate the complete plain-data context before the planner consumes it.
 * @param {unknown} context @returns {asserts context is SelectionContext}
 */
export function requireSelectionContext(context) {
  requireObject(context, ["schemaVersion", "map", "layer", "selection", "cells"], "Context");
  requireValid(context.schemaVersion === 1, "Unsupported context schema version.");
  requireObject(context.map, ["width", "height", "tileWidth", "tileHeight", "infinite"], "Map");
  const map = context.map;
  requireValid(integer(map.width) && map.width >= 0 && integer(map.height) && map.height >= 0 &&
    integer(map.tileWidth) && map.tileWidth > 0 && integer(map.tileHeight) && map.tileHeight > 0 &&
    typeof map.infinite === "boolean", "Malformed map dimensions or infinite flag.");
  requireObject(context.layer, ["id", "name"], "Layer");
  requireValid(integer(context.layer.id) && context.layer.id >= 0 && typeof context.layer.name === "string",
    "Malformed layer identity.");
  requireRectangle(context.selection);
  requireArray(context.cells, "Cells");
  requireValid(context.cells.length === context.selection.height, "Cell matrix height does not match selection.");
  for (const row of context.cells) {
    requireArray(row, "Cell row");
    requireValid(row.length === context.selection.width, "Cell matrix width does not match selection.");
    for (const tile of row) if (tile !== null) requireTileReference(tile);
  }
}

/** @param {Rectangle} left @param {Rectangle} right */
export function sameRectangle(left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}
