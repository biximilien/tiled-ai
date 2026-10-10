import { extractTileset, snapshotHash } from "../src/tiled/analysis-source.mjs";
import { readAnalysisJson } from "../src/tiled/analysis-source.mjs";
import { analysisReviewDialog } from "../src/tiled/analysis-review-dialog.mjs";
import {
  startAnalysis,
  parseAnalysisResponse,
} from "../src/tiled/analysis-process.mjs";
import { parseTileSubset } from "../src/tiled/analysis-action.mjs";
/** Native control/metadata probe; does not establish interactive visual usability. */
const report = /** @type {Record<string,unknown>} */ ({
  version: tiled.version,
});
try {
  const root = FileInfo.joinPaths(
    FileInfo.path(__filename),
    "../tests/fixtures/analysis",
  );
  const format = tiled.mapFormat("tmx");
  if (!format) throw new Error("TMX unavailable");
  const map = format.read(FileInfo.joinPaths(root, "map.tmx"));
  const set = map.tilesets[0];
  report.fileName = set.fileName;
  report.transparent = String(set.transparentColor);
  report.color = set.transparentColor;
  const snapshot = extractTileset(
    set,
    FileInfo.canonicalPath(root),
    FileInfo.joinPaths(root, "atlas.tsx"),
  );
  report.snapshot = snapshot;
  report.sourceHash = snapshotHash(root, snapshot);
  report.subset = parseTileSubset(
    "0-2",
    snapshot.tiles.map((t) => t.tileId),
  );
  const dialog = new Dialog("Thumbnail prototype");
  const image = set.tiles[0].image.copy(set.tiles[0].imageRect);
  const widget = dialog.addImage("Tile 0", image);
  report.imageWidth = widget.image.width;
  report.imageHeight = widget.image.height;
  const select = dialog.addComboBox("Page tiles", ["0 - grass", "1 - water"]);
  select.currentIndex = 1;
  report.selected = select.currentIndex;
  const edit = dialog.addTextInput("Name", "grass");
  edit.text = "grass_corrected";
  report.edited = edit.text;
  dialog.clear();
  dialog.addImage("Tile 1", set.tiles[1].image.copy(set.tiles[1].imageRect));
  report.secondPage = true;
  dialog.reject();
  let review = null;
  if (tiled.scriptArguments[1] === "process") {
    if (new Process().getEnv("TILED_AI_TEST_MODE") !== "1")
      throw new Error(
        "Native process probe requires explicit offline test mode.",
      );
    const request =
      /** @type {import('../src/core/analysis-protocol.mjs').AnalysisRequest} */ ({
        schemaVersion: 2,
        operation: "analyze_tileset",
        action: "run",
        requestId: `probe-${Date.now()}`,
        jobId: `probe-${Date.now()}`,
        root: FileInfo.canonicalPath(root),
        snapshot,
        sourceHash: /** @type {string} */ (report.sourceHash),
        ids: snapshot.tiles.map((t) => t.tileId),
        batchSize: 3,
      });
    const runner = startAnalysis(
      request,
      FileInfo.joinPaths(FileInfo.path(__filename), "../src/main.mjs"),
    );
    // Headless test process only; production status checks never poll in a loop.
    const until = Date.now() + 10000;
    while (!runner.finished() && Date.now() < until) {}
    if (!runner.finished()) {
      runner.dispose(true);
      throw new Error("Native process probe timed out.");
    }
    review = parseAnalysisResponse(runner.collect(), request);
    runner.dispose();
    report.nativeProcess = true;
  } else if (tiled.scriptArguments.length > 1)
    review = readAnalysisJson(tiled.scriptArguments[1]);
  if (review) {
    const ui = analysisReviewDialog(review, FileInfo.canonicalPath(root), {
      save: () => {},
      retry: () => {},
      close: () => {},
    });
    ui.show();
    ui.close();
    report.fullReviewCreated = true;
  }
} catch (error) {
  report.error = String(error);
}
const output = new TextFile(tiled.scriptArguments[0], TextFile.WriteOnly);
output.write(JSON.stringify(report));
output.commit();
