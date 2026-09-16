import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startPlanner } from "../src/tiled/planner-process.mjs";
import { parseJobResponse } from "../src/core/job-response.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";

// Small Node-backed Process facade exercises the production runner with real
// pipes and child lifetime. It is not a mock of the Tiled editor.
class NodeProcess {
  codec = "";
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams|null} */ child = null;
  stdout = ""; stderr = ""; closed = false;
  /** @type {Promise<void>} */ done = Promise.resolve();
  /** @type {number[]} */ waits = [];
  get exitCode() { return this.child?.exitCode || 0; }
  getEnv() { return process.execPath; }
  /** @param {string} executable @param {string[]} args */
  start(executable, args) {
    const child = spawn(executable, args, { windowsHide: true,
      env: { ...process.env, TILED_AI_PROVIDER: "deterministic", OPENAI_API_KEY: "", OPENAI_MODEL: "" } });
    this.child = child;
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", text => { this.stdout += text; });
    child.stderr.on("data", text => { this.stderr += text; });
    this.done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", () => { this.closed = true; resolve(); }); });
    return true;
  }
  /** @param {string} text */ write(text) { this.child?.stdin.write(text); }
  closeWriteChannel() { this.child?.stdin.end(); }
  /** @param {number} ms */ waitForFinished(ms) { this.waits.push(ms); return this.closed; }
  readStdOut() { return this.stdout; }
  readStdErr() { return this.stderr; }
  terminate() { this.child?.kill("SIGTERM"); }
  kill() { this.child?.kill("SIGKILL"); }
}
const fake = fileURLToPath(new URL("../planner/fixtures/fake-planner.mjs", import.meta.url));

for (const mode of ["valid", "malformed", "multiple", "exit", "mismatch", "oversized", "timeout", "watchdog"]) {
  test(`real offline child: ${mode}`, { timeout: 5000 }, async t => {
    const process = new NodeProcess();
    const request = plannerRequest();
    const runner = startPlanner(request, "unused", { createProcess: () => /** @type {Process} */ (/** @type {unknown} */ (process)),
      arguments: [fake, "--delay-ms", "10", "--result", mode] });
    t.after(() => runner.dispose(true));
    assert.deepEqual(process.waits, []); // startup never waits
    assert.equal(runner.finished(), false);
    await process.done;
    assert.equal(runner.finished(), true);
    const output = runner.collect();
    if (mode === "valid") assert.equal(parseJobResponse(output, request).plan.edits.length, 2);
    else assert.throws(() => parseJobResponse(output, request));
    if (mode === "watchdog") {
      assert.equal(output.exitCode, 0); assert.equal(JSON.parse(output.stdout).error.code, "TIMEOUT");
      assert.equal(output.stderr, "");
    }
    assert.deepEqual(process.waits, [0, 0]);
  });
}

test("real hanging child is stopped on cancellation without waiting for model timeout", { timeout: 5000 }, async t => {
  const process = new NodeProcess();
  const runner = startPlanner(plannerRequest(), "unused", { createProcess: () => /** @type {Process} */ (/** @type {unknown} */ (process)), arguments: [fake, "--result", "hang"] });
  t.after(() => runner.dispose(true));
  runner.dispose(true); runner.dispose(true);
  await process.done; assert.equal(process.closed, true);
  assert.ok(process.waits.every(ms => ms <= 250));
});
