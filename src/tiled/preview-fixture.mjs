// Development only: exercise the same job/review path with the offline planner.
import { startGeneration, requireIdleGeneration } from "./job-lifecycle.mjs";
import { readRegionContext } from "./map-reader.mjs";
import { buildTileCatalog, reportCatalog } from "./tile-catalog-reader.mjs";

/** @param {string} extensionFile */
export function registerPreviewFixture(extensionFile) {
  if (new Process().getEnv("TILED_AI_TEST_MODE") !== "1") return;
  const action = tiled.registerAction("TiledAiPreviewFixture", () => {
    try {
      requireIdleGeneration();
      const map = /** @type {TileMap} */ (tiled.activeAsset);
      if (!map || !map.isTileMap || FileInfo.fileName(map.fileName) !== "preview-fixture.tmx" || !map.currentLayer || !map.currentLayer.isTileLayer) {
        throw new Error("Open tests/fixtures/preview-fixture.tmx and select its Preview target tile layer first.");
      }
      const layer = /** @type {TileLayer} */ (map.currentLayer);
      const context = readRegionContext(map, layer, { x: 12, y: 8, width: 3, height: 3 });
      if (context.cells.some(row => row.some(cell => cell !== null))) throw new Error("Undo previous fixture application first: the 3 by 3 region must be empty.");
      startGeneration({ schemaVersion: 1, requestId: `${Date.now()}-preview-fixture`, instruction: "fill empty with preview-fixture:grass",
        context, tileCatalog: reportCatalog(buildTileCatalog(map)) }, map, layer, extensionFile);
    } catch (error) { tiled.alert(error instanceof Error ? error.message : "Could not start the preview fixture."); }
  });
  action.text = "AI: Preview 3x3 Fixture (Development)";
  tiled.extendMenu("Map", [{ action: "TiledAiPreviewFixture" }]);
}
