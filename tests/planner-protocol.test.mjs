import test from "node:test";
import assert from "node:assert/strict";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { routeRequest } from "../planner/src/command-router.mjs";
import { planFillEmptyCells } from "../src/core/fill-empty-planner.mjs";
import { PLANNER_LIMITS, PlannerError, requirePlannerRequest, serializePlannerRequest, validatePlannerResponse, utf8Bytes } from "../src/core/planner-protocol.mjs";

test("valid request and correlated response preserve the existing protocol", () => {
  const request = plannerRequest();
  assert.doesNotThrow(() => requirePlannerRequest(request));
  assert.deepEqual(JSON.parse(serializePlannerRequest(request)), request);
  assert.deepEqual(validatePlannerResponse(routeRequest(request), request), planFillEmptyCells(request.context));
});

test("request rejects malformed envelope, instructions, context, and area", () => {
  const good = plannerRequest();
  for (const request of [
    null, {}, { ...good, schemaVersion: undefined }, { ...good, schemaVersion: 2 },
    { ...good, requestId: "" }, { ...good, requestId: 1 },
    ...["", "  ", null, 42, "x".repeat(2001)].map(instruction => ({ ...good, instruction })),
    { ...good, context: null }, { ...good, context: {} },
    { ...good, context: { ...good.context, cells: [] } },
    { ...good, context: { ...good.context, selection: { x: 0, y: 0, width: 4097, height: 1 } } },
    { ...good, context: { ...good.context, selection: { x: 0, y: 0, width: Number.MAX_SAFE_INTEGER, height: 2 } } },
    { ...good, fileName: "C:/map.tmx" },
  ]) assert.throws(() => requirePlannerRequest(request), PlannerError);
});

test("response rejects unsupported schema, missing/mismatched IDs, and malformed plans", () => {
  const request = plannerRequest();
  const good = routeRequest(request);
  for (const response of [null, {}, { ...good, schemaVersion: undefined },
    { ...good, schemaVersion: 2 }, { ...good, requestId: undefined }, { ...good, requestId: "wrong" },
    { ...good, plan: undefined }, { ...good, plan: {} },
    { ...good, plan: { ...good.plan, edits: [{ operation: "delete" }] } },
  ]) assert.throws(() => validatePlannerResponse(response, request));
});

test("router only accepts the explicit vocabulary, with case and edge whitespace normalization", () => {
  const request = plannerRequest();
  const expected = planFillEmptyCells(request.context);
  for (const instruction of ["fill empty cells", "fill empty", "  FiLL EmPtY CeLLs\n"]) {
    assert.deepEqual(routeRequest({ ...request, instruction }).plan, expected);
  }
  assert.deepEqual(routeRequest({ ...request, instruction: " NOOP " }).plan.edits, []);
  assert.deepEqual(routeRequest(request), routeRequest(request));
  for (const instruction of ["fill", "please fill empty cells", "fill  empty", "paint a forest"]) {
    assert.throws(() => routeRequest({ ...request, instruction }), { code: "UNSUPPORTED_INSTRUCTION" });
  }
  request.context.cells = [[null, null, null]];
  assert.throws(() => routeRequest(request), { code: "PLANNER_FAILURE" });
  assert.deepEqual(routeRequest({ ...request, instruction: "noop" }).plan.edits, []);
});

test("UTF-8 sizes include multibyte characters and reject oversized serialized requests", () => {
  for (const text of ["ascii", "é世界😀", "\ud800", "\udc00", "\ud800a"]) {
    assert.equal(utf8Bytes(text), Buffer.byteLength(text, "utf8"));
  }
  const request = plannerRequest();
  request.context.layer.name = "é".repeat(PLANNER_LIMITS.requestBytes / 2);
  assert.throws(() => serializePlannerRequest(request), { code: "SIZE_LIMIT" });
});
