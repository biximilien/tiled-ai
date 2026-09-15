import test from "node:test";
import assert from "node:assert/strict";
import { plannerHost } from "./helpers/planner-host.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { runPlanner } from "../src/tiled/planner-process.mjs";
import { PLANNER_LIMITS } from "../src/core/planner-protocol.mjs";

test("process uses argument array, UTF-8 stdin, EOF, Node override, and closes after success", t => {
  const { state, events } = plannerHost(t);
  state.override = "C:/Program Files/nodejs/node.exe";
  const request = plannerRequest();
  assert.equal(runPlanner(request, "extension/main.mjs").edits.length, 2);
  assert.deepEqual(state.request, request);
  assert.deepEqual(events, ["start", "write", "stdin-close", "wait:5000", "close"]);
});

/** @type {[string, (state: ReturnType<typeof plannerHost>['state']) => void, RegExp][]} */
const failures = [
  ["start failure", s => { s.started = false; }, /Could not start/],
  ["nonzero exit despite JSON", s => { s.exitCode = 1; }, /exit 1/],
  ["empty stdout", s => { s.stdout = ""; }, /JSON/],
  ["malformed stdout", s => { s.stdout = "{} {}"; }, /JSON/],
  ["oversized stdout", s => { s.stdout = "é".repeat(PLANNER_LIMITS.responseBytes); }, /1 MiB/],
  ["wrong correlation", s => { s.stdout = JSON.stringify({ schemaVersion: 1, requestId: "wrong", plan: {} }); }, /request ID/],
];
for (const [name, corrupt, reason] of failures) {
  test(`process rejects ${name} and closes resources`, t => {
    const { state, events } = plannerHost(t);
    corrupt(state);
    assert.throws(() => runPlanner(plannerRequest(), "main.mjs"), reason);
    assert.equal(events[events.length - 1], "close");
  });
}

test("timeout attempts termination, escalates to kill, waits, then closes", t => {
  const { state, events } = plannerHost(t);
  state.waits = [false, false, true];
  assert.throws(() => runPlanner(plannerRequest(), "main.mjs"), /timed out/);
  assert.deepEqual(events.slice(-6), ["wait:5000", "terminate", "wait:250", "kill", "wait:250", "close"]);
});

test("missing planner and oversized requests fail before starting a process", t => {
  const { state, events } = plannerHost(t);
  state.exists = false;
  assert.throws(() => runPlanner(plannerRequest(), "main.mjs"), /entry point not found/);
  const request = plannerRequest();
  request.context.layer.name = "x".repeat(PLANNER_LIMITS.requestBytes);
  assert.throws(() => runPlanner(request, "main.mjs"), /1 MiB/);
  assert.deepEqual(events, []);
});

test("stderr is diagnostic only and is captured before failure", t => {
  const { state, events } = plannerHost(t);
  /** @type {string[]} */
  const logs = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "tiled");
  Object.defineProperty(globalThis, "tiled", { value: { log: (/** @type {string} */ text) => logs.push(text) }, configurable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "tiled", previous);
    else Reflect.deleteProperty(globalThis, "tiled");
  });
  state.stderr = "[UNSUPPORTED_INSTRUCTION] Unknown instruction.\n";
  state.exitCode = 1;
  assert.throws(() => runPlanner(plannerRequest(), "main.mjs"), /Unknown instruction/);
  assert.match(logs[0], /UNSUPPORTED_INSTRUCTION/);
  assert.equal(events[events.length - 1], "close");
});
