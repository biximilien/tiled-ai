import { JOB_LIMITS, JobError, safeJobError } from "./job-errors.mjs";

/** @typedef {'idle'|'running'|'collecting'|'ready'|'failed'|'stale'|'cancelling'|'cancelled'} JobState */
/** @typedef {import('./planner-protocol.mjs').PlannerRequest} Request */
/** @typedef {{finished:()=>boolean, collect:()=>{exitCode:number,stdout:string,stderr:string}, dispose:(stop?:boolean)=>void}} Runner */
/** @typedef {{startRunner:(request:Request)=>Runner, clock:()=>number, readCurrentContext:()=>string,
 * parseResponse:(output:ReturnType<Runner['collect']>,request:Request)=>import('./job-response.mjs').JobResult}} Dependencies */
const transitions = /** @type {Record<JobState,JobState[]>} */ ({
  idle: ["running"], running: ["running", "collecting", "cancelling"],
  collecting: ["ready", "failed", "stale"], cancelling: ["cancelled"],
  ready: ["idle"], failed: ["idle"], stale: ["idle"], cancelled: ["idle"],
});

export class JobController {
  /** @param {Dependencies} dependencies */
  constructor(dependencies) {
    this.dependencies = dependencies;
    /** @type {JobState} */ this.state = "idle";
    /** @type {{request:Request, fingerprint:string, startedAtMs:number, runner:Runner|null}|null} */ this.job = null;
    /** @type {import('./job-response.mjs').JobResult|null} */ this.result = null;
    /** @type {JobError|null} */ this.error = null;
  }
  /** @param {JobState} next */
  transition(next) {
    if (!transitions[this.state].includes(next)) throw new JobError("internal_error", "Invalid generation state transition.");
    this.state = next;
  }
  /** @param {Request} request @param {string} fingerprint */
  start(request, fingerprint) {
    if (this.state !== "idle") throw new JobError("still_running", "An AI generation job is already running.");
    // Own an independent snapshot, never the caller's mutable request.
    const copy = /** @type {Request} */ (JSON.parse(JSON.stringify(request)));
    const startedAtMs = this.dependencies.clock();
    const runner = this.dependencies.startRunner(copy);
    this.job = { request: copy, fingerprint, startedAtMs, runner };
    this.transition("running");
  }
  elapsedMs() { return this.job ? Math.max(0, this.dependencies.clock() - this.job.startedAtMs) : 0; }
  /** @param {boolean} [stop] */
  release(stop = false) {
    if (!this.job || !this.job.runner) return;
    const runner = this.job.runner;
    this.job.runner = null;
    runner.dispose(stop);
  }
  check() {
    if (this.state !== "running" || !this.job || !this.job.runner) return this.state;
    try {
      if (!this.job.runner.finished()) {
        if (this.elapsedMs() <= JOB_LIMITS.overdueMs) { this.transition("running"); return this.state; }
        this.transition("collecting");
        this.release(true);
        throw new JobError("timeout", "Generation timed out. The map was not changed.");
      }
      this.transition("collecting");
      let output;
      try { output = this.job.runner.collect(); }
      finally { this.release(); }
      this.result = this.dependencies.parseResponse(output, this.job.request);
      try { this.assertCurrent(); }
      catch (error) {
        this.error = error instanceof JobError ? error : new JobError("stale_context", "The target context can no longer be read. The map was not changed.");
        this.result = null; this.job = null; this.transition("stale"); return this.state;
      }
      this.transition("ready");
    } catch (error) {
      if (this.state === "running") this.transition("collecting");
      try { this.release(true); } catch (cleanupError) { /* Keep original safe failure. */ }
      this.error = safeJobError(error); this.result = null; this.job = null;
      this.transition("failed");
    }
    return this.state;
  }
  assertCurrent() {
    if (!this.job || this.dependencies.readCurrentContext() !== this.job.fingerprint) {
      throw new JobError("stale_context", "The target area or catalog changed while generation was running. Generate again. The map was not changed.");
    }
  }
  cancel() {
    if (this.state !== "running") return;
    this.transition("cancelling");
    try { this.release(true); }
    catch (error) { this.error = safeJobError(error); }
    finally { this.job = null; this.result = null; this.transition("cancelled"); }
  }
  clear() {
    if (this.state === "idle") return;
    this.transition("idle");
    this.job = null; this.result = null; this.error = null;
  }
}
