import test from "node:test";
import assert from "node:assert/strict";
import { JobController } from "../src/core/job-controller.mjs";
import { JobError, JOB_LIMITS } from "../src/core/job-errors.mjs";
import { parseJobResponse } from "../src/core/job-response.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { routeRequest } from "../planner/src/command-router.mjs";

function fixture() {
  const request = plannerRequest();
  const state = { now: 100, finished: false, fingerprint: "original", dispose: 0, stopped: false,
    throwCollect: false, output: { exitCode: 0, stdout: JSON.stringify(routeRequest(request)), stderr: "" } };
  const controller = new JobController({ clock: () => state.now, readCurrentContext: () => state.fingerprint,
    parseResponse: parseJobResponse, startRunner: () => ({
      finished: () => state.finished,
      collect: () => { if (state.throwCollect) throw new Error("secret raw exception"); return state.output; },
      dispose: stop => { state.dispose++; state.stopped = Boolean(stop); },
    }) });
  return { controller, request, state };
}

test("single-job controller follows idle, running, collecting, ready, idle", () => {
  const { controller: c, request, state } = fixture();
  assert.equal(c.state, "idle"); c.start(request, "original");
  assert.equal(c.state, "running"); assert.notEqual(c.job?.request, request);
  assert.throws(() => c.start(request, "original"), /already running/);
  assert.equal(c.check(), "running"); assert.equal(state.dispose, 0);
  state.finished = true; assert.equal(c.check(), "ready"); assert.equal(state.dispose, 1);
  assert.equal(c.result?.plan.edits.length, 2);
  assert.equal(c.check(), "ready"); assert.equal(state.dispose, 1);
  c.clear(); assert.equal(c.state, "idle"); assert.equal(c.job, null); assert.equal(c.result, null);
});

test("invalid transitions fail without discarding an active job", () => {
  const { controller: c, request } = fixture();
  assert.throws(() => c.transition("ready"), /Invalid/);
  c.start(request, "original"); assert.throws(() => c.clear(), /Invalid/);
  assert.equal(c.state, "running"); c.cancel(); c.clear();
});

test("failed startup stays idle and permits another attempt", () => {
  const { controller: c, request } = fixture();
  const start = c.dependencies.startRunner;
  c.dependencies.startRunner = () => { throw new JobError("start_failed", "Could not start the AI planner."); };
  assert.throws(() => c.start(request, "original"), /Could not start/);
  assert.equal(c.state, "idle"); assert.equal(c.job, null);
  c.dependencies.startRunner = start; c.start(request, "original"); c.cancel(); c.clear();
});

test("cancel remains idempotent if an injected disposal adapter throws", () => {
  const { controller: c, request } = fixture();
  c.dependencies.startRunner = () => ({ finished: () => false, collect: () => { throw new Error("unused"); }, dispose: () => { throw new Error("native failure"); } });
  c.start(request, "original"); assert.doesNotThrow(() => c.cancel());
  assert.doesNotThrow(() => c.cancel()); assert.equal(c.state, "cancelled"); c.clear();
});

test("cancellation is idempotent and closes the injected runner once", () => {
  const { controller: c, request, state } = fixture(); c.start(request, "original");
  c.cancel(); c.cancel(); assert.equal(c.state, "cancelled"); assert.equal(state.dispose, 1); assert.ok(state.stopped);
  assert.equal(c.check(), "cancelled"); assert.equal(c.result, null); c.clear(); c.clear();
  assert.equal(c.state, "idle");
});

test("overdue check terminates a hung process; exact grace boundary remains running", () => {
  const { controller: c, request, state } = fixture(); c.start(request, "original");
  state.now += JOB_LIMITS.overdueMs; assert.equal(c.check(), "running");
  state.now++; assert.equal(c.check(), "failed"); assert.equal(c.error?.code, "timeout");
  assert.equal(state.dispose, 1); assert.ok(state.stopped); assert.equal(c.result, null);
  c.clear(); assert.equal(c.state, "idle");
});

test("late collection of a finished valid process is allowed", () => {
  const { controller: c, request, state } = fixture(); c.start(request, "original");
  state.now += 100000; state.finished = true; assert.equal(c.check(), "ready");
});

for (const malformed of [true, false]) test(`collection ${malformed ? "parse failure" : "exception"} still disposes once`, () => {
  const { controller: c, request, state } = fixture(); c.start(request, "original");
  state.finished = true;
  if (malformed) state.output.stdout = "{broken"; else state.throwCollect = true;
  assert.equal(c.check(), "failed"); assert.equal(state.dispose, 1); assert.equal(c.job, null);
  assert.doesNotMatch(c.error?.message || "", /secret/); c.clear(); assert.equal(c.state, "idle");
});

test("relevant changes and unreadable targets become stale without retaining a plan", () => {
  for (const unreadable of [true, false]) {
    const { controller: c, request, state } = fixture(); c.start(request, "original"); state.finished = true;
    if (unreadable) c.dependencies.readCurrentContext = () => { throw new JobError("target_missing", "Layer removed. The map was not changed."); };
    else state.fingerprint = "changed";
    assert.equal(c.check(), "stale"); assert.equal(c.result, null); assert.equal(c.job, null);
    assert.equal(state.dispose, 1); c.clear(); assert.equal(c.state, "idle");
  }
});

test("safe correlated timeout response has no executable plan", () => {
  const { controller: c, request, state } = fixture(); c.start(request, "original"); state.finished = true;
  state.output.stdout = JSON.stringify({ schemaVersion: 1, requestId: request.requestId, error: { code: "TIMEOUT" } });
  assert.equal(c.check(), "failed"); assert.equal(c.error?.code, "timeout"); assert.equal(c.result, null);
});

test("error envelopes are strict and never expose raw messages or stderr", () => {
  const request = plannerRequest();
  for (const error of [{ code: "TIMEOUT", message: "secret" }, { code: "secret key!" }, {}]) {
    assert.throws(() => parseJobResponse({ exitCode: 0, stderr: "secret", stdout: JSON.stringify({ schemaVersion: 1, requestId: request.requestId, error }) }, request),
      value => { assert.ok(value instanceof JobError); assert.doesNotMatch(value.message, /secret/); return true; });
  }
});
