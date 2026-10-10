// Run with Tiled --evaluate, passing an output JSON path. Never edits a live map.
import { registerPreviewFixture } from "../src/tiled/preview-fixture.mjs";
import { buildPreview } from "../src/tiled/preview-builder.mjs";
import { ReviewController } from "../src/core/review-controller.mjs";
import { registerPreviewTool } from "../src/tiled/preview-tool.mjs";
import { readRegionContext } from "../src/tiled/map-reader.mjs";
import { validateAndResolveEditPlan } from "../src/tiled/edit-applier.mjs";
import { reviewDialog } from "../src/tiled/review-dialog.mjs";
/** @type {Record<string,unknown>} */
const report = { version: tiled.version, qt: tiled.qtVersion };
report.fixtureModuleLoaded = typeof registerPreviewFixture === "function";
try {
  const map = new TileMap(); map.setSize(24, 18); map.setTileSize(32, 32);
  const source = new TileLayer(); map.addLayer(source);
  const set = new Tileset("preview-fixture"); set.tileWidth = 32; set.tileHeight = 32;
  const tile = set.addTile(); map.addTileset(set);
  const placements = [];
  for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) placements.push({ x: 12 + dx, y: 8 + dy, tile });
  const detached = buildPreview(map, placements);
  const tool = tiled.registerTool("TiledAiNativePreviewProbe", { name: "AI Preview Probe" });
  tool.preview = detached;
  const copy = tool.preview;
  const copiedLayer = /** @type {TileLayer} */ (copy.layers[0]);
  report.coordinates = placements.map(p => ({ x: p.x, y: p.y, id: /** @type {Tile} */ (copiedLayer.tileAt(p.x, p.y)).id }));
  report.unspecifiedAbsent = copiedLayer.tileAt(11, 8) === null;
  report.liveUntouched = placements.every(p => source.tileAt(p.x, p.y) === null);
  const edit = /** @type {TileLayer} */ (detached.layers[0]).edit(); edit.setTile(12, 8, null); edit.apply();
  report.assignmentCopied = /** @type {TileLayer} */ (tool.preview.layers[0]).tileAt(12, 8) !== null;
  tool.preview = new TileMap();
  report.cleared = tool.preview.layerCount === 0;
  report.resourceIdentity = set.tile(0) === tile && copiedLayer.tileAt(12, 8) === tile;
  registerPreviewTool();
  const format = tiled.mapFormat("tmx");
  if (!format) throw new Error("TMX format is unavailable.");
  const fixture = format.read(FileInfo.joinPaths(FileInfo.path(__filename), "../tests/fixtures/preview-fixture.tmx"));
  const target = /** @type {TileLayer} */ (fixture.layers[0]);
  const context = readRegionContext(fixture, target, { x: 12, y: 8, width: 3, height: 3 });
  const edits = placements.map(p => ({ operation: "setTile", x: p.x, y: p.y, tile: { tileset: "preview-fixture", tileId: 0 } }));
  const plan = { schemaVersion: 1, target: { layerId: target.id, selection: context.selection }, edits };
  const review = new ReviewController("native-fixture", plan, context, {
    validate: canonical => validateAndResolveEditPlan(canonical, context, fixture, target, () => {}),
    canShow: () => true, render: resolved => { tool.preview = buildPreview(fixture, resolved); },
    hide: () => { tool.preview = new TileMap(); }, apply: () => { throw new Error("Probe must not apply."); },
  });
  review.refresh();
  report.reviewReady = review.state === "reviewing" && review.previewVisible && review.placements.length === 9;
  report.reviewMessage = review.message;
  report.fixtureTileImage = fixture.tilesets[0].image;
  review.discard(review.id);
  report.fixtureUntouched = edits.every(p => target.tileAt(p.x, p.y) === null);
  let discarded = false;
  const ui = reviewDialog(() => {}, () => { discarded = true; }, () => {}, () => {});
  ui.render("<b>Plain text preview probe</b>", false);
  ui.close(); ui.close();
  report.dialogCleanup = !discarded;
} catch (error) { report.error = String(error); }
const output = new TextFile(tiled.scriptArguments[0], TextFile.WriteOnly);
output.write(JSON.stringify(report)); output.commit();
