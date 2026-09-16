import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { plannerRequest } from "../../tests/helpers/planner-fixture.mjs";
import { PLANNER_LIMITS, validatePlannerResponse } from "../../src/core/planner-protocol.mjs";

/** @param {string} input */
function run(input) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.mjs", import.meta.url))], {
    input, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, TILED_AI_PROVIDER: "deterministic", OPENAI_API_KEY: "", OPENAI_MODEL: "" },
  });
  assert.ifError(result.error);
  return result;
}

test("CLI consumes stdin through EOF and emits only one correlated UTF-8 JSON response", () => {
  const request = plannerRequest();
  request.context.cells[0][0] = { tileset: "forêt 世界 😀", tileId: 4 };
  const result = run(JSON.stringify(request));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.equal(response.requestId, request.requestId);
  assert.equal(validatePlannerResponse(response, request).edits[0].tile.tileset, "forêt 世界 😀");
});

test("CLI failures exit nonzero, use typed stderr, and never emit success JSON", () => {
  const request = plannerRequest();
  for (const [input, code] of [
    ["", "MALFORMED_JSON"], ["{broken", "MALFORMED_JSON"], ["{} {}", "MALFORMED_JSON"],
    [JSON.stringify({ ...request, schemaVersion: 2 }), "UNSUPPORTED_SCHEMA"],
    ["{}", "INVALID_REQUEST"],
    [JSON.stringify({ ...request, context: {} }), "INVALID_CONTEXT"],
    ["x".repeat(PLANNER_LIMITS.requestBytes + 1), "SIZE_LIMIT"],
  ]) {
    const result = run(input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^\\[${code}\\]`));
  }
});

test("CLI semantic catalog round trip preserves names and returns typed lookup errors", () => {
  const request = {
    ...plannerRequest(), instruction: "fill empty with FORÊT 世界",
    tileCatalog: { schemaVersion: 1, tilesets: [{ name: "terrain", tiles: [
      { tileId: 100, name: "Forêt 世界", description: "Herbe verte", tags: ["ground"] },
    ] }] },
  };
  const result = run(JSON.stringify(request));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout).plan.edits[0].tile, { tileset: "terrain", tileId: 100 });
  const bad = run(JSON.stringify({ ...request, instruction: "fill empty with sand" }));
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).error.code, "UNKNOWN_TILE");
  assert.equal(bad.stderr, "");
});

test("planner failures return correlated error envelopes without executable plans", () => {
  for (const request of [ { ...plannerRequest(), instruction: "plant a forest" },
    { ...plannerRequest(), context: { ...plannerRequest().context, cells: [[null, null, null]] } } ]) {
    const result = run(JSON.stringify(request));
    assert.equal(result.status, 0); assert.equal(result.stderr, "");
    const response = JSON.parse(result.stdout);
    assert.equal(response.requestId, request.requestId);
    assert.deepEqual(Object.keys(response), ["schemaVersion", "requestId", "error"]);
    assert.ok(["UNSUPPORTED_INSTRUCTION", "PLANNER_FAILURE"].includes(response.error.code));
  }
});
