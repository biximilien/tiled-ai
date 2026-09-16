import {
  PlannerError, serializePlannerRequest,
} from "../core/planner-protocol.mjs";
import { plannerProvider } from "../core/model-limits.mjs";
import { JOB_LIMITS, JobError, TILED_SUCCESS_EXIT } from "../core/job-errors.mjs";

// Read only a non-secret provider switch. Native GC owns this wrapper, too.
export function usesModelPlanner() {
  try { return plannerProvider(new Process().getEnv("TILED_AI_PROVIDER")) !== "deterministic"; }
  catch (error) { throw new PlannerError("CONFIGURATION", "Unsupported TILED_AI_PROVIDER. Use deterministic or openai."); }
}

// Fixed Node-only bootstrap, never composed from instructions or map data.
// Qt 6.8.1 canonicalPath leaves Windows directory junctions unresolved.
const NODE_BOOTSTRAP = `
import { realpathSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// QProcess.waitForFinished(0) returns false if the event loop already reaped
// a successful child. A nonzero transport success code makes exit observable.
process.on("exit", code => { if (code === 0) process.exitCode = ${TILED_SUCCESS_EXIT}; });
const entry = resolve(dirname(realpathSync(process.argv[1])), process.env.TILED_AI_TEST_MODE === "1"
  ? "../planner/fixtures/fake-planner.mjs" : "../planner/src/cli.mjs");
if (!existsSync(entry)) {
  process.stderr.write("[MISSING_PLANNER] Local planner entry point not found. Keep planner/ beside src/.\\n");
  process.exitCode = 1;
} else {
  await import(pathToFileURL(entry).href);
}
`;

/** Node resolves the junction before walking to the sibling planner directory.
 * @param {string} extensionFile Captured __filename of main.mjs at startup.
 */
export function plannerLaunchArguments(extensionFile) {
  const canonical = FileInfo.canonicalPath(extensionFile);
  if (!canonical || !File.exists(canonical)) throw new PlannerError("MISSING_PLANNER", "Extension entry point not found. Check the development junction.");
  return ["--input-type=module", "--eval", NODE_BOOTSTRAP, canonical];
}

/** Retain the native wrapper until collection or cancellation; no network wait.
 * @param {import('../core/planner-protocol.mjs').PlannerRequest} request @param {string} extensionFile
 * @param {{createProcess?:()=>Process, arguments?:string[]}} [host]
 * @returns {import('../core/job-controller.mjs').Runner} */
export function startPlanner(request, extensionFile, host = {}) {
  const input = serializePlannerRequest(request);
  const args = host.arguments || plannerLaunchArguments(extensionFile);
  /** @type {Process|null} */
  let child = host.createProcess ? host.createProcess() : new Process();
  /** @type {'starting'|'running'|'finished'|'disposed'} */
  let state = "starting";
  /** Exactly-once logical disposal. Tiled 1.11.2 native destructor owns close.
   * @param {boolean} [stop] */
  function dispose(stop = false) {
    if (!child) return;
    const process = child;
    child = null;
    const previous = state;
    state = "disposed";
    if (stop && previous !== "finished") {
      try { process.terminate(); }
      catch (error) { /* Still attempt kill. */ }
      try { if (process.waitForFinished(JOB_LIMITS.cleanupMs)) return; }
      catch (error) { /* Still attempt kill. */ }
      try { process.kill(); process.waitForFinished(JOB_LIMITS.cleanupMs); }
      catch (error) { /* Native destructor remains the last resource owner. */ }
    }
    // Do NOT call native close(): its destructor calls it again and raises
    // "Access to Process object that was already closed" in Tiled 1.11.2.
    // Releasing our last reference lets native disposal happen once.
    // https://github.com/mapeditor/tiled/blob/v1.11.2/src/tiled/scriptprocess.cpp
  }
  try {
    child.codec = "UTF-8";
    const executable = child.getEnv("TILED_AI_NODE") || "node";
    if (!child.start(executable, args)) {
      throw new JobError("start_failed", "Could not start the AI planner. Check Node on PATH or TILED_AI_NODE. The map was not changed.");
    }
    state = "running";
    child.write(input);
    child.closeWriteChannel();
  } catch (error) {
    dispose(true);
    if (error instanceof JobError) throw error;
    throw new JobError("start_failed", "Could not initialize the planner process. The map was not changed.");
  }
  return {
    finished() {
      if (state === "finished") return true;
      if (!child) return false;
      if (child.waitForFinished(0) || child.exitCode !== 0) { state = "finished"; return true; }
      return false;
    },
    collect() {
      if (!child || state !== "finished") throw new JobError("internal_error", "Cannot collect an unfinished planner.");
      try {
        const code = child.exitCode;
        const stdout = child.readStdOut();
        // Retain at most 16 KiB even for worst-case UTF-8 (including emoji).
        const stderr = child.readStdErr().slice(0, Math.floor(JOB_LIMITS.stderrBytes / 4));
        return { exitCode: code === TILED_SUCCESS_EXIT ? 0 : code, stdout, stderr };
      } finally { dispose(); }
    },
    dispose,
  };
}
