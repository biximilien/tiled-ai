import { writeSync } from "node:fs";
import { planRequest } from "./provider-router.mjs";
import { startWatchdog } from "./watchdog.mjs";
import { CatalogError } from "../../src/core/tile-catalog.mjs";
import { PlannerError, PLANNER_LIMITS, requirePlannerRequest, validatePlannerResponse } from "../../src/core/planner-protocol.mjs";

/** Test injection is programmatic, never selected from a model/user request.
 * @param {{plan?:typeof planRequest, timeoutMs?:number}} [options] */
export async function runPlannerCli(options = {}) {
  /** @type {import('../../src/core/planner-protocol.mjs').PlannerRequest|null} */
  let request = null;
  let writing = false;
  const stopWatchdog = startWatchdog(() => {
    // Never append an error to a partially written success response.
    if (request && !writing) {
      try { writeSync(1, JSON.stringify({ schemaVersion: 1, requestId: request.requestId, error: { code: "TIMEOUT" } }) + "\n"); }
      catch { process.exit(1); }
      process.exit(0);
    }
    process.exit(1);
  }, options.timeoutMs);
  /** @param {unknown} response */
  async function write(response) {
    const output = JSON.stringify(response);
    if (Buffer.byteLength(output, "utf8") > PLANNER_LIMITS.responseBytes) throw new PlannerError("SIZE_LIMIT", "Planner response exceeds 1 MiB.");
    writing = true;
    await new Promise((resolve, reject) => process.stdout.write(output + "\n", error => error ? reject(error) : resolve(undefined)));
  }
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > PLANNER_LIMITS.requestBytes) throw new PlannerError("SIZE_LIMIT", "Planner request exceeds 1 MiB.");
      chunks.push(chunk);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new PlannerError("MALFORMED_JSON", "Request must be exactly one JSON document."); }
    requirePlannerRequest(value);
    request = value;
    const response = await (options.plan || planRequest)(request, process.env);
    validatePlannerResponse(response, request);
    await write(response);
  } catch (error) {
    if (request && !writing && (error instanceof PlannerError || error instanceof CatalogError)) {
      await write({ schemaVersion: 1, requestId: request.requestId, error: { code: error.code } });
    } else {
      const code = error instanceof PlannerError || error instanceof CatalogError ? error.code : "INTERNAL_ERROR";
      process.stderr.write(`[${code}] Local planner could not complete the request.\n`);
      process.exitCode = 1;
    }
  } finally { stopWatchdog(); }
}
