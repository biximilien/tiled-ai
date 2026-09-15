import { routeRequest } from "./command-router.mjs";
import { PlannerError, PLANNER_LIMITS, validatePlannerResponse } from "../../src/core/planner-protocol.mjs";

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > PLANNER_LIMITS.requestBytes) throw new PlannerError("SIZE_LIMIT", "Planner request exceeds 1 MiB.");
    chunks.push(chunk);
  }
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PlannerError("MALFORMED_JSON", "Request must be exactly one JSON document."); }
  const response = routeRequest(request);
  validatePlannerResponse(response, request);
  const output = JSON.stringify(response);
  if (Buffer.byteLength(output, "utf8") > PLANNER_LIMITS.responseBytes) {
    throw new PlannerError("SIZE_LIMIT", "Planner response exceeds 1 MiB.");
  }
  await new Promise((resolve, reject) => process.stdout.write(output + "\n", error => error ? reject(error) : resolve(undefined)));
} catch (error) {
  if (error instanceof PlannerError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
  } else {
    process.stderr.write(`[INTERNAL_ERROR] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
