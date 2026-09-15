import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { plannerRequest } from "../../tests/helpers/planner-fixture.mjs";
import { providerConfig } from "../src/provider-config.mjs";
import { planRequest } from "../src/provider-router.mjs";
import { semanticSchema, buildModelInput, compileSemanticPlan } from "../src/model-plan.mjs";
import { openaiAdapter, safeProviderError } from "../src/openai-adapter.mjs";
import { validatePlannerResponse } from "../../src/core/planner-protocol.mjs";
import { MODEL_LIMITS } from "../../src/core/model-limits.mjs";

const env = { TILED_AI_PROVIDER: "openai", OPENAI_API_KEY: "fake-secret-never-network", OPENAI_MODEL: "explicit-test-model" };
function request() {
  return { ...plannerRequest(), instruction: "Create a small pond surrounded by grass.",
    tileCatalog: { schemaVersion: 1, tilesets: [{ name: "terrain", tiles: [
      { tileId: 4, name: "grass", description: "Ground", tags: ["green"] },
      { tileId: 9, name: "water", tags: ["blue"] },
    ] }] } };
}
function result() {
  return { status: "planned", summary: "A tiny pond with grass.", reason: /** @type {string|null} */ (null),
    edits: [{ dx: 1, dy: 0, tile: "terrain:water" }, { dx: 2, dy: 0, tile: "terrain:grass" }] };
}

test("configuration defaults, explicit modes, missing credentials and safe errors", async () => {
  assert.deepEqual(providerConfig({}), { provider: "deterministic" });
  for (const provider of [undefined, "deterministic"]) {
    const output = await planRequest(plannerRequest(), { TILED_AI_PROVIDER: provider }, async () => { throw new Error("must not call"); });
    assert.equal(output.plan.edits.length, 2);
  }
  for (const config of [ { TILED_AI_PROVIDER: "fake-secret" },
    { TILED_AI_PROVIDER: "openai", OPENAI_MODEL: "model" },
    { TILED_AI_PROVIDER: "openai", OPENAI_API_KEY: "fake-secret" } ]) {
    assert.throws(() => providerConfig(config), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /fake-secret/); return true;
    });
  }
  assert.equal(providerConfig(env).model, env.OPENAI_MODEL);
});

test("schema closes every object, requires all fields, and enumerates canonical qualified names", () => {
  const format = zodTextFormat(semanticSchema(request()), "tile_plan");
  const json = JSON.parse(JSON.stringify(format.schema));
  assert.equal(format.strict, true);
  assert.equal(json.additionalProperties, false);
  assert.deepEqual(json.required, ["status", "summary", "reason", "edits"]);
  assert.equal(json.properties.edits.items.additionalProperties, false);
  assert.deepEqual(json.properties.edits.items.required, ["dx", "dy", "tile"]);
  assert.deepEqual(json.properties.edits.items.properties.tile.enum, ["terrain:grass", "terrain:water"]);
  assert.equal(json.properties.edits.items.properties.dx.type, "integer");
});

test("prompt is stable, bounded and excludes numeric references, origin and map details", () => {
  const req = request();
  const original = structuredClone(req);
  const input = buildModelInput(req);
  const format = zodTextFormat(semanticSchema(req), "tile_plan");
  assert.equal(input[0].role, "system");
  const body = JSON.parse(input[1].content);
  assert.deepEqual(Object.keys(body), ["instruction", "width", "height", "cells", "catalog", "maximumEdits"]);
  assert.deepEqual(body.cells, [["occupied", "empty", "empty"]]);
  assert.equal(body.maximumEdits, 256);
  assert.deepEqual(body.catalog[0], { name: "terrain:grass", description: "Ground", tags: ["green"] });
  assert.doesNotMatch(input[1].content, /tileId|layerId|requestId|tileWidth|"x"|"y"/);
  // Catalog remains valid when tile IDs change its storage order.
  req.tileCatalog.tilesets[0].tiles[0].tileId = 10;
  req.tileCatalog.tilesets[0].tiles.reverse();
  assert.deepEqual(buildModelInput(req), input);
  assert.deepEqual(zodTextFormat(semanticSchema(req), "tile_plan").schema, format.schema);
  assert.deepEqual(original, request());
});

test("invalid, duplicate or empty catalog and excessive selection fail before adapter call", async () => {
  const cases = [];
  const empty = request(); empty.tileCatalog.tilesets = []; cases.push(empty);
  const duplicate = request(); duplicate.tileCatalog.tilesets[0].tiles[1].name = "grass"; cases.push(duplicate);
  const large = request(); large.context.selection.width = 257; large.context.cells = [Array(257).fill(null)]; cases.push(large);
  for (const req of cases) {
    let calls = 0;
    await assert.rejects(planRequest(req, env, async () => { calls++; return result(); }));
    assert.equal(calls, 0);
  }
  await assert.rejects(planRequest(plannerRequest(), env, async () => result()), /catalog/);
});

test("fake adapter compiles pond to existing validated plan, preserving correlation and inputs", async () => {
  const req = request(), semantic = result();
  const before = structuredClone({ req, semantic });
  let calls = 0;
  const response = await planRequest(req, env, async input => {
    calls++; assert.ok(input.schema); assert.equal(input.input.length, 2); return semantic;
  });
  assert.equal(calls, 1);
  assert.equal(response.requestId, req.requestId);
  assert.equal(response.schemaVersion, 1);
  assert.deepEqual(validatePlannerResponse(response, req).edits, [
    { operation: "setTile", x: 13, y: 8, tile: { tileset: "terrain", tileId: 9 } },
    { operation: "setTile", x: 14, y: 8, tile: { tileset: "terrain", tileId: 4 } },
  ]);
  assert.deepEqual({ req, semantic }, before);
  req.context.map.infinite = true; req.context.selection.x = -20; req.context.selection.y = -10;
  assert.equal(compileSemanticPlan(semantic, req).plan.edits[0].x, -19);
  req.context.selection.x = Number.MAX_SAFE_INTEGER;
  assert.throws(() => compileSemanticPlan(semantic, req), /safe integer/);
});

test("cannot_plan carries a bounded reason and no executable edits", () => {
  const req = request();
  const output = compileSemanticPlan({ status: "cannot_plan", summary: "No suitable tiles.", reason: "Add a bridge tile.", edits: [] }, req);
  assert.equal(validatePlannerResponse(output, req).edits.length, 0);
  assert.equal(output.metadata.reason, "Add a bridge tile.");
});

/** @type {[string, (value: ReturnType<typeof result>) => void][]} */
const invalid = [
  ["invented tile", r => { r.edits[0].tile = "terrain:lava"; }],
  ["unqualified tile", r => { r.edits[0].tile = "water"; }],
  ["noncanonical tile", r => { r.edits[0].tile = "Terrain:water"; }],
  ["duplicate targets", r => { r.edits[1].dx = 1; }],
  ["negative dx", r => { r.edits[0].dx = -1; }],
  ["out of bounds x", r => { r.edits[0].dx = 3; }],
  ["out of bounds y", r => { r.edits[0].dy = 1; }],
  ["fractional coordinate", r => { r.edits[0].dx = 1.5; }],
  ["unsafe coordinate", r => { r.edits[0].dx = Number.MAX_SAFE_INTEGER + 1; }],
  ["occupied cell", r => { r.edits[0].dx = 0; }],
  ["excessive edits", r => { r.edits = Array(257).fill(r.edits[0]); }],
  ["overlong summary", r => { r.summary = "x".repeat(301); }],
  ["empty summary", r => { r.summary = " "; }],
  ["overlong reason", r => { r.status = "cannot_plan"; r.edits = []; r.reason = "x".repeat(501); }],
  ["empty reason", r => { r.status = "cannot_plan"; r.edits = []; r.reason = " "; }],
  ["unknown status", r => { r.status = "execute"; }],
  ["planned with reason", r => { r.reason = "oops"; }],
  ["planned without edits", r => { r.edits = []; }],
  ["cannot_plan with edits", r => { r.status = "cannot_plan"; r.reason = "why"; }],
  ["cannot_plan without reason", r => { r.status = "cannot_plan"; r.edits = []; }],
];
for (const [name, corrupt] of invalid) test(`semantic validator rejects ${name}`, () => {
  const value = result(); corrupt(value);
  assert.throws(() => compileSemanticPlan(value, request()), /semantic plan/);
});

test("rejects malformed output and extra executable fields", () => {
  for (const value of [null, {}, { ...result(), command: "setTile" }, { ...result(), reason: undefined },
    { ...result(), edits: [{ dx: 1, dy: 0, tile: "terrain:water", tileId: 9 }] }]) {
    assert.throws(() => compileSemanticPlan(value, request()), /invalid semantic plan/);
  }
});

test("exact selection, edit and prose limit boundaries are accepted", () => {
  const req = request(); req.context.selection.width = 16; req.context.selection.height = 16;
  req.context.cells = Array.from({ length: 16 }, () => Array(16).fill(null));
  const value = result(); value.summary = "x".repeat(MODEL_LIMITS.summaryCharacters);
  value.edits = Array.from({ length: 256 }, (_, i) => ({ dx: i % 16, dy: Math.floor(i / 16), tile: "terrain:grass" }));
  assert.equal(compileSemanticPlan(value, req).plan.edits.length, MODEL_LIMITS.edits);
  value.status = "cannot_plan"; value.edits = []; value.reason = "x".repeat(MODEL_LIMITS.reasonCharacters);
  assert.equal(compileSemanticPlan(value, req).metadata.reason?.length, 500);
});

/** Fake only the HTTP transport; run the installed official SDK parser/helper.
 * @param {unknown} output @param {number} [status] */
function transport(output, status = 200) {
  let calls = 0;
  /** @type {unknown[]} */
  const bodies = [];
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY, logLevel: "off", maxRetries: 0,
    fetch: async (_url, init) => {
      calls++; bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(output), { status, headers: { "content-type": "application/json" } });
    } });
  return { client, bodies, calls: () => calls };
}
/** @param {unknown} value */
function sdkResponse(value) {
  return { id: "fake-response", status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] };
}
function modelInput() { return { schema: semanticSchema(request()), input: buildModelInput(request()) }; }

test("official SDK adapter parses strict output in one offline HTTP attempt", async () => {
  const fake = transport(sdkResponse(result()));
  const adapter = openaiAdapter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }, fake.client);
  assert.deepEqual(await adapter(modelInput()), result());
  assert.equal(fake.calls(), 1);
  const body = JSON.parse(JSON.stringify(fake.bodies[0]));
  assert.equal(body.model, env.OPENAI_MODEL); assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true); assert.equal(body.text.format.type, "json_schema");
  assert.doesNotMatch(JSON.stringify(body), /fake-secret/);
});

test("refusal, incomplete, missing parsed output and malformed JSON cannot yield a plan", async () => {
  const cases = [
    { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "untrusted-secret" }] }] },
    { ...sdkResponse(result()), status: "incomplete" },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "{broken" }] }] },
  ];
  for (const output of cases) {
    const fake = transport(output);
    await assert.rejects(openaiAdapter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }, fake.client)(modelInput()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /untrusted-secret|broken|fake-secret/); return true;
    });
    assert.equal(fake.calls(), 1);
  }
});

test("HTTP errors never retry or expose provider bodies/credentials", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const fake = transport({ error: { message: env.OPENAI_API_KEY } }, status);
    await assert.rejects(openaiAdapter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }, fake.client)(modelInput()), error => {
      assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /fake-secret/); return true;
    });
    assert.equal(fake.calls(), 1);
  }
});

test("network, timeout and abort diagnostics are safe", () => {
  for (const error of [new OpenAI.APIConnectionTimeoutError({ message: env.OPENAI_API_KEY }),
    new OpenAI.APIUserAbortError({ message: env.OPENAI_API_KEY }), new OpenAI.APIConnectionError({ message: env.OPENAI_API_KEY }),
    new Error(env.OPENAI_API_KEY)]) {
    assert.doesNotMatch(safeProviderError(error).message, /fake-secret/);
  }
  assert.equal(safeProviderError(new OpenAI.APIConnectionTimeoutError()).code, "TIMEOUT");
  assert.equal(safeProviderError(new OpenAI.APIUserAbortError()).code, "TIMEOUT");
});

test("adapter supplies a deadline and exactly one attempt to the SDK", async () => {
  const fake = /** @type {Pick<OpenAI, 'responses'>} */ (/** @type {unknown} */ ({ responses: {
    /** @param {unknown} _body @param {{timeout:number,maxRetries:number,signal:AbortSignal}} options */
    async parse(_body, options) {
      assert.equal(options.timeout, MODEL_LIMITS.timeoutMs);
      assert.equal(options.maxRetries, MODEL_LIMITS.attempts - 1);
      assert.ok(options.signal instanceof AbortSignal);
      return { status: "completed", output: [], output_parsed: result() };
    },
  } }));
  assert.deepEqual(await openaiAdapter({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }, fake)(modelInput()), result());
});

test("Tiled protocol independently rejects unsafe summary metadata", () => {
  const req = request(); const valid = compileSemanticPlan(result(), req);
  for (const metadata of [null, {}, { ...valid.metadata, summary: "x".repeat(301) },
    { ...valid.metadata, summary: " " }, { ...valid.metadata, reason: "unexpected" },
    { ...valid.metadata, status: "cannot_plan", reason: "No plan" },
    { ...valid.metadata, command: "execute" }]) {
    assert.throws(() => validatePlannerResponse({ ...valid, metadata }, req));
  }
  assert.throws(() => validatePlannerResponse({ ...valid, plan: { ...valid.plan, edits: [] } }, req));
  const none = compileSemanticPlan({ status: "cannot_plan", summary: "No plan", reason: "Cannot comply", edits: [] }, req);
  assert.throws(() => validatePlannerResponse({ ...none, metadata: { ...none.metadata, reason: "x".repeat(501) } }, req));
});
