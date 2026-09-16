import { requireObject } from "./edit-protocol.mjs";
import { validatePlannerResponse, responseMetadata } from "./planner-protocol.mjs";
import { utf8Bytes } from "./utf8.mjs";
import { JOB_LIMITS, JobError } from "./job-errors.mjs";

/** Safe fixed messages; neither stderr nor provider text is shown as an error.
 * @param {string} code */
export function plannerFailure(code) {
  if (code === "TIMEOUT") return new JobError("timeout", "Generation timed out. The map was not changed.");
  const messages = /** @type {Record<string,string>} */ ({
    CONFIGURATION: "Check TILED_AI_PROVIDER, OPENAI_MODEL and the planner's OPENAI_API_KEY configuration.",
    AUTHENTICATION: "Check OpenAI credentials and model access.", RATE_LIMIT: "OpenAI rate or usage limit reached. Check your quota.",
    NETWORK: "Could not reach OpenAI. Check your connection.", REFUSAL: "OpenAI declined this request. Try another instruction.",
    INCOMPLETE: "The model did not complete its plan. Try a smaller selection.",
    UNSUPPORTED_INSTRUCTION: "Unsupported deterministic instruction. Use fill empty, noop, or fill empty with a tile name.",
    UNKNOWN_TILE: "The requested tile name is not in the catalog.", AMBIGUOUS_TILE: "Use a fully qualified tileset:tile name.",
    EMPTY_CATALOG: "Add ai_name annotations to usable tiles.", MISSING_CATALOG: "A semantic tile catalog is required.",
    PLANNER_FAILURE: "The deterministic planner could not plan this selection. Check that it contains a source tile.",
  });
  return new JobError("process_failed", (messages[code] || "The planner could not produce a valid result.") + " The map was not changed.");
}

/** @typedef {{plan: import('./edit-protocol.mjs').EditPlan, metadata: import('./planner-protocol.mjs').PlanMetadata | null}} JobResult */
/** @param {{exitCode:number,stdout:string,stderr:string}} output
 * @param {import('./planner-protocol.mjs').PlannerRequest} request @returns {JobResult} */
export function parseJobResponse(output, request) {
  if (utf8Bytes(output.stdout) > JOB_LIMITS.stdoutBytes) throw new JobError("response_too_large", "The planner response is too large. The map was not changed.");
  if (output.exitCode !== 0) throw new JobError("process_failed", "The planner process failed. Check the Node installation. The map was not changed.");
  let response;
  try { response = JSON.parse(output.stdout); }
  catch (error) { throw new JobError("malformed_response", "The planner returned invalid JSON. The map was not changed."); }
  if (!response || response.schemaVersion !== 1) throw new JobError("protocol_mismatch", "Unsupported planner response version. The map was not changed.");
  if (response.requestId !== request.requestId) throw new JobError("request_id_mismatch", "The planner response belongs to another request. The map was not changed.");
  if (Object.prototype.hasOwnProperty.call(response, "error")) {
    try {
      requireObject(response, ["schemaVersion", "requestId", "error"], "Error response");
      requireObject(response.error, ["code"], "Planner error");
      if (typeof response.error.code !== "string" || !/^[A-Z_]{1,64}$/.test(response.error.code)) throw new Error("Invalid error code");
    } catch (error) { throw new JobError("malformed_response", "The planner returned an invalid error response. The map was not changed."); }
    throw plannerFailure(response.error.code);
  }
  try {
    const plan = validatePlannerResponse(response, request);
    return { plan, metadata: Object.prototype.hasOwnProperty.call(response, "metadata") ? responseMetadata(response.metadata) : null };
  } catch (error) { throw new JobError("invalid_plan", "The planner returned an invalid plan. The map was not changed."); }
}
