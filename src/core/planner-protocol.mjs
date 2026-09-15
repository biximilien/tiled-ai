import { EditError, requireObject, requireRectangle, requireSelectionContext } from "./edit-protocol.mjs";
import { validateEditPlan } from "./edit-validation.mjs";
import { requireTileCatalog } from "./tile-catalog.mjs";
import { utf8Bytes } from "./utf8.mjs";
export { utf8Bytes } from "./utf8.mjs";

export const PLANNER_LIMITS = Object.freeze({
  instructionCharacters: 2000,
  selectedCells: 4096,
  requestBytes: 1024 * 1024,
  responseBytes: 1024 * 1024,
  timeoutMs: 5000,
  cleanupMs: 250,
  diagnosticCharacters: 4000,
});

export class PlannerError extends EditError {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @typedef {{schemaVersion: number, requestId: string, instruction: string, context: import('./edit-protocol.mjs').SelectionContext, tileCatalog?: import('./tile-catalog.mjs').TileCatalog}} PlannerRequest */
/** @param {unknown} request @returns {asserts request is PlannerRequest} */
export function requirePlannerRequest(request) {
  try {
    const keys = ["schemaVersion", "requestId", "instruction", "context"];
    if (request && Object.prototype.hasOwnProperty.call(request, "tileCatalog")) keys.push("tileCatalog");
    requireObject(request, keys, "Request");
  } catch (error) {
    throw new PlannerError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
  }
  if (request.schemaVersion !== 1) throw new PlannerError("UNSUPPORTED_SCHEMA", "Unsupported request schema version.");
  if (typeof request.requestId !== "string" || !request.requestId.trim() ||
      typeof request.instruction !== "string" || !request.instruction.trim() ||
      request.instruction.length > PLANNER_LIMITS.instructionCharacters) {
    throw new PlannerError("INVALID_REQUEST", "Request ID and instruction must be non-empty strings; instruction limit is 2,000 characters.");
  }
  try {
    requireObject(request.context, ["schemaVersion", "map", "layer", "selection", "cells"], "Context");
    requireRectangle(request.context.selection);
    if (request.context.selection.width * request.context.selection.height > PLANNER_LIMITS.selectedCells) {
      throw new Error("Select at most 4,096 cells.");
    }
    requireSelectionContext(request.context);
  } catch (error) {
    throw new PlannerError("INVALID_CONTEXT", error instanceof Error ? error.message : String(error));
  }
  if (Object.prototype.hasOwnProperty.call(request, "tileCatalog")) requireTileCatalog(request.tileCatalog);
}

/** @param {PlannerRequest} request */
export function serializePlannerRequest(request) {
  requirePlannerRequest(request);
  const json = JSON.stringify(request);
  if (utf8Bytes(json) > PLANNER_LIMITS.requestBytes) throw new PlannerError("SIZE_LIMIT", "Planner request exceeds 1 MiB.");
  return json;
}

/** @param {unknown} response @param {PlannerRequest} request */
export function validatePlannerResponse(response, request) {
  requirePlannerRequest(request);
  try {
    requireObject(response, ["schemaVersion", "requestId", "plan"], "Response");
    if (response.schemaVersion !== 1) throw new Error("Unsupported response schema version.");
    if (response.requestId !== request.requestId) throw new Error("Planner response request ID does not match.");
  } catch (error) {
    throw new PlannerError("INVALID_RESPONSE", error instanceof Error ? error.message : String(error));
  }
  return validateEditPlan(response.plan, request.context);
}
