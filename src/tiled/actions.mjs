import { isTileMapAsset } from "../core/validation.mjs";
import { readSelectionContext, SelectionError } from "./map-reader.mjs";

export function registerActions() {
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

  tiled.extendMenu("Map", [
    { action: "TiledAiHello" },
    { action: "TiledAiInspectSelection" },
  ]);
}
