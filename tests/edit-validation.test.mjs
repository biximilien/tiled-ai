import assert from "node:assert/strict";
import test from "node:test";
import { planFillEmptyCells } from "../src/core/fill-empty-planner.mjs";
import { validateEditPlan } from "../src/core/edit-validation.mjs";
import { EditError } from "../src/core/edit-protocol.mjs";

const terrain = { tileset: "terrain", tileId: 4 };
const props = { tileset: "props", tileId: 4 };

/** @param {(import('../src/core/edit-protocol.mjs').TileReference | null)[][]} [cells]
 * @param {number} [x] @param {number} [y]
 * @returns {import('../src/core/edit-protocol.mjs').SelectionContext}
 */
function context(cells = [[terrain, null, null]], x = 12, y = 8) {
  return {
    schemaVersion: 1,
    map: { width: 100, height: 80, tileWidth: 16, tileHeight: 16, infinite: x < 0 || y < 0 },
    layer: { id: 3, name: "Ground" },
    selection: { x, y, width: cells[0].length, height: cells.length },
    cells,
  };
}

test("planner fills only empty cells with absolute coordinates and independent plain data", () => {
  for (const [x, y] of [[12, 8], [-4, -2], [0, 0]]) {
    const input = context([[terrain, null], [null, terrain]], x, y);
    const before = structuredClone(input);
    const plan = planFillEmptyCells(input);
    assert.deepEqual(plan, {
      schemaVersion: 1,
      target: { layerId: 3, selection: { x, y, width: 2, height: 2 } },
      edits: [
        { operation: "setTile", x: x + 1, y, tile: terrain },
        { operation: "setTile", x, y: y + 1, tile: terrain },
      ],
    });
    assert.deepEqual(planFillEmptyCells(input), plan);
    assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
    assert.deepEqual(input, before);
    plan.edits[0].tile.tileId = 99;
    plan.target.selection.x = 900;
    assert.deepEqual(input, before);
    assert.equal(plan.edits[1].tile.tileId, 4);
  }
});

test("frequency counts tileset and local ID as a pair", () => {
  const plan = planFillEmptyCells(context([[props, terrain, terrain, null]]));
  assert.deepEqual(plan.edits[0].tile, terrain);
});

test("ties use lexicographic tileset then numeric ID independent of encounter order", () => {
  const lowerId = { tileset: "props", tileId: 2 };
  for (const row of [[terrain, props, lowerId, null], [lowerId, props, terrain, null]]) {
    assert.deepEqual(planFillEmptyCells(context([row])).edits[0].tile, lowerId);
  }
  assert.deepEqual(planFillEmptyCells(context([[terrain, props, null]])).edits[0].tile, props);
});

test("full selections are no-ops and entirely empty selections have a domain error", () => {
  assert.deepEqual(planFillEmptyCells(context([[terrain, props]])).edits, []);
  assert.throws(() => planFillEmptyCells(context([[null, null]])), {
    constructor: EditError, message: "No source tile exists in the selection.",
  });
});

test("planner rejects malformed contexts rather than guessing", () => {
  const good = context();
  for (const bad of [
    null, {}, { ...good, schemaVersion: 2 },
    { ...good, cells: [[terrain]] }, { ...good, cells: [new Array(3)] },
    { ...good, cells: [[terrain, undefined, null]] },
    { ...good, cells: [[{ tileset: "terrain", tileId: 1.5 }, null, null]] },
    { ...good, cells: [[{ ...terrain, fileName: "C:/map.tmx" }, null, null]] },
    { ...good, selection: { ...good.selection, width: 0 } },
    { ...good, map: { ...good.map, tileWidth: "16" } },
  ]) assert.throws(() => planFillEmptyCells(bad), EditError);
});

test("valid plan passes as an independent normalized copy", () => {
  const input = context();
  const plan = planFillEmptyCells(input);
  const validated = validateEditPlan(plan, input);
  assert.deepEqual(validated, plan);
  plan.edits[0].tile.tileId = 99;
  assert.equal(validated.edits[0].tile.tileId, 4);
});

/** @type {[string, (plan: import('../src/core/edit-protocol.mjs').EditPlan) => unknown, RegExp][]} */
const invalidPlans = [
  ["missing envelope", () => null, /plain object/],
  ["API-like envelope", p => Object.assign(new Date(), p), /plain object/],
  ["unsupported schema", p => ({ ...p, schemaVersion: 2 }), /schema/],
  ["missing target", p => ({ ...p, target: null }), /plain object/],
  ["malformed selection", p => ({ ...p, target: { ...p.target, selection: [] } }), /plain object/],
  ["wrong layer", p => ({ ...p, target: { ...p.target, layerId: 8 } }), /layer ID/],
  ["changed selection", p => ({ ...p, target: { ...p.target, selection: { ...p.target.selection, x: 0 } } }), /selection/],
  ["missing edit array", p => ({ ...p, edits: {} }), /array/],
  ["unknown operation", p => ({ ...p, edits: [{ ...p.edits[0], operation: "delete" }] }), /operation/],
  ["fractional x", p => ({ ...p, edits: [{ ...p.edits[0], x: 13.5 }] }), /integers/],
  ["string y", p => ({ ...p, edits: [{ ...p.edits[0], y: "8" }] }), /integers/],
  ["unsafe coordinate", p => ({ ...p, edits: [{ ...p.edits[0], x: Infinity }] }), /integers/],
  ["outside selection", p => ({ ...p, edits: [{ ...p.edits[0], x: 15 }] }), /outside/],
  ["duplicate coordinate", p => ({ ...p, edits: [p.edits[0], p.edits[0]] }), /Duplicate/],
  ["occupied cell", p => ({ ...p, edits: [{ ...p.edits[0], x: 12 }] }), /populated/],
  ["too many edits", p => ({ ...p, edits: Array(4).fill(p.edits[0]) }), /count/],
  ["fractional tile ID", p => ({ ...p, edits: [{ ...p.edits[0], tile: { ...terrain, tileId: 2.5 } }] }), /Tile ID/],
  ["negative tile ID", p => ({ ...p, edits: [{ ...p.edits[0], tile: { ...terrain, tileId: -1 } }] }), /Tile ID/],
  ["missing tileset name", p => ({ ...p, edits: [{ ...p.edits[0], tile: { ...terrain, tileset: "" } }] }), /name/],
  ["extra file path", p => ({ ...p, fileName: "C:/map.tmx" }), /fields/],
  ["extra function", p => ({ ...p, edits: [{ ...p.edits[0], execute() {} }] }), /fields/],
  ["tile object", p => ({ ...p, edits: [{ ...p.edits[0], tile: new Date() }] }), /plain object/],
  ["sparse edits", p => ({ ...p, edits: new Array(1) }), /dense/],
];
for (const [name, corrupt, reason] of invalidPlans) {
  test(`validator rejects ${name}`, () => {
    const input = context();
    assert.throws(() => validateEditPlan(corrupt(planFillEmptyCells(input)), input), reason);
  });
}

test("validator rejects accessor fields without executing them", () => {
  const plan = planFillEmptyCells(context());
  Object.defineProperty(plan, "schemaVersion", { get() { throw new Error("must not run"); } });
  assert.throws(() => validateEditPlan(plan, context()), /non-data fields/);
});
