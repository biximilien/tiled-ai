import assert from "node:assert/strict";
import { routeRequest } from "../../planner/src/command-router.mjs";

/** Install small Tiled path/process fakes, restored after each test.
 * @param {import('node:test').TestContext} t
 */
export function plannerHost(t) {
  /** @type {string[]} */
  const events = [];
  const state = {
    started: true, exitCode: 0, stderr: "", stdout: /** @type {string | null} */ (null),
    waits: [true], override: "", exists: true,
    request: /** @type {import('../../src/core/planner-protocol.mjs').PlannerRequest | null} */ (null),
  };
  /** @type {Child[]} */
  const wrappers = [];
  class Child {
    closed = false;
    constructor() { wrappers.push(this); }
    codec = "";
    get exitCode() { return state.exitCode; }
    /** @param {string} name */
    getEnv(name) { assert.equal(name, "TILED_AI_NODE"); return state.override; }
    /** @param {string} executable @param {string[]} args */
    start(executable, args) {
      assert.equal(executable, state.override || "node");
      assert.deepEqual(args.slice(0, 2), ["--input-type=module", "--eval"]);
      assert.match(args[2], /realpathSync/);
      assert.equal(args[3], "C:/repo with spaces/src/main.mjs");
      assert.equal(this.codec, "UTF-8");
      events.push("start"); return state.started;
    }
    /** @param {string} text */
    write(text) { events.push("write"); state.request = JSON.parse(text); }
    closeWriteChannel() { events.push("stdin-close"); }
    /** @param {number} timeout */
    waitForFinished(timeout) { events.push(`wait:${timeout}`); return state.waits.length ? state.waits.shift() : true; }
    readStdOut() { return state.stdout === null ? JSON.stringify(routeRequest(state.request)) : state.stdout; }
    readStdErr() { return state.stderr; }
    terminate() { events.push("terminate"); }
    kill() { events.push("kill"); }
    close() {
      if (this.closed) throw new Error("Access to Process object that was already closed.");
      this.closed = true;
      events.push("close");
    }
  }
  const globals = {
    Process: Child,
    File: { exists: () => state.exists },
    FileInfo: {
      canonicalPath: () => "C:/repo with spaces/src/main.mjs",
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  // Tiled 1.11.2's native destructor calls close(), even after an explicit close.
  function collectGarbage() {
    for (const wrapper of wrappers.splice(0)) wrapper.close();
  }
  return { state, events, collectGarbage };
}
