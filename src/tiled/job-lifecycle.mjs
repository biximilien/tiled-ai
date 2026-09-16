import { JobController } from "../core/job-controller.mjs";
import { JobError, safeJobError } from "../core/job-errors.mjs";
import { fingerprintContext } from "../core/context-fingerprint.mjs";
import { parseJobResponse } from "../core/job-response.mjs";
import { requireSelectionContext, EditError } from "../core/edit-protocol.mjs";
import { startPlanner } from "./planner-process.mjs";
import { readRegionContext } from "./map-reader.mjs";
import { buildTileCatalog, reportCatalog } from "./tile-catalog-reader.mjs";
import { applyEditPlan, validateAndResolveEditPlan, requireWritableTarget } from "./edit-applier.mjs";
import { generationDialog } from "./generation-dialog.mjs";
import { showPlanDialog } from "./plan-dialog.mjs";

/** @typedef {import('../core/planner-protocol.mjs').PlannerRequest} Request */
/** @typedef {{controller:JobController,map:TileMap,layer:TileLayer,dialog:ReturnType<typeof generationDialog>|null,disconnect:()=>void}} Session */
/** The only session-local job owner. Never restored after extension reload. @type {Session|null} */
let session = null;

export function generationState() { return session ? session.controller.state : "idle"; }
export function requireIdleGeneration() {
  if (session) throw new JobError("still_running", "An AI generation job is already running.");
}

/** @param {Layer[]} layers @param {number} id @returns {Layer|null} */
function findLayer(layers, id) {
  for (const layer of layers) {
    if (layer.id === id) return layer;
    if (layer.isGroupLayer) {
      const found = findLayer(/** @type {GroupLayer} */ (layer).layers, id);
      if (found) return found;
    }
  }
  return null;
}

/** @param {TileMap} map @param {TileLayer} layer @param {Request} request */
export function readRelevantContext(map, layer, request) {
  if (!tiled.openAssets.includes(map)) throw new JobError("target_closed", "The target map was closed or reloaded. The map was not changed.");
  if (findLayer(map.layers, request.context.layer.id) !== layer || !layer.isTileLayer) {
    throw new JobError("target_missing", "The target tile layer was removed or replaced. The map was not changed.");
  }
  const context = readRegionContext(map, layer, request.context.selection);
  requireSelectionContext(context);
  const region = context.selection;
  const flags = context.cells.map((row, dy) => row.map((_cell, dx) => layer.flagsAt(region.x + dx, region.y + dy)));
  /** @type {import('../core/context-fingerprint.mjs').RelevantContext} */
  const snapshot = { context, orientation: String(map.orientation), flags };
  if (request.tileCatalog) snapshot.catalog = reportCatalog(buildTileCatalog(map));
  return fingerprintContext(snapshot);
}

/** @param {Session} current */
function clearSession(current) {
  if (session !== current) return;
  current.disconnect();
  if (current.dialog) current.dialog.close();
  current.dialog = null;
  current.controller.clear();
  session = null;
}

/** Cancel running jobs; discard ready jobs or dismiss failures. Safe for X/reentry. */
export function cancelGeneration() {
  const current = session;
  if (!current) return;
  current.controller.cancel();
  clearSession(current);
}

/** @param {Session} current */
function review(current) {
  if (session !== current || current.controller.state !== "ready" || !current.controller.result || !current.controller.job) return;
  if (tiled.activeAsset !== current.map) {
    if (current.dialog) current.dialog.render("The plan is ready. Return to the original map, then click Review Result. No map has been switched or changed.", "Review Result", "Discard");
    return;
  }
  const { plan, metadata } = current.controller.result;
  const context = current.controller.job.request.context;
  const guard = () => {
    if (session !== current) throw new JobError("target_closed", "The generation job is no longer available. The map was not changed.");
    current.controller.assertCurrent();
    if (tiled.activeAsset !== current.map) throw new JobError("stale_context", "Return to the original map before applying. The map was not changed.");
    requireWritableTarget(current.map, current.layer);
  };
  try {
    guard();
    validateAndResolveEditPlan(plan, context, current.map, current.layer, guard);
    if (current.dialog) current.dialog.close();
    if (metadata && metadata.status === "cannot_plan") { showPlanDialog(`${metadata.summary}\n\n${metadata.reason}`, false); return; }
    if (!plan.edits.length) { tiled.log("No changes were proposed."); return; }
    const confirmed = metadata ? showPlanDialog(`${metadata.summary}\n\nApply ${plan.edits.length} tile edits?\nLayer: ${current.layer.name}`)
      : tiled.confirm(`Apply ${plan.edits.length} tile edits?`);
    if (!confirmed) return;
    const count = applyEditPlan(plan, context, current.map, current.layer, guard);
    tiled.log(`Applied ${count} tile edits. Use Ctrl+Z to undo.`);
  } catch (error) {
    tiled.alert(error instanceof EditError ? error.message : safeJobError(error).message);
  } finally { clearSession(current); }
}

export function checkGeneration() {
  const current = session;
  if (!current) return;
  if (current.controller.state === "ready") { review(current); return; }
  if (current.controller.state !== "running") return;
  if (current.dialog) current.dialog.collecting();
  const state = current.controller.check();
  if (state === "ready") { review(current); return; }
  if (!current.dialog) return;
  if (state === "running") current.dialog.render(`The planner is still working.\nElapsed: approximately ${Math.floor(current.controller.elapsedMs() / 1000)} seconds.\n\nYou can continue using Tiled.`, "Check Again");
  else current.dialog.render(current.controller.error ? current.controller.error.message : "Generation stopped. The map was not changed.", null, "Dismiss");
}

/** @param {Request} request @param {TileMap} map @param {TileLayer} layer @param {string} extensionFile */
export function startGeneration(request, map, layer, extensionFile) {
  requireIdleGeneration();
  const fingerprint = readRelevantContext(map, layer, request);
  const controller = new JobController({ startRunner: value => startPlanner(value, extensionFile),
    clock: () => Date.now(), readCurrentContext: () => readRelevantContext(map, layer, request), parseResponse: parseJobResponse });
  controller.start(request, fingerprint);
  const current = { controller, map, layer, dialog: /** @type {ReturnType<typeof generationDialog>|null} */ (null), disconnect: () => {} };
  session = current;
  try {
    const invalidate = (/** @type {Asset} */ asset) => {
      if (session !== current || asset !== map) return;
      cancelGeneration();
      tiled.log("AI generation discarded because its target map was closed or reloaded. No generated edits were applied.");
    };
    /** @type {(() => void)[]} */
    const disconnectors = [];
    current.disconnect = () => { for (const disconnect of disconnectors.splice(0)) disconnect(); };
    tiled.assetAboutToBeClosed.connect(invalidate);
    disconnectors.push(() => tiled.assetAboutToBeClosed.disconnect(invalidate));
    tiled.assetReloaded.connect(invalidate);
    disconnectors.push(() => tiled.assetReloaded.disconnect(invalidate));
    current.dialog = generationDialog(() => { if (session === current) checkGeneration(); }, () => { if (session === current) cancelGeneration(); });
    const region = request.context.selection;
    current.dialog.render(`Creating a plan for ${region.width} × ${region.height} cells…\n\nThe map remains available while generation runs. Click Check Status to collect the result.`);
    current.dialog.show();
  } catch (error) { cancelGeneration(); throw error; }
}
