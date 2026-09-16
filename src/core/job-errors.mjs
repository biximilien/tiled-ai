import { EditError } from "./edit-protocol.mjs";

export const JOB_LIMITS = Object.freeze({ stdoutBytes: 1024 * 1024, stderrBytes: 16 * 1024,
  watchdogMs: 32000, overdueMs: 35000, cleanupMs: 250 });
// Only the fixed Tiled launcher uses this; the standalone CLI still exits 0.
export const TILED_SUCCESS_EXIT = 73;

export class JobError extends EditError {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {unknown} error */
export function safeJobError(error) {
  return error instanceof JobError ? error : new JobError("internal_error", "Generation failed unexpectedly. The map was not changed.");
}
