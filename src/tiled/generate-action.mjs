import { requireSelectionContext } from "../core/edit-protocol.mjs";
import { PLANNER_LIMITS } from "../core/planner-protocol.mjs";
import { readSelectionContext } from "./map-reader.mjs";
import { applyEditPlan, requireCurrentTarget, validateAndResolveEditPlan } from "./edit-applier.mjs";
import { runPlanner } from "./planner-process.mjs";
import { isSemanticInstruction } from "../core/tile-catalog.mjs";
import { buildTileCatalog, reportCatalog } from "./tile-catalog-reader.mjs";

let requestCounter = 0;

/** @param {string} extensionFile */
export function generateFromInstruction(extensionFile) {
  const asset = tiled.activeAsset;
  const context = readSelectionContext(asset, PLANNER_LIMITS.selectedCells);
  requireSelectionContext(context);
  const map = /** @type {TileMap} */ (asset);
  const layer = /** @type {TileLayer} */ (map.currentLayer);
  requireCurrentTarget(map, layer);
  const instruction = tiled.prompt("Instruction: fill empty cells, fill empty, noop, or fill empty with <name>", "fill empty cells", "Local planner prototype");
  if (!instruction || !instruction.trim()) return;
  /** @type {import('../core/planner-protocol.mjs').PlannerRequest} */
  const request = {
    schemaVersion: 1,
    requestId: `${Date.now()}-${++requestCounter}`,
    instruction,
    context,
  };
  if (isSemanticInstruction(instruction)) request.tileCatalog = reportCatalog(buildTileCatalog(map));
  const plan = runPlanner(request, extensionFile);
  validateAndResolveEditPlan(plan, context, map, layer);
  if (!plan.edits.length) { tiled.log("No changes were proposed."); return; }
  if (!tiled.confirm(`Apply ${plan.edits.length} tile edits?`)) return;
  const count = applyEditPlan(plan, context, map, layer);
  tiled.log(`Applied ${count} tile edits. Use Ctrl+Z to undo.`);
}
