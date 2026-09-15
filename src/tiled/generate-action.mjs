import { requireSelectionContext } from "../core/edit-protocol.mjs";
import { PLANNER_LIMITS } from "../core/planner-protocol.mjs";
import { readSelectionContext } from "./map-reader.mjs";
import { applyEditPlan, requireCurrentTarget, validateAndResolveEditPlan } from "./edit-applier.mjs";
import { runPlanner, usesModelPlanner } from "./planner-process.mjs";
import { MODEL_LIMITS } from "../core/model-limits.mjs";
import { showPlanDialog } from "./plan-dialog.mjs";
import { isSemanticInstruction } from "../core/tile-catalog.mjs";
import { buildTileCatalog, reportCatalog } from "./tile-catalog-reader.mjs";

let requestCounter = 0;

/** @param {string} extensionFile */
export function generateFromInstruction(extensionFile) {
  const asset = tiled.activeAsset;
  const modelMode = usesModelPlanner();
  const context = readSelectionContext(asset, modelMode ? MODEL_LIMITS.selectedCells : PLANNER_LIMITS.selectedCells);
  requireSelectionContext(context);
  const map = /** @type {TileMap} */ (asset);
  const layer = /** @type {TileLayer} */ (map.currentLayer);
  requireCurrentTarget(map, layer);
  const instruction = tiled.prompt(modelMode ? "Describe what to generate. Tiled may be unresponsive for up to 30 seconds." : "Instruction: fill empty cells, fill empty, noop, or fill empty with <name>", "fill empty cells", "Planner prototype");
  if (!instruction || !instruction.trim()) return;
  /** @type {import('../core/planner-protocol.mjs').PlannerRequest} */
  const request = {
    schemaVersion: 1,
    requestId: `${Date.now()}-${++requestCounter}`,
    instruction,
    context,
  };
  if (modelMode || isSemanticInstruction(instruction)) request.tileCatalog = reportCatalog(buildTileCatalog(map));
  /** @type {{value: import('../core/planner-protocol.mjs').PlanMetadata | null}} */
  const metadata = { value: null };
  const plan = runPlanner(request, extensionFile, value => { metadata.value = value; });
  validateAndResolveEditPlan(plan, context, map, layer);
  if (metadata.value && metadata.value.status === "cannot_plan") {
    showPlanDialog(`${metadata.value.summary}\n\n${metadata.value.reason}`, false);
    return;
  }
  if (!plan.edits.length) { tiled.log("No changes were proposed."); return; }
  const confirmed = metadata.value ? showPlanDialog(`${metadata.value.summary}\n\nApply ${plan.edits.length} tile edits?\nLayer: ${context.layer.name}`) : tiled.confirm(`Apply ${plan.edits.length} tile edits?`);
  if (!confirmed) return;
  const count = applyEditPlan(plan, context, map, layer);
  tiled.log(`Applied ${count} tile edits. Use Ctrl+Z to undo.`);
}
