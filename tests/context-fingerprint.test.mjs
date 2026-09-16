import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintContext } from "../src/core/context-fingerprint.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";

function snapshot() {
  return { context: plannerRequest().context, orientation: "orthogonal", flags: [[0, 0, 0]], catalog: {
    schemaVersion: 1, tilesets: [
      { name: "terrain", tiles: [{ name: "water", tileId: 9, tags: ["blue", "liquid"] }, { name: "grass", tileId: 4, tags: [] }] },
      { name: "props", tiles: [{ name: "tree", tileId: 2, tags: [] }] },
    ],
  } };
}
test("catalog, tile and tag ordering normalize deterministically without mutation", () => {
  const a = snapshot(); const original = structuredClone(a); const b = structuredClone(a);
  b.catalog.tilesets.reverse(); b.catalog.tilesets[1].tiles.reverse(); b.catalog.tilesets[1].tiles[1].tags.reverse();
  assert.equal(fingerprintContext(a), fingerprintContext(b)); assert.deepEqual(a, original);
});
test("region contents, transform, orientation, dimensions, metadata and resolution affect fingerprints", () => {
  /** @type {((s:ReturnType<typeof snapshot>)=>void)[]} */
  const changes = [s => { s.context.cells[0][1] = { tileset: "terrain", tileId: 9 }; },
    s => { s.flags[0][0] = 1; }, s => { s.orientation = "isometric"; }, s => { s.context.map.tileWidth = 32; },
    s => { s.catalog.tilesets[0].tiles[0].tileId = 10; }, s => { s.catalog.tilesets[0].tiles[0].name = "pond"; },
    s => { s.catalog.tilesets[0].tiles[0].tags.push("wet"); }];
  for (const change of changes) { const a = snapshot(); change(a); assert.notEqual(fingerprintContext(a), fingerprintContext(snapshot())); }
});
test("layer rename and unrelated extra editor state do not affect fingerprints; negative origins work", () => {
  const a = snapshot(); a.context.selection.x = -10; a.context.selection.y = -20;
  const b = structuredClone(a); b.context.layer.name = "Renamed";
  const withEditorState = Object.assign(b, { selection: { x: 100 }, activeLayer: 9, camera: [10, 10], outsideCell: "changed" });
  assert.equal(fingerprintContext(a), fingerprintContext(withEditorState));
});
