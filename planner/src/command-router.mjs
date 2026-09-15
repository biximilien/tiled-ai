import { planFillEmptyCells, planFillWithTile } from "../../src/core/fill-empty-planner.mjs";
import { CatalogError, isSemanticInstruction, lookupSemanticTile } from "../../src/core/tile-catalog.mjs";
import { PlannerError, requirePlannerRequest } from "../../src/core/planner-protocol.mjs";

/** @param {unknown} request */
export function routeRequest(request) {
  requirePlannerRequest(request);
  const instruction = request.instruction.trim().toLowerCase();
  if (isSemanticInstruction(instruction)) {
    if (!request.tileCatalog) throw new CatalogError("MISSING_CATALOG", "This command requires a tile catalog. Add ai_name to tiles and generate from Tiled.");
    const reference = request.instruction.trim().slice("fill empty with".length).trim();
    const tile = lookupSemanticTile(request.tileCatalog, reference);
    return { schemaVersion: 1, requestId: request.requestId, plan: planFillWithTile(request.context, tile) };
  }
  if (!["fill empty cells", "fill empty", "noop"].includes(instruction)) {
    throw new PlannerError("UNSUPPORTED_INSTRUCTION", "Supported instructions: fill empty cells, fill empty, noop, fill empty with <name>.");
  }
  try {
    const selection = request.context.selection;
    const plan = instruction === "noop" ? {
      schemaVersion: 1,
      target: { layerId: request.context.layer.id, selection: {
        x: selection.x, y: selection.y, width: selection.width, height: selection.height,
      } },
      edits: [],
    } : planFillEmptyCells(request.context);
    return { schemaVersion: 1, requestId: request.requestId, plan };
  } catch (error) {
    throw new PlannerError("PLANNER_FAILURE", error instanceof Error ? error.message : String(error));
  }
}
