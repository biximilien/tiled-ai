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
import { ReviewController } from "../core/review-controller.mjs";
import { serializePlannerRequest } from "../core/planner-protocol.mjs";
import { buildPreview, requirePreviewGeometry, previewTargetVisible } from "./preview-builder.mjs";
import { bindPreviewTool, previewToolActive, showPreview, clearPreview } from "./preview-tool.mjs";
import { reviewDialog } from "./review-dialog.mjs";

/** @typedef {import('../core/planner-protocol.mjs').PlannerRequest} Request */
/** @typedef {{controller:JobController,map:TileMap,layer:TileLayer,dialog:ReturnType<typeof generationDialog>|null,
 * review:ReviewController|null, reviewUI:ReturnType<typeof reviewDialog>|null, unbind:()=>void, extensionFile:string, disconnect:()=>void}} Session */
/** The only session-local job owner. Never restored after extension reload. @type {Session|null} */
let session = null;
let reviewCounter = 0;

export function generationState() { return session ? session.controller.state : "idle"; }
export function requireIdleGeneration() {
  if (session && session.review) throw new JobError("still_running", "A tile review is pending. Use Apply, Discard, or Regenerate in AI tile review.");
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
  if (current.review) current.review.discard(current.review.id);
  current.unbind();
  if (current.reviewUI) current.reviewUI.close();
  current.review = null; current.reviewUI = null;
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
  if (current.review) { refreshReview(); return; }
  const { plan, metadata } = current.controller.result;
  const context = current.controller.job.request.context;
  const guard = () => {
    if (session !== current) throw new JobError("target_closed", "The generation job is no longer available. The map was not changed.");
    current.controller.assertCurrent();
    requireWritableTarget(current.map, current.layer);
    if (plan.edits.length) requirePreviewGeometry(current.map, current.layer);
  };
  try {
    guard();
    validateAndResolveEditPlan(plan, context, current.map, current.layer, guard);
    if (current.dialog) current.dialog.close();
    if (metadata && metadata.status === "cannot_plan") { showPlanDialog(`${metadata.summary}\n\n${metadata.reason}`, false); clearSession(current); return; }
    if (!plan.edits.length) { tiled.log("No changes were proposed."); clearSession(current); return; }
    const id = `${current.controller.job.request.requestId}:review:${++reviewCounter}`;
    current.review = new ReviewController(id, plan, context, {
      validate: canonical => validateAndResolveEditPlan(canonical, context, current.map, current.layer, guard),
      canShow: () => tiled.activeAsset === current.map && current.map.currentLayer === current.layer && previewToolActive(current.map) && previewTargetVisible(current.layer),
      render: placements => showPreview(buildPreview(current.map, placements)), hide: clearPreview,
      apply: (canonical, placements) => applyEditPlan(canonical, context, current.map, current.layer, guard, placements),
    });
    current.unbind = bindPreviewTool(() => { if (session === current) refreshReview(); },
      () => { if (session === current) cancelGeneration(); }, () => applyReview(id));
    current.reviewUI = reviewDialog(() => applyReview(id), () => { if (session === current) cancelGeneration(); },
      () => regenerateReview(id), () => { if (session === current) refreshReview(); });
    current.reviewUI.show();
    refreshReview();
  } catch (error) {
    tiled.alert(error instanceof EditError ? error.message : safeJobError(error).message);
    clearSession(current);
  }
}

export function refreshReview() {
  const current = session;
  if (!current || !current.review || !current.reviewUI) return;
  const review = current.review;
  review.refresh();
  const summary = current.controller.result && current.controller.result.metadata ? current.controller.result.metadata.summary : "Review the proposed tile placements.";
  const status = review.state === "stale" ? review.message : review.previewVisible ? "Preview shown. Press Enter over the map to Apply; Escape discards." : "Return to the original map and layer. Select the AI Preview toolbar tool and move over the map. Hidden layers must be made visible. Apply is disabled while the preview is hidden.";
  const layerName = current.controller.job ? current.controller.job.request.context.layer.name : "Original layer";
  current.reviewUI.render(`${summary}\n\n${review.plan.edits.length} tile edits\nLayer: ${layerName}\n\n${status}`, review.previewVisible && review.state === "reviewing");
}

/** @param {string} [id] */
export function applyReview(id) {
  const current = session;
  if (!current || !current.review || (id !== undefined && id !== current.review.id)) return;
  const review = current.review;
  // The handler is synchronous: the state guard prevents duplicate/late Apply.
  if (current.reviewUI) current.reviewUI.render("Validating before application…", false, false);
  const count = review.apply(review.id);
  if (review.state === "applied") { tiled.log(`Applied ${count} tile edits. Use Ctrl+Z to undo.`); clearSession(current); }
  else if (review.state === "failed") { tiled.alert(review.message); clearSession(current); }
  else refreshReview();
}

/** Original region/instruction, fresh data, new ID; prepare before discarding.
 * @param {string} [id] */
export function regenerateReview(id) {
  const current = session;
  if (!current || !current.review || !current.controller.job || (id !== undefined && id !== current.review.id)) return;
  if (current.review.state !== "reviewing" && current.review.state !== "stale") return;
  try {
    const old = current.controller.job.request;
    readRelevantContext(current.map, current.layer, old); // verifies asset/layer identity, without requiring the old fingerprint
    requireWritableTarget(current.map, current.layer);
    requirePreviewGeometry(current.map, current.layer);
    const request = { schemaVersion: 1, requestId: `${Date.now()}-regenerate-${++reviewCounter}`, instruction: old.instruction,
      context: readRegionContext(current.map, current.layer, old.context.selection) };
    if (old.tileCatalog) Object.assign(request, { tileCatalog: reportCatalog(buildTileCatalog(current.map)) });
    serializePlannerRequest(request);
    clearSession(current);
    startGeneration(request, current.map, current.layer, current.extensionFile);
  } catch (error) {
    tiled.alert(error instanceof Error ? error.message : "Could not regenerate. No new job was started.");
  }
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
  /** @type {Session} */
  const current = { controller, map, layer, dialog: null, review: null, reviewUI: null, unbind: () => {}, extensionFile, disconnect: () => {} };
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
    const refresh = () => { if (session === current) refreshReview(); };
    tiled.activeAssetChanged.connect(refresh);
    disconnectors.push(() => tiled.activeAssetChanged.disconnect(refresh));
    map.currentLayerChanged.connect(refresh);
    disconnectors.push(() => map.currentLayerChanged.disconnect(refresh));
    map.regionEdited.connect(refresh);
    disconnectors.push(() => map.regionEdited.disconnect(refresh));
    current.dialog = generationDialog(() => { if (session === current) checkGeneration(); }, () => { if (session === current) cancelGeneration(); });
    const region = request.context.selection;
    current.dialog.render(`Creating a plan for ${region.width} × ${region.height} cells…\n\nThe map remains available while generation runs. Click Check Status to collect the result.`);
    current.dialog.show();
  } catch (error) { cancelGeneration(); throw error; }
}
