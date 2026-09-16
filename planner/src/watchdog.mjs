import { JOB_LIMITS } from "../../src/core/job-errors.mjs";

/** A referenced timer keeps the CLI alive even if a provider never settles.
 * @param {() => void} expire @param {number} [timeoutMs] */
export function startWatchdog(expire, timeoutMs = JOB_LIMITS.watchdogMs) {
  const timer = setTimeout(expire, timeoutMs);
  return () => clearTimeout(timer);
}
