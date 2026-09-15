import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTileMetadata, normalizeTags, CATALOG_LIMITS } from "../src/core/tile-metadata.mjs";
import { requireTileCatalog, lookupSemanticTile } from "../src/core/tile-catalog.mjs";
import { buildTileCatalog } from "../src/tiled/tile-catalog-reader.mjs";
import { routeRequest } from "../planner/src/command-router.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { requirePlannerRequest, serializePlannerRequest, PLANNER_LIMITS } from "../src/core/planner-protocol.mjs";

/** @param {number} id @param {Record<string, unknown>} [properties] */
function tile(id, properties = {}) {
  return Object.freeze({ id, property: (/** @type {string} */ key) => properties[key] });
}
/** @param {{name: string, tiles: ReturnType<typeof tile>[]}[]} sets */
function map(sets) {
  return /** @type {TileMap} */ (/** @type {unknown} */ (Object.freeze({ isTileMap: true, tilesets: sets })));
}
function catalog() {
  return {
    schemaVersion: 1,
    tilesets: [
      { name: "Decor", tiles: [{ tileId: 9, name: "Tree", tags: [] }] },
      { name: "terrain", tiles: [{ tileId: 4, name: "Grass", tags: ["ground"] }] },
    ],
  };
}

test("normalization preserves Unicode and display strings, trims and canonically deduplicates tags", () => {
  const result = normalizeTileMetadata(" Forêt 世界 ", "  Plain  grass\nterrain ", "walkable, ground, Ground, , outdoor, WALKABLE");
  assert.deepEqual(result.metadata, {
    name: "Forêt 世界", description: "Plain  grass\nterrain", tags: ["Ground", "outdoor", "WALKABLE"],
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(normalizeTags("Ground,ground"), normalizeTags("ground,Ground"));
  assert.deepEqual(normalizeTags(" , , "), []);
  assert.deepEqual(normalizeTileMetadata("Grass", "  ", undefined).metadata, { name: "Grass", tags: [] });
  assert.equal(normalizeTileMetadata(undefined, undefined, undefined).metadata, null);
});

test("bad metadata yields property-specific diagnostics and no usable metadata", () => {
  for (const [name, description, tags, property] of [
    [" ", undefined, undefined, "ai_name"],
    [4, undefined, undefined, "ai_name"],
    ["Grass", 4, undefined, "ai_description"],
    ["Grass", undefined, [], "ai_tags"],
    ["terrain:grass", undefined, undefined, "ai_name"],
    ["x".repeat(81), undefined, undefined, "ai_name"],
    ["Grass", "x".repeat(501), undefined, "ai_description"],
    ["Grass", undefined, "x".repeat(51), "ai_tags"],
    ["Grass", undefined, Array.from({ length: 21 }, (_, i) => `tag${i}`).join(","), "ai_tags"],
  ]) {
    const result = normalizeTileMetadata(name, description, tags);
    assert.equal(result.metadata, null);
    assert.equal(result.diagnostics[0].property, property);
  }
  assert.equal(normalizeTileMetadata("😀".repeat(40), "x".repeat(500), "x".repeat(50)).diagnostics.length, 0);
});

test("reader uses explicit properties and sparse IDs, produces stable sorted plain data without mutations", () => {
  /** @type {string[]} */
  const read = [];
  const explicit = Object.freeze({
    id: 100,
    property: (/** @type {string} */ key) => { read.push(key); return key === "ai_name" ? "Water" : undefined; },
    resolvedProperty() { throw new Error("must not read inherited defaults"); },
  });
  const a = { name: "terrain", tiles: [explicit, tile(7), tile(2, { ai_name: "Grass", ai_tags: "ground, outdoor" })] };
  const b = { name: "Decor", tiles: [tile(20, { ai_name: "Tree" })] };
  const before = JSON.stringify([a, b]);
  const first = buildTileCatalog(map([a, b]));
  const second = buildTileCatalog(map([b, { name: a.name, tiles: a.tiles.slice().reverse() }]));
  assert.deepEqual(first.summary, { annotated: 3, ignored: 1, invalid: 0, tilesets: 2 });
  assert.ok(first.catalog);
  assert.deepEqual(first.catalog.tilesets.map(set => set.name), ["Decor", "terrain"]);
  assert.deepEqual(first.catalog.tilesets[1].tiles.map(entry => entry.tileId), [2, 100]);
  assert.equal(JSON.stringify(first.catalog), JSON.stringify(second.catalog));
  assert.equal(JSON.stringify([a, b]), before);
  assert.deepEqual(read, ["ai_name", "ai_description", "ai_tags", "ai_name", "ai_description", "ai_tags"]);
});

test("invalid metadata and duplicate normalized identities invalidate the whole catalog", () => {
  for (const sets of [
    [{ name: "Terrain", tiles: [] }, { name: " terrain ", tiles: [] }],
    [{ name: "terrain", tiles: [tile(2, { ai_name: "Grass" }), tile(9, { ai_name: " grass " })] }],
    [{ name: "terrain", tiles: [tile(2, { ai_name: "Grass" }), tile(9, { ai_name: "water", ai_tags: 3 })] }],
  ]) {
    const result = buildTileCatalog(map(sets));
    assert.equal(result.catalog, null);
    assert.ok(result.diagnostics.length);
  }
  const result = buildTileCatalog(map([{ name: "terrain", tiles: [tile(9, { ai_name: "water", ai_tags: 3 })] }]));
  assert.deepEqual(result.diagnostics[0], {
    severity: "error", tileset: "terrain", tileId: 9, property: "ai_tags",
    code: "invalid_property_type", message: "ai_tags must be a string.",
  });
});

test("catalog count and byte limits reject rather than exposing partial data", () => {
  const tiles = Array.from({ length: 501 }, (_, id) => tile(id, { ai_name: `tile${id}` }));
  const result = buildTileCatalog(map([{ name: "terrain", tiles }]));
  assert.equal(result.catalog, null);
  assert.equal(result.summary.annotated, 501);
  assert.match(result.diagnostics[0].message, /500/);
  const large = catalog();
  large.tilesets[0].tiles = Array.from({ length: 500 }, (_, tileId) => ({
    tileId, name: `tile${tileId}`, description: "x".repeat(500),
    tags: Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(48)}`),
  }));
  large.tilesets.pop();
  assert.throws(() => requireTileCatalog(large), /512 KiB/);
  large.tilesets[0].tiles.push({ tileId: 9999, name: "Extra", tags: [] });
  assert.throws(() => requireTileCatalog(large), /500/);
});

test("lookup is exact, case-insensitive, accent-preserving, and supports qualification", () => {
  const c = catalog();
  assert.deepEqual(lookupSemanticTile(c, "gRaSs"), { tileset: "terrain", tileId: 4 });
  assert.deepEqual(lookupSemanticTile(c, "TERRAIN:grass"), { tileset: "terrain", tileId: 4 });
  c.tilesets[1].tiles[0].name = "Forêt 世界";
  assert.deepEqual(lookupSemanticTile(c, "FORÊT 世界"), { tileset: "terrain", tileId: 4 });
  assert.throws(() => lookupSemanticTile(c, "foret 世界"), { code: "UNKNOWN_TILE" });
  assert.throws(() => lookupSemanticTile(c, "missing:Forêt 世界"), { code: "UNKNOWN_TILE" });
  assert.throws(() => lookupSemanticTile(c, "terrain:a:b"), { code: "INVALID_TILE_REFERENCE" });
});

test("cross-tileset ambiguity requires qualification; duplicate catalog names are rejected defensively", () => {
  const c = catalog();
  c.tilesets[0].tiles[0].name = "grass";
  assert.doesNotThrow(() => requireTileCatalog(c));
  assert.throws(() => lookupSemanticTile(c, "grass"), error => {
    assert.match(String(error), /Decor:grass, terrain:Grass/);
    return /** @type {{code: string}} */ (error).code === "AMBIGUOUS_TILE";
  });
  assert.deepEqual(lookupSemanticTile(c, "terrain:grass"), { tileset: "terrain", tileId: 4 });
  c.tilesets[1].tiles.push({ tileId: 10, name: "grass", tags: [] });
  assert.throws(() => lookupSemanticTile(c, "grass"), { code: "DUPLICATE_TILE_NAME" });
});

test("unknown-name suggestions are stable and bounded to ten complete alternatives", () => {
  const c = { schemaVersion: 1, tilesets: [{ name: "terrain", tiles: Array.from({ length: 15 }, (_, tileId) => ({
    tileId, name: `tile${String(tileId).padStart(2, "0")}`, tags: [],
  })) }] };
  assert.throws(() => lookupSemanticTile(c, "sand"), error => {
    const text = String(error);
    assert.equal((text.match(/terrain:/g) || []).length, CATALOG_LIMITS.suggestions);
    assert.ok(text.indexOf("tile00") < text.indexOf("tile09"));
    assert.ok(!text.includes("tile10"));
    return true;
  });
});

test("semantic routing uses ordinary edits, including entirely empty and negative selections", () => {
  const request = plannerRequest();
  request.context.selection.x = -5;
  request.context.map.infinite = true;
  for (const instruction of ["fill empty with grass", " FiLL EMPTY WITH TERRAIN:GRASS "]) {
    const response = routeRequest({ ...request, instruction, tileCatalog: catalog() });
    assert.deepEqual(response.plan.edits.map(edit => [edit.x, edit.y, edit.tile]), [
      [-4, 8, { tileset: "terrain", tileId: 4 }], [-3, 8, { tileset: "terrain", tileId: 4 }],
    ]);
  }
  request.context.cells = [[null, null, null]];
  assert.equal(routeRequest({ ...request, instruction: "fill empty with Grass", tileCatalog: catalog() }).plan.edits.length, 3);
  assert.throws(() => routeRequest({ ...request, instruction: "fill empty with grass" }), { code: "MISSING_CATALOG" });
  assert.throws(() => routeRequest({ ...request, instruction: "fill empty with ", tileCatalog: catalog() }), { code: "INVALID_TILE_REFERENCE" });
  assert.throws(() => routeRequest({ ...request, instruction: "please fill empty with grass", tileCatalog: catalog() }), { code: "UNSUPPORTED_INSTRUCTION" });
  assert.equal(routeRequest({ ...request, instruction: "noop" }).plan.edits.length, 0);
});

test("optional catalog uses outer schema 1 and counts toward the existing request limit", () => {
  const request = { ...plannerRequest(), tileCatalog: catalog() };
  assert.doesNotThrow(() => requirePlannerRequest(request));
  assert.deepEqual(JSON.parse(serializePlannerRequest(request)).tileCatalog, catalog());
  assert.throws(() => requirePlannerRequest({ ...request, tileCatalog: { schemaVersion: 2, tilesets: [] } }), /schema/);
  const c = catalog();
  const noCatalog = plannerRequest();
  noCatalog.context.layer.name = "x".repeat(PLANNER_LIMITS.requestBytes - JSON.stringify(noCatalog).length);
  assert.doesNotThrow(() => serializePlannerRequest(noCatalog));
  assert.throws(() => serializePlannerRequest({ ...noCatalog, tileCatalog: c }), /1 MiB/);
});
