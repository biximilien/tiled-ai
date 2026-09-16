import test from "node:test";
import assert from "node:assert/strict";
import { plannerHost } from "./helpers/planner-host.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { startPlanner } from "../src/tiled/planner-process.mjs";
import { parseJobResponse } from "../src/core/job-response.mjs";
import { PLANNER_LIMITS, utf8Bytes } from "../src/core/planner-protocol.mjs";
import { JOB_LIMITS, TILED_SUCCESS_EXIT } from "../src/core/job-errors.mjs";

test("startup returns without any completion wait, writes one UTF-8 request and EOF", t => {
  const { state, events, collectGarbage } = plannerHost(t);
  state.override = "C:/Program Files/nodejs/node.exe";
  const request = plannerRequest();
  const runner = startPlanner(request, "main.mjs");
  assert.deepEqual(events, ["start", "write", "stdin-close"]);
  assert.deepEqual(state.request, request);
  assert.equal(runner.finished(), true);
  assert.equal(parseJobResponse(runner.collect(), request).plan.edits.length, 2);
  runner.dispose(); runner.dispose(); collectGarbage();
  assert.deepEqual(events, ["start", "write", "stdin-close", "wait:0", "close"]);
});

test("unfinished status check performs exactly one zero-timeout check", t => {
  const { state, events } = plannerHost(t); state.waits = [false];
  const runner = startPlanner(plannerRequest(), "main.mjs");
  assert.equal(runner.finished(), false);
  assert.deepEqual(events.slice(3), ["wait:0"]);
  assert.throws(() => runner.collect(), /unfinished/);
  runner.dispose(true);
});

test("completion after the Qt event loop reaped the child uses transport success marker", t => {
  const { state } = plannerHost(t); state.waits = [false]; state.exitCode = TILED_SUCCESS_EXIT;
  const runner = startPlanner(plannerRequest(), "main.mjs");
  assert.equal(runner.finished(), true);
  assert.equal(runner.collect().exitCode, 0);
});

test("repeated requests survive Tiled native disposal exactly once each", t => {
  const host = plannerHost(t);
  for (const instruction of ["fill empty", "noop", "noop", "fill empty"]) {
    const request = plannerRequest(); request.instruction = instruction;
    const runner = startPlanner(request, "main.mjs");
    assert.ok(runner.finished()); parseJobResponse(runner.collect(), request);
    runner.dispose(); assert.doesNotThrow(host.collectGarbage);
  }
  assert.equal(host.events.filter(event => event === "close").length, 4);
});

/** @type {[string, (state: ReturnType<typeof plannerHost>['state']) => void, RegExp][]} */
const failures = [
  ["nonzero exit despite JSON", s => { s.exitCode = 1; }, /process failed/],
  ["empty stdout", s => { s.stdout = ""; }, /JSON/],
  ["malformed stdout", s => { s.stdout = "{} {}"; }, /JSON/],
  ["log prefix on stdout", s => { s.stdout = "log\n{}"; }, /JSON/],
  ["oversized stdout", s => { s.stdout = "é".repeat(PLANNER_LIMITS.responseBytes); }, /too large/],
  ["wrong correlation", s => { s.stdout = JSON.stringify({ schemaVersion: 1, requestId: "wrong", plan: {} }); }, /another request/],
  ["wrong schema", s => { s.stdout = JSON.stringify({ schemaVersion: 2, requestId: "wrong", plan: {} }); }, /version/],
  ["invalid plan", s => { s.stdout = JSON.stringify({ schemaVersion: 1, requestId: plannerRequest().requestId, plan: {} }); }, /invalid plan/],
];
for (const [name, corrupt, reason] of failures) test(`collection rejects ${name} after releasing the handle`, t => {
  const { state, events, collectGarbage } = plannerHost(t); corrupt(state);
  const request = plannerRequest(); const runner = startPlanner(request, "main.mjs");
  assert.ok(runner.finished());
  assert.throws(() => parseJobResponse(runner.collect(), request), reason);
  runner.dispose(); collectGarbage();
  assert.equal(events.filter(event => event === "close").length, 1);
});

test("cancel terminates then kills with short grace waits and is idempotent", t => {
  const { state, events, collectGarbage } = plannerHost(t); state.waits = [false, true];
  const runner = startPlanner(plannerRequest(), "main.mjs");
  runner.dispose(true); runner.dispose(true); collectGarbage();
  assert.deepEqual(events.slice(-5), ["terminate", "wait:250", "kill", "wait:250", "close"]);
  assert.equal(runner.finished(), false);
});

test("start failures are actionable and release resources", t => {
  const { state, events, collectGarbage } = plannerHost(t); state.started = false;
  assert.throws(() => startPlanner(plannerRequest(), "main.mjs"), /Could not start/);
  collectGarbage(); assert.equal(events.filter(event => event === "close").length, 1);
});

test("missing entry and oversized requests fail before starting a process", t => {
  const { state, events } = plannerHost(t); state.exists = false;
  assert.throws(() => startPlanner(plannerRequest(), "main.mjs"), /entry point not found/);
  const request = plannerRequest(); request.context.layer.name = "x".repeat(PLANNER_LIMITS.requestBytes);
  assert.throws(() => startPlanner(request, "main.mjs"), /1 MiB/);
  assert.deepEqual(events, []);
});

test("stderr is byte bounded and never becomes executable or user-visible data", t => {
  const { state } = plannerHost(t); state.stderr = "SECRET 😀".repeat(10000);
  const request = plannerRequest(); const runner = startPlanner(request, "main.mjs");
  assert.ok(runner.finished()); const output = runner.collect();
  assert.ok(utf8Bytes(output.stderr) <= JOB_LIMITS.stderrBytes);
  assert.equal(parseJobResponse(output, request).plan.edits.length, 2);
});
