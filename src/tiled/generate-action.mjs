import { requireSelectionContext, requireValid } from "../core/edit-protocol.mjs";
import { PLANNER_LIMITS } from "../core/planner-protocol.mjs";
import { readSelectionContext } from "./map-reader.mjs";
import { requireCurrentTarget } from "./edit-applier.mjs";
import { usesModelPlanner } from "./planner-process.mjs";
import { MODEL_LIMITS } from "../core/model-limits.mjs";
import { requireIdleGeneration, startGeneration } from "./job-lifecycle.mjs";
import { isSemanticInstruction } from "../core/tile-catalog.mjs";
import { buildTileCatalog, reportCatalog } from "./tile-catalog-reader.mjs";

let requestCounter = 0;

/** @param {string} extensionFile */
export function generateFromInstruction(extensionFile) {
  requireIdleGeneration();
  const asset = tiled.activeAsset;
  const modelMode = usesModelPlanner();
  const context = readSelectionContext(asset, modelMode ? MODEL_LIMITS.selectedCells : PLANNER_LIMITS.selectedCells);
  requireSelectionContext(context);
  const map = /** @type {TileMap} */ (asset);
  const layer = /** @type {TileLayer} */ (map.currentLayer);
  requireCurrentTarget(map, layer);
  const instruction = tiled.prompt(modelMode ? "Describe what to generate. Check Status will collect the result while you continue using Tiled." : "Instruction: fill empty cells, fill empty, noop, or fill empty with <name>", "fill empty cells", "Planner prototype");
  if (!instruction || !instruction.trim()) return;
  /** @type {import('../core/planner-protocol.mjs').PlannerRequest} */
  const request = {
    schemaVersion: 1,
    requestId: `${Date.now()}-${++requestCounter}`,
    instruction,
    context,
  };
  if (modelMode || isSemanticInstruction(instruction)) request.tileCatalog = reportCatalog(buildTileCatalog(map));
  requireCurrentTarget(map, layer);
  requireValid(JSON.stringify(readSelectionContext(map, modelMode ? MODEL_LIMITS.selectedCells : PLANNER_LIMITS.selectedCells)) === JSON.stringify(context),
    "The map selection or its contents changed before generation could start.");
  startGeneration(request, map, layer, extensionFile);
}
