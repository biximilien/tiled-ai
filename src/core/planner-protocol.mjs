import { EditError, requireObject, requireRectangle, requireSelectionContext } from "./edit-protocol.mjs";
import { validateEditPlan } from "./edit-validation.mjs";

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

/** UTF-8 byte count without Node Buffer or browser TextEncoder.
 * @param {string} text
 */
export function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4; i++;
    } else bytes += 3;
  }
  return bytes;
}

/** @typedef {{schemaVersion: number, requestId: string, instruction: string, context: import('./edit-protocol.mjs').SelectionContext}} PlannerRequest */
/** @param {unknown} request @returns {asserts request is PlannerRequest} */
export function requirePlannerRequest(request) {
  try {
    requireObject(request, ["schemaVersion", "requestId", "instruction", "context"], "Request");
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
