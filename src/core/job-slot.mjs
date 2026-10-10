import { JobError } from "./job-errors.mjs";
/** @type {object|null} */ let owner = null;
export function requireFreeJobSlot() {
  if (owner)
    throw new JobError(
      "still_running",
      "Finish or close the current generation/tileset-analysis job or review first.",
    );
}
/** @param {object} token */ export function acquireJobSlot(token) {
  requireFreeJobSlot();
  owner = token;
}
/** @param {object} token */ export function releaseJobSlot(token) {
  if (owner === token) owner = null;
}
