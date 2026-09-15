import { isTileMapAsset } from "../core/validation.mjs";
import { readSelectionContext, SelectionError } from "./map-reader.mjs";
import { EditError } from "../core/edit-protocol.mjs";
import { planFillEmptyCells } from "../core/fill-empty-planner.mjs";
import { applyEditPlan } from "./edit-applier.mjs";
import { generateFromInstruction } from "./generate-action.mjs";

/** @param {string} [extensionFile] Startup main.mjs path, captured before callbacks. */
export function registerActions(extensionFile = "") {
  const action = tiled.registerAction("TiledAiHello", function () {
    const map = tiled.activeAsset;

    if (!isTileMapAsset(map)) {
      tiled.alert("Open a tile map first.");
      return;
    }

    // Tiled's Asset typings do not narrow the subtype via isTileMap.
    const tileMap = /** @type {TileMap} */ (map);
    tiled.alert(`Map: ${tileMap.width} × ${tileMap.height}`);
  });

  action.text = "AI: Hello";

  const inspectAction = tiled.registerAction("TiledAiInspectSelection", function () {
    try {
      const context = readSelectionContext(tiled.activeAsset);
      tiled.log(JSON.stringify(context, null, 2));
    } catch (error) {
      if (error instanceof SelectionError) {
        tiled.alert(error.message);
        return;
      }

      const details = error instanceof Error
        ? `${error.message}\n${error.stack || ""}`
        : String(error);
      tiled.log(`Tiled AI: Inspect Selection failed: ${details}`);
      tiled.alert("Could not inspect the selection. See Tiled's Console for details.");
    }
  });
  inspectAction.text = "AI: Inspect Selection";

  const fillAction = tiled.registerAction("TiledAiFillEmptyCells", function () {
    try {
      const asset = tiled.activeAsset;
      const context = readSelectionContext(asset);
      const map = /** @type {TileMap} */ (asset);
      const layer = /** @type {TileLayer} */ (map.currentLayer);
      const plan = planFillEmptyCells(context);
      const count = applyEditPlan(plan, context, map, layer);
      if (count === 0) tiled.alert("The selected area has no empty cells.");
      else tiled.log(`Filled ${count} empty cells. Use Ctrl+Z to undo.`);
    } catch (error) {
      if (error instanceof SelectionError || error instanceof EditError) {
        tiled.alert(error.message);
        return;
      }
      const details = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
      tiled.log(`Tiled AI: Fill Empty Cells failed: ${details}`);
      tiled.alert("Could not fill empty cells. See Tiled's Console for details.");
    }
  });
  fillAction.text = "AI: Fill Empty Cells (Prototype)";

  const generateAction = tiled.registerAction("TiledAiGenerate", function () {
    try { generateFromInstruction(extensionFile); }
    catch (error) {
      if (error instanceof SelectionError || error instanceof EditError) {
        tiled.alert(error.message);
        return;
      }
      const details = error instanceof Error ? `${error.message}\n${error.stack || ""}` : String(error);
      tiled.log(`Tiled AI: Generate failed: ${details}`);
      tiled.alert("Could not generate edits. See Tiled's Console for details.");
    }
  });
  generateAction.text = "AI: Generate… (Prototype)";

  tiled.extendMenu("Map", [
    { action: "TiledAiHello" },
    { action: "TiledAiInspectSelection" },
    { action: "TiledAiFillEmptyCells" },
    { action: "TiledAiGenerate" },
  ]);
}
