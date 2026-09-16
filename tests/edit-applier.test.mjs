import assert from "node:assert/strict";
import test from "node:test";
import { applyEditPlan } from "../src/tiled/edit-applier.mjs";
import { readSelectionContext } from "../src/tiled/map-reader.mjs";
import { planFillEmptyCells } from "../src/core/fill-empty-planner.mjs";
import { registerActions } from "../src/tiled/actions.mjs";
import { generateFromInstruction as startFromInstruction } from "../src/tiled/generate-action.mjs";
import { checkGeneration, cancelGeneration, generationState } from "../src/tiled/job-lifecycle.mjs";
import { plannerHost } from "./helpers/planner-host.mjs";

/** @param {import('node:test').TestContext} t @param {() => boolean} decide */
function modelDialog(t, decide) {
  /** @type {{body:{readOnly:boolean,plainText:string},buttons:string[],reject:()=>void}[]} */
  const dialogs = [];
  class FakeDialog {
    static Accepted = 1;
    body = { readOnly: false, plainText: "" };
    /** @type {string[]} */ buttons = [];
    onReject = () => {};
    rejected = { connect: (/** @type {()=>void} */ callback) => { this.onReject = callback; } };
    constructor() { dialogs.push(this); }
    /** @param {string} label */
    addTextEdit(label) { assert.equal(label, ""); return this.body; }
    /** @param {string} name */
    addButton(name) { this.buttons.push(name); return { clicked: { connect() {} } }; }
    show() {}
    reject() { this.onReject(); }
    exec() { return decide() ? 1 : 0; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Dialog");
  Object.defineProperty(globalThis, "Dialog", { value: FakeDialog, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "Dialog", previous);
    else Reflect.deleteProperty(globalThis, "Dialog");
  });
  return { get body() { return dialogs[dialogs.length - 1].body; }, get buttons() { return dialogs[dialogs.length - 1].buttons; }, dialogs };
}

// Existing end-to-end assertions now explicitly collect after startup.
/** @param {string} file */
function generateFromInstruction(file) { startFromInstruction(file); checkGeneration(); }

for (const accept of [false, true]) test(`AI confirmation uses plain text and ${accept ? "applies once" : "cancels without edits"}`, t => {
  const f = fixture(t);
  const host = plannerHost(t); host.state.provider = "openai";
  f.metadata.ai_name = "grass";
  f.api.prompt = () => "Create a small pond surrounded by grass.";
  Object.defineProperty(host.state, "stdout", { get: () => JSON.stringify({ schemaVersion: 1,
    requestId: host.state.request?.requestId, plan: f.plan,
    metadata: { status: "planned", summary: "<img src='external'> & grass", reason: null } }) });
  const dialog = modelDialog(t, () => { assert.ok(!f.calls.includes("edit")); return accept; });
  generateFromInstruction("main.mjs");
  assert.equal(dialog.body.readOnly, true);
  assert.match(dialog.body.plainText, /<img src='external'> & grass/);
  assert.match(dialog.body.plainText, /2 tile edits\?\nLayer: Ground/);
  assert.deepEqual(dialog.buttons, ["Apply", "Cancel"]);
  assert.ok(host.state.request?.tileCatalog);
  assert.equal(f.calls.filter(call => call === "apply").length, accept ? 1 : 0);
  assert.doesNotThrow(() => host.collectGarbage());
});

test("AI cannot_plan displays reason as plain text and creates no edit", t => {
  const f = fixture(t); const host = plannerHost(t); host.state.provider = "openai";
  f.metadata.ai_name = "grass";
  Object.defineProperty(host.state, "stdout", { get: () => JSON.stringify({ schemaVersion: 1,
    requestId: host.state.request?.requestId, plan: { ...f.plan, edits: [] },
    metadata: { status: "cannot_plan", summary: "No plan", reason: "<b>Add water</b>" } }) });
  const dialog = modelDialog(t, () => false);
  generateFromInstruction("main.mjs");
  assert.match(dialog.body.plainText, /<b>Add water<\/b>/);
  assert.deepEqual(dialog.buttons, ["Close"]);
  assert.ok(!f.calls.includes("edit"));
});

test("AI summary approval still rechecks stale map state", t => {
  const f = fixture(t); const host = plannerHost(t); host.state.provider = "openai";
  f.metadata.ai_name = "grass";
  Object.defineProperty(host.state, "stdout", { get: () => JSON.stringify({ schemaVersion: 1,
    requestId: host.state.request?.requestId, plan: f.plan,
    metadata: { status: "planned", summary: "Grass", reason: null } }) });
  modelDialog(t, () => { f.layer.locked = true; return true; });
  generateFromInstruction("main.mjs");
  assert.match(f.alerts.pop() || "", /locked/);
  assert.ok(!f.calls.includes("edit"));
});

test("AI caps selection at 256 before reading cells or starting the child", t => {
  const f = fixture(t); const host = plannerHost(t); host.state.provider = "openai";
  f.selection.width = 257;
  f.layer.tileAt = () => { throw new Error("must not read"); };
  assert.throws(() => generateFromInstruction("main.mjs"), /256/);
  assert.deepEqual(host.events, []);
});

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  t.after(() => cancelGeneration());
  const ui = modelDialog(t, () => true);
  /** @type {string[]} */
  const calls = [];
  /** @type {Record<string, unknown>} */
  const metadata = {};
  const tile = { id: 4, tileset: { name: "terrain" }, property: (/** @type {string} */ key) => metadata[key] };
  /** @type {(typeof tile | null)[]} */
  const cells = [tile, null, null];
  const layer = {
    id: 3, name: "Ground", isTileLayer: true, locked: false, readOnly: false,
    parentLayer: /** @type {Layer | null} */ (null),
    flagsAt() { return 0; },
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
    tiles: [tile],
    /** @param {number} id */
    tile(id) { calls.push(`resolve:${id}`); return id === 4 ? tile : null; },
  };
  const selection = { x: 12, y: 8, width: 3, height: 1 };
  const data = {
    isTileMap: true, width: 100, height: 80, tileWidth: 16, tileHeight: 16,
    infinite: false, readOnly: false,
    currentLayer: layer, layers: [layer], orientation: 0, tilesets: [tileset],
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
  /** @type {string[]} */
  const confirmations = [];
  const api = {
    openAssets: [map],
    assetAboutToBeClosed: signal(), assetReloaded: signal(),
    activeAsset: /** @type {Asset | null} */ (map),
    /** @param {string} id @param {() => void} invoke */
    registerAction(id, invoke) { const action = { text: "", invoke }; actions.set(id, action); return action; },
    extendMenu() {},
    /** @param {string} message */
    alert(message) { alerts.push(message); },
    /** @param {string} message */
    log(message) { logs.push(message); },
    prompt() { return "fill empty cells"; },
    /** @param {string} text */
    confirm(text) { confirmations.push(text); return true; },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "tiled");
  Object.defineProperty(globalThis, "tiled", { value: api, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "tiled", previous);
    else Reflect.deleteProperty(globalThis, "tiled");
  });
  const context = readSelectionContext(map);
  const plan = planFillEmptyCells(context);
  return { calls, cells, tile, layer, data, map, target, context, plan, api, selection, actions, alerts, logs, confirmations, metadata, ui };
}

function signal() {
  /** @type {Set<(asset: Asset)=>void>} */ const callbacks = new Set();
  return { connect: (/** @type {(asset:Asset)=>void} */ cb) => callbacks.add(cb),
    disconnect: (/** @type {(asset:Asset)=>void} */ cb) => callbacks.delete(cb),
    emit: (/** @type {Asset} */ asset) => { for (const cb of callbacks) cb(asset); } };
}

test("nonblocking Generate rejects concurrency; X cancels, late callbacks cannot cancel the next job", t => {
  const f = fixture(t); const host = plannerHost(t); host.state.waits = [false, true];
  startFromInstruction("main.mjs");
  assert.deepEqual(host.events, ["start", "write", "stdin-close"]);
  assert.equal(generationState(), "running");
  assert.throws(() => startFromInstruction("main.mjs"), /already running/);
  checkGeneration(); assert.equal(generationState(), "running");
  assert.match(f.ui.body.plainText, /still working/);
  const old = f.ui.dialogs[0]; old.reject(); old.reject();
  assert.equal(generationState(), "idle");
  assert.equal(host.events.filter(event => event === "terminate").length, 1);
  assert.ok(!f.calls.includes("edit"));
  startFromInstruction("main.mjs"); old.reject(); assert.equal(generationState(), "running");
  cancelGeneration(); assert.equal(generationState(), "idle");
});

test("selection, active layer, layer name and outside cell changes do not invalidate captured work", t => {
  const f = fixture(t); plannerHost(t);
  startFromInstruction("main.mjs");
  f.selection.x = 500; f.layer.name = "Renamed";
  f.cells[100] = f.tile; // outside captured x=12..14
  f.data.currentLayer = Object.assign({}, f.layer, { id: 8 });
  checkGeneration();
  assert.equal(generationState(), "idle");
  assert.equal(f.calls.filter(call => call === "apply").length, 1);
  assert.deepEqual(f.cells.slice(0, 3), [f.tile, f.tile, f.tile]);
});

test("switching maps retains ready result and asks user to return without switching", t => {
  const f = fixture(t); plannerHost(t);
  startFromInstruction("main.mjs"); f.api.activeAsset = null;
  checkGeneration(); assert.equal(generationState(), "ready");
  assert.match(f.ui.body.plainText, /Return to the original map/);
  assert.equal(f.api.activeAsset, null); assert.ok(!f.calls.includes("edit"));
  f.api.activeAsset = f.map; checkGeneration();
  assert.equal(generationState(), "idle"); assert.ok(f.calls.includes("apply"));
});

/** @type {[string, (f:ReturnType<typeof fixture>)=>void][]} */
const staleChanges = [
  ["region tile", f => { f.cells[1] = f.tile; }],
  ["transform", f => { f.layer.flagsAt = () => 1; }],
  ["orientation", f => { f.data.orientation = 1; }],
  ["tile dimensions", f => { f.data.tileWidth = 32; }],
  ["layer deletion", f => { f.data.layers.length = 0; }],
  ["replacement layer with same ID", f => { f.data.layers[0] = Object.assign({}, f.layer); }],
  ["catalog metadata", f => { f.metadata.ai_description = "Changed"; }],
  ["semantic resolution", f => { f.tile.id = 5; }],
];
for (const [name, change] of staleChanges) test(`completed result rejects changed ${name}`, t => {
  const f = fixture(t); plannerHost(t);
  f.metadata.ai_name = "grass"; f.api.prompt = () => "fill empty with grass";
  startFromInstruction("main.mjs"); change(f); checkGeneration();
  assert.equal(generationState(), "stale"); assert.ok(!f.calls.includes("edit"));
  assert.match(f.ui.body.plainText, /not changed/);
  cancelGeneration(); assert.equal(generationState(), "idle");
});

for (const event of ["assetAboutToBeClosed", "assetReloaded"]) test(`target ${event} cancels once; switching/saving needs no cancellation`, t => {
  const f = fixture(t); const host = plannerHost(t);
  startFromInstruction("main.mjs");
  f.api[/** @type {'assetAboutToBeClosed'|'assetReloaded'} */ (event)].emit(f.map);
  assert.equal(generationState(), "idle"); assert.equal(host.events.filter(e => e === "terminate").length, 1);
  assert.ok(!f.calls.includes("edit"));
  checkGeneration(); cancelGeneration(); assert.equal(generationState(), "idle");
});

test("context changes while ready on another map are rechecked before review", t => {
  const f = fixture(t); plannerHost(t); startFromInstruction("main.mjs");
  f.api.activeAsset = null; checkGeneration(); assert.equal(generationState(), "ready");
  f.cells[1] = f.tile; f.api.activeAsset = f.map; checkGeneration();
  assert.equal(generationState(), "idle"); assert.ok(!f.calls.includes("edit"));
  assert.match(f.alerts.pop() || "", /target area or catalog changed/);
});

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
  ["Tiled 1.11.2 missing-ID exception", f => {
    f.data.tilesets[0].tile = () => { throw new Error("Invalid tile ID"); };
  }, /Missing local tile ID/],
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

test("Generate validates, confirms the count, then applies once", t => {
  const f = fixture(t);
  const host = plannerHost(t);
  registerActions("extension/main.mjs");
  const action = f.actions.get("TiledAiGenerate");
  assert.ok(action);
  assert.equal(action.text, "AI: Generate… (Prototype)");
  action.invoke();
  assert.equal(generationState(), "running");
  assert.equal(f.calls.filter(call => call === "apply").length, 0);
  checkGeneration();
  assert.deepEqual(f.confirmations, ["Apply 2 tile edits?"]);
  assert.equal(f.calls.filter(call => call === "apply").length, 1);
  host.collectGarbage();
  assert.equal(host.events[host.events.length - 1], "close");
  assert.equal(f.logs.pop(), "Applied 2 tile edits. Use Ctrl+Z to undo.");
});

test("Generate cancels blank prompts before process startup", t => {
  const f = fixture(t);
  const { events } = plannerHost(t);
  f.api.prompt = () => "   ";
  generateFromInstruction("main.mjs");
  assert.deepEqual(events, []);
  assert.deepEqual(f.calls, []);
});

test("Generate decline and noop never create an edit", t => {
  const f = fixture(t);
  plannerHost(t);
  f.api.confirm = () => false;
  generateFromInstruction("main.mjs");
  assert.ok(!f.calls.includes("edit"));
  f.api.prompt = () => "noop";
  f.api.confirm = () => { throw new Error("noop must not confirm"); };
  generateFromInstruction("main.mjs");
  assert.equal(f.logs.pop(), "No changes were proposed.");
  assert.ok(!f.calls.includes("edit"));
});

test("Generate rejects stale state before confirmation and again after approval", t => {
  const f = fixture(t);
  plannerHost(t);
  f.api.prompt = () => { f.api.activeAsset = null; return "fill empty"; };
  assert.throws(() => generateFromInstruction("main.mjs"), /map or selected layer changed/);
  assert.deepEqual(f.confirmations, []);
  f.api.activeAsset = f.map;
  f.api.prompt = () => "fill empty";
  f.api.confirm = () => { f.cells[1] = f.tile; return true; };
  generateFromInstruction("main.mjs");
  assert.match(f.alerts.pop() || "", /target area or catalog changed/);
  assert.ok(!f.calls.includes("edit"));
});

test("Generate refuses an invalid tile reference before confirmation", t => {
  const f = fixture(t);
  const { state } = plannerHost(t);
  f.data.tilesets.length = 0;
  generateFromInstruction("main.mjs");
  assert.match(f.alerts.pop() || "", /Unknown tileset/);
  assert.ok(state.request);
  assert.deepEqual(f.confirmations, []);
  assert.ok(!f.calls.includes("edit"));
});

test("Generate caps selection before reading cells or prompting", t => {
  const f = fixture(t);
  const { events } = plannerHost(t);
  f.selection.width = 4097;
  f.layer.tileAt = () => { throw new Error("should not read cells"); };
  assert.throws(() => generateFromInstruction("main.mjs"), /4,096/);
  assert.deepEqual(events, []);
});

test("semantic Generate includes catalog only, validates and confirms ordinary edits", t => {
  const f = fixture(t);
  const host = plannerHost(t);
  f.metadata.ai_name = " Grass ";
  f.metadata.ai_tags = "ground, outdoor";
  f.api.prompt = () => "fill empty with terrain:grass";
  generateFromInstruction("main.mjs");
  assert.ok(host.state.request);
  assert.deepEqual(host.state.request.tileCatalog, {
    schemaVersion: 1, tilesets: [{ name: "terrain", tiles: [{ tileId: 4, name: "Grass", tags: ["ground", "outdoor"] }] }],
  });
  assert.ok(!("diagnostics" in host.state.request));
  assert.deepEqual(f.confirmations, ["Apply 2 tile edits?"]);
  assert.equal(f.calls.filter(call => call === "apply").length, 1);
});

test("bad metadata blocks semantic startup but does not break old commands", t => {
  const f = fixture(t);
  const host = plannerHost(t);
  f.metadata.ai_name = "Grass";
  f.metadata.ai_tags = 42;
  f.api.prompt = () => "fill empty with grass";
  assert.throws(() => generateFromInstruction("main.mjs"), /terrain tile 4 ai_tags/);
  assert.deepEqual(host.events, []);
  assert.deepEqual(f.confirmations, []);
  f.api.prompt = () => "noop";
  generateFromInstruction("main.mjs");
  assert.ok(host.state.request);
  assert.ok(!("tileCatalog" in host.state.request));
  assert.ok(!f.calls.includes("edit"));
});

test("catalog inspection logs JSON and counts without edits, and explains an empty catalog", t => {
  const f = fixture(t);
  registerActions("main.mjs");
  const action = f.actions.get("TiledAiInspectTileCatalog");
  assert.ok(action);
  action.invoke();
  assert.match(f.logs[0], /Add a string ai_name/);
  f.logs.length = 0;
  f.metadata.ai_name = "Grass";
  action.invoke();
  assert.equal(JSON.parse(f.logs[0]).tilesets[0].tiles[0].name, "Grass");
  assert.match(f.logs[1], /Catalogued 1 tiles from 1 tilesets. Ignored 0/);
  assert.deepEqual(f.calls, []);
});
