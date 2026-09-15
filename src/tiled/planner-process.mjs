import {
  PlannerError, PLANNER_LIMITS, serializePlannerRequest, utf8Bytes, validatePlannerResponse,
} from "../core/planner-protocol.mjs";

// Fixed Node-only bootstrap, never composed from instructions or map data.
// Qt 6.8.1 canonicalPath leaves Windows directory junctions unresolved.
const NODE_BOOTSTRAP = `
import { realpathSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const entry = resolve(dirname(realpathSync(process.argv[1])), "../planner/src/cli.mjs");
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

/** @param {import('../core/planner-protocol.mjs').PlannerRequest} request @param {string} extensionFile */
export function runPlanner(request, extensionFile) {
  const input = serializePlannerRequest(request);
  const args = plannerLaunchArguments(extensionFile);
  const child = new Process();
  let running = false;
  try {
    child.codec = "UTF-8";
    const executable = child.getEnv("TILED_AI_NODE") || "node";
    if (!child.start(executable, args)) {
      throw new PlannerError("START_FAILURE", "Could not start the local planner. Check Node on PATH or TILED_AI_NODE, then restart Tiled.");
    }
    running = true;
    child.write(input);
    child.closeWriteChannel();
    if (!child.waitForFinished(PLANNER_LIMITS.timeoutMs)) {
      throw new PlannerError("TIMEOUT", "The local planner timed out after 5 seconds.");
    }
    running = false;
    const stdout = child.readStdOut();
    const stderr = child.readStdErr();
    if (stderr) tiled.log(`Local planner stderr: ${stderr.slice(0, PLANNER_LIMITS.diagnosticCharacters)}`);
    if (child.exitCode !== 0) {
      const diagnostic = stderr.trim().split("\n")[0].slice(0, 240);
      throw new PlannerError("PROCESS_FAILURE", `Local planner failed (exit ${child.exitCode}). ${diagnostic || "See Tiled's Console for details."}`);
    }
    if (utf8Bytes(stdout) > PLANNER_LIMITS.responseBytes) throw new PlannerError("SIZE_LIMIT", "Planner response exceeds 1 MiB.");
    let response;
    try { response = JSON.parse(stdout); }
    catch (error) { throw new PlannerError("INVALID_RESPONSE", "Local planner did not return one valid JSON document."); }
    return validatePlannerResponse(response, request);
  } finally {
    if (running) {
      child.terminate();
      if (!child.waitForFinished(PLANNER_LIMITS.cleanupMs)) {
        child.kill();
        child.waitForFinished(PLANNER_LIMITS.cleanupMs);
      }
    }
    // Tiled 1.11.2's ScriptProcess destructor calls close() itself, and a
    // second close throws into the JS engine during garbage collection.
    // Leave wrapper disposal to Tiled; the child has finished or been killed.
    // https://github.com/mapeditor/tiled/blob/v1.11.2/src/tiled/scriptprocess.cpp
  }
}
