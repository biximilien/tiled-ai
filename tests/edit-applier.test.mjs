import assert from "node:assert/strict";
import test from "node:test";
import { applyEditPlan } from "../src/tiled/edit-applier.mjs";
import { readSelectionContext } from "../src/tiled/map-reader.mjs";
import { planFillEmptyCells } from "../src/core/fill-empty-planner.mjs";
import { registerActions } from "../src/tiled/actions.mjs";

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  /** @type {string[]} */
  const calls = [];
  const tile = { id: 4, tileset: { name: "terrain" } };
  /** @type {(typeof tile | null)[]} */
  const cells = [tile, null, null];
  const layer = {
    id: 3, name: "Ground", isTileLayer: true, locked: false, readOnly: false,
    parentLayer: /** @type {Layer | null} */ (null),
    /** @param {number} x */
    tileAt(x) { return cells[x - 12]; },
    edit() {
      calls.push("edit");
      /** @type {{ x: number, tile: typeof tile }[]} */
      const pending = [];
      return {
        mergeable: true,
        /** @param {number} x @param {number} y @param {typeof tile} resolved */
        setTile(x, y, resolved) {
          calls.push(`set:${x},${y}`);
          assert.equal(resolved, tile);
          pending.push({ x, tile: resolved });
        },
        apply() {
          assert.equal(this.mergeable, false);
          calls.push("apply");
          for (const change of pending) cells[change.x - 12] = change.tile;
        },
      };
    },
  };
  const tileset = {
    name: "terrain",
    /** @param {number} id */
    tile(id) { calls.push(`resolve:${id}`); return id === 4 ? tile : null; },
  };
  const selection = { x: 12, y: 8, width: 3, height: 1 };
  const data = {
    isTileMap: true, width: 100, height: 80, tileWidth: 16, tileHeight: 16,
    infinite: false, readOnly: false,
    currentLayer: layer, tilesets: [tileset],
    selectedArea: { get: () => ({ rects: [selection] }) },
  };
  const map = /** @type {TileMap} */ (/** @type {unknown} */ (data));
  const target = /** @type {TileLayer} */ (/** @type {unknown} */ (layer));
  /** @type {Map<string, { text: string, invoke: () => void }>} */
  const actions = new Map();
  /** @type {string[]} */
  const alerts = [];
  /** @type {string[]} */
  const logs = [];
  const api = {
    activeAsset: /** @type {Asset | null} */ (map),
    /** @param {string} id @param {() => void} invoke */
    registerAction(id, invoke) { const action = { text: "", invoke }; actions.set(id, action); return action; },
    extendMenu() {},
    /** @param {string} message */
    alert(message) { alerts.push(message); },
    /** @param {string} message */
    log(message) { logs.push(message); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "tiled");
  Object.defineProperty(globalThis, "tiled", { value: api, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "tiled", previous);
    else Reflect.deleteProperty(globalThis, "tiled");
  });
  const context = readSelectionContext(map);
  const plan = planFillEmptyCells(context);
  return { calls, cells, tile, layer, data, map, target, context, plan, api, selection, actions, alerts, logs };
}

test("adapter resolves everything before one edit and one apply", t => {
  const f = fixture(t);
  assert.equal(applyEditPlan(f.plan, f.context, f.map, f.target), 2);
  assert.deepEqual(f.calls, ["resolve:4", "resolve:4", "edit", "set:13,8", "set:14,8", "apply"]);
  assert.deepEqual(f.cells, [f.tile, f.tile, f.tile]);
});

test("zero-edit plans never construct or apply an edit", t => {
  const f = fixture(t);
  f.cells.fill(f.tile);
  const context = readSelectionContext(f.map);
  assert.equal(applyEditPlan(planFillEmptyCells(context), context, f.map, f.target), 0);
  assert.deepEqual(f.calls, []);
});

/** @type {[string, (f: ReturnType<typeof fixture>) => void, RegExp][]} */
const failures = [
  ["unknown tileset", f => { f.plan.edits[1].tile.tileset = "missing"; }, /Unknown tileset/],
  ["duplicate tileset name", f => { f.data.tilesets.push(f.data.tilesets[0]); }, /Ambiguous tileset/],
  ["missing local ID after a valid resolution", f => { f.plan.edits[1].tile.tileId = 99; }, /Missing local tile ID/],
  ["invalid second command", f => { f.plan.edits[1].x = 100; }, /outside/],
  ["locked layer", f => { f.layer.locked = true; }, /locked/],
  ["read-only layer", f => { f.layer.readOnly = true; }, /read-only/],
  ["read-only map", f => { f.data.readOnly = true; }, /read-only/],
  ["locked parent", f => { f.layer.parentLayer = /** @type {Layer} */ ({ locked: true }); }, /locked/],
  ["changed map", f => { f.api.activeAsset = null; }, /map or selected layer changed/],
  ["changed layer with same ID", f => { f.data.currentLayer = { ...f.layer }; }, /map or selected layer changed/],
  ["missing layer", f => { f.data.currentLayer = /** @type {typeof f.layer} */ (/** @type {unknown} */ (null)); }, /map or selected layer changed/],
  ["non-tile layer", f => { f.layer.isTileLayer = false; }, /tile layer/],
  ["changed selection", f => { f.selection.y++; }, /selection or its contents changed/],
  ["newly occupied target", f => { f.cells[1] = f.tile; }, /selection or its contents changed/],
];
for (const [name, corrupt, reason] of failures) {
  test(`adapter rejects ${name} without mutation`, t => {
    const f = fixture(t);
    corrupt(f);
    const before = [...f.cells];
    assert.throws(() => applyEditPlan(f.plan, f.context, f.map, f.target), reason);
    assert.ok(!f.calls.includes("edit"));
    assert.ok(!f.calls.includes("apply"));
    assert.deepEqual(f.cells, before);
  });
}

test("prototype action reports success, no-op, empty selection, and unexpected failure", t => {
  const f = fixture(t);
  registerActions();
  const action = f.actions.get("TiledAiFillEmptyCells");
  assert.ok(action);
  assert.equal(action.text, "AI: Fill Empty Cells (Prototype)");
  action.invoke();
  assert.equal(f.logs.pop(), "Filled 2 empty cells. Use Ctrl+Z to undo.");
  f.calls.length = 0;
  action.invoke();
  assert.equal(f.alerts.pop(), "The selected area has no empty cells.");
  assert.deepEqual(f.calls, []);
  f.cells.fill(null);
  action.invoke();
  assert.equal(f.alerts.pop(), "No source tile exists in the selection.");
  f.data.selectedArea.get = () => { throw new Error("fixture failure"); };
  assert.doesNotThrow(() => action.invoke());
  assert.match(f.logs.pop() || "", /Fill Empty Cells failed: fixture failure/);
  assert.equal(f.alerts.pop(), "Could not fill empty cells. See Tiled's Console for details.");
});
