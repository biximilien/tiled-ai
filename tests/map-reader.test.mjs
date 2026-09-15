import assert from "node:assert/strict";
import test from "node:test";
import { readSelectionContext, SelectionError } from "../src/tiled/map-reader.mjs";
import { registerActions } from "../src/tiled/actions.mjs";

/** @param {number} [x] @param {number} [y] */
function fixture(x = 12, y = 8) {
  const rectangles = [{ x, y, width: 3, height: 3 }];
  const tiles = [
    [{ id: 4, tileset: { name: "terrain" } }, null, { id: 0, tileset: { name: "props" } }],
    [null, { id: 9, tileset: { name: "terrain" } }, null],
    [null, null, null],
  ];
  const layer = Object.freeze({
    id: 3,
    name: "Ground",
    isTileLayer: true,
    /** @param {number} column @param {number} row */
    tileAt(column, row) {
      assert.ok(column >= x && column < x + 3);
      assert.ok(row >= y && row < y + 3);
      return tiles[row - y][column - x];
    },
  });
  const data = {
    isTileMap: true,
    width: 100,
    height: 80,
    tileWidth: 16,
    tileHeight: 16,
    infinite: x < 0 || y < 0,
    currentLayer: layer,
    selectedArea: { get: () => ({ rects: rectangles }) },
  };
  // Only the API members read by the adapter are needed in these fixtures.
  const map = /** @type {TileMap} */ (/** @type {unknown} */ (data));
  return { map, data, rectangles };
}

test("serializes a dense 3 x 3 selection with local IDs and empty cells", () => {
  const { map, data } = fixture();
  const before = JSON.stringify(data);
  Object.freeze(data);
  const context = readSelectionContext(map);
  assert.deepEqual(context, {
    schemaVersion: 1,
    map: { width: 100, height: 80, tileWidth: 16, tileHeight: 16, infinite: false },
    layer: { id: 3, name: "Ground" },
    selection: { x: 12, y: 8, width: 3, height: 3 },
    cells: [
      [{ tileset: "terrain", tileId: 4 }, null, { tileset: "props", tileId: 0 }],
      [null, { tileset: "terrain", tileId: 9 }, null],
      [null, null, null],
    ],
  });
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
  assert.deepEqual(readSelectionContext(map), context);
});

test("preserves negative tile coordinates on an infinite map", () => {
  const { map } = fixture(-4, -2);
  const context = readSelectionContext(map);
  assert.equal(context.map.infinite, true);
  assert.deepEqual(context.selection, { x: -4, y: -2, width: 3, height: 3 });
  assert.deepEqual(context.cells[0][0], { tileset: "terrain", tileId: 4 });
});

test("rejects an empty selection, including a zero-sized rectangle", () => {
  const { map, rectangles } = fixture();
  rectangles.length = 0;
  assert.throws(() => readSelectionContext(map), {
    constructor: SelectionError, message: "Select a rectangular tile area first.",
  });
  rectangles.push({ x: 0, y: 0, width: 0, height: 3 });
  assert.throws(() => readSelectionContext(map), SelectionError);
});

test("rejects multiple rectangles rather than reading their bounding box", () => {
  const { map, rectangles } = fixture();
  rectangles.push({ x: 30, y: 20, width: 1, height: 1 });
  assert.throws(() => readSelectionContext(map), {
    constructor: SelectionError,
    message: "Iteration 1 supports a single rectangular selection only.",
  });
});

test("rejects missing maps and missing or non-tile layers", () => {
  for (const asset of [null, { isTileMap: false }]) {
    assert.throws(() => readSelectionContext(/** @type {Asset | null} */ (asset)), {
      constructor: SelectionError, message: "Open a tile map first.",
    });
  }
  for (const currentLayer of [null, { isTileLayer: false }]) {
    const data = { ...fixture().data, currentLayer };
    const map = /** @type {TileMap} */ (/** @type {unknown} */ (data));
    assert.throws(() => readSelectionContext(map), {
      constructor: SelectionError, message: "Select a tile layer first.",
    });
  }
});

test("action registers beside Hello, logs JSON, and reports failures cleanly", (t) => {
  /** @type {Map<string, { text: string, invoke: () => void }>} */
  const actions = new Map();
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const alerts = [];
  /** @type {{ menu: string, items: { action: string }[] }[]} */
  const menus = [];
  const api = {
    activeAsset: /** @type {Asset | null} */ (fixture().map),
    /** @param {string} id @param {() => void} invoke */
    registerAction(id, invoke) {
      const action = { text: "", invoke };
      actions.set(id, action);
      return action;
    },
    /** @param {string} menu @param {{ action: string }[]} items */
    extendMenu(menu, items) { menus.push({ menu, items }); },
    /** @param {string} text */
    log(text) { logs.push(text); },
    /** @param {string} text */
    alert(text) { alerts.push(text); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "tiled");
  Object.defineProperty(globalThis, "tiled", { value: api, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "tiled", previous);
    else Reflect.deleteProperty(globalThis, "tiled");
  });

  registerActions();
  assert.deepEqual(menus, [{ menu: "Map", items: [
    { action: "TiledAiHello" }, { action: "TiledAiInspectSelection" },
    { action: "TiledAiFillEmptyCells" },
  ] }]);
  const action = actions.get("TiledAiInspectSelection");
  assert.ok(action);
  assert.equal(action.text, "AI: Inspect Selection");
  action.invoke();
  assert.equal(logs[0], JSON.stringify(readSelectionContext(api.activeAsset), null, 2));
  assert.equal(alerts.length, 0);

  api.activeAsset = null;
  assert.doesNotThrow(() => action.invoke());
  assert.equal(alerts.pop(), "Open a tile map first.");
  assert.equal(logs.length, 1);

  const broken = fixture();
  broken.data.selectedArea.get = () => { throw new Error("fixture read failure"); };
  api.activeAsset = broken.map;
  assert.doesNotThrow(() => action.invoke());
  assert.match(logs[1], /Tiled AI: Inspect Selection failed:.*fixture read failure/);
  assert.equal(alerts.pop(), "Could not inspect the selection. See Tiled's Console for details.");
});
