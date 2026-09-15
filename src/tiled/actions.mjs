import { isTileMapAsset } from "../core/validation.mjs";

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
  tiled.extendMenu("Map", [{ action: "TiledAiHello" }]);
}
