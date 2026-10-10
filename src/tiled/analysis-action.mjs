import { JobController } from "../core/job-controller.mjs";
import {
  requireFreeJobSlot,
  acquireJobSlot,
  releaseJobSlot,
} from "../core/job-slot.mjs";
import {
  requireAnalysisRequest,
  analysisDeadline,
} from "../core/analysis-protocol.mjs";
import {
  validateSidecar,
  checkAliases,
  retainUserFields,
} from "../core/analysis-catalog.mjs";
import { requireValid } from "../core/edit-protocol.mjs";
import {
  projectRoot,
  extractTileset,
  snapshotHash,
  sourceKey,
} from "./analysis-source.mjs";
import { startAnalysis, parseAnalysisResponse } from "./analysis-process.mjs";
import { generationDialog } from "./generation-dialog.mjs";
import { analysisReviewDialog } from "./analysis-review-dialog.mjs";
import { semanticKey } from "../core/tile-metadata.mjs";

/** @typedef {import('../core/analysis-protocol.mjs').AnalysisRequest} Request */
/** @typedef {import('../../planner/src/tileset-analysis.mjs').AnalysisReview} Review */
/** @typedef {{token:object,map:TileMap,set:Tileset,root:string,snapshot:Request['snapshot'],hash:string,ids:number[],batchSize:number,jobId:string,extensionFile:string,
 * controller:JobController<Request,unknown>|null,status:ReturnType<typeof generationDialog>|null,ui:ReturnType<typeof analysisReviewDialog>|null,
 * preflight:Dialog|null,review:Review|null,disconnect:()=>void}} Session */
/** @type {Session|null} */ let session = null;
let sequence = 0;
const newId = () => `analysis-${Date.now()}-${++sequence}`;
/** @param {string} text @param {number[]} actual */
export function parseTileSubset(text, actual) {
  const ids = new Set();
  for (const part of text.split(",")) {
    const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
    requireValid(match, "Use local IDs or ranges, such as 0-31,40,42.");
    const from = Number(match[1]),
      to = Number(match[2] || match[1]);
    requireValid(
      to >= from && to - from < 4096,
      "Invalid or excessive tile-ID range.",
    );
    for (let id = from; id <= to; id++) {
      requireValid(actual.includes(id), `Local tile ${id} does not exist.`);
      ids.add(id);
    }
  }
  requireValid(ids.size > 0 && ids.size <= 256, "Select 1..256 tiles per run.");
  return Array.from(ids).sort((a, b) => a - b);
}
/** @param {Session} current */
function assertCurrent(current) {
  requireValid(
    session === current &&
      tiled.openAssets.includes(current.map) &&
      current.map.tilesets.includes(current.set),
    "The analysis target map/tileset was closed or replaced. Restart analysis.",
  );
  requireValid(
    projectRoot(current.map) === current.root,
    "The project root changed. Restart tileset analysis before saving.",
  );
  const snapshot = extractTileset(current.set, current.root);
  requireValid(
    snapshotHash(current.root, snapshot) === current.hash,
    "Source metadata or images changed. Save/reload and restart analysis.",
  );
  return current.hash;
}
export function closeAnalysis() {
  const current = session;
  if (!current) return;
  session = null;
  current.disconnect();
  if (current.controller) {
    current.controller.cancel();
    current.controller.clear();
  }
  if (current.status) current.status.close();
  if (current.ui) current.ui.close();
  if (current.preflight) current.preflight.reject();
  releaseJobSlot(current.token);
}
/** @param {Session} current @param {Request['action']} action @param {unknown} [save] */
function startPhase(current, action, save) {
  assertCurrent(current);
  if (current.controller) current.controller.clear();
  const request = /** @type {Request} */ ({
    schemaVersion: 2,
    operation: "analyze_tileset",
    action,
    requestId: newId(),
    jobId: current.jobId,
    root: current.root,
    snapshot: current.snapshot,
    sourceHash: current.hash,
    ids: current.ids,
    batchSize: current.batchSize,
  });
  if (save !== undefined) request.save = save;
  requireAnalysisRequest(request);
  const controller = new JobController({
    startRunner: (/** @type {Request} */ r) =>
      startAnalysis(r, current.extensionFile),
    clock: () => Date.now(),
    readCurrentContext: () => assertCurrent(current),
    parseResponse: parseAnalysisResponse,
    timeoutMs: analysisDeadline(current.ids.length, current.batchSize) + 3000,
  });
  controller.start(request, current.hash);
  current.controller = controller;
  if (current.ui) current.ui.setBusy(true);
  if (current.status) current.status.close();
  current.status = generationDialog(
    () => {
      if (session === current) checkAnalysis();
    },
    () => {
      if (session === current) closeAnalysis();
    },
  );
  current.status.render(
    action === "prepare"
      ? "Preparing local thumbnails and checking cache. No images are being sent yet."
      : action === "save"
        ? "Saving reviewed annotations atomically. No map or tileset files are edited."
        : `Analyzing up to ${Math.ceil(current.ids.length / current.batchSize)} sequential batches. Use Check Status to collect; Tiled remains available.`,
  );
  current.status.show();
}
/** @param {Session} current @param {unknown} result @returns {Review} */
function validateReview(current, result) {
  const r = /** @type {Review} */ (result);
  requireValid(
    r &&
      r.sourceHash === current.hash &&
      JSON.stringify(r.snapshot) === JSON.stringify(current.snapshot),
    "Analysis artifact source mismatch.",
  );
  r.sidecar = validateSidecar(r.sidecar, current.snapshot.key);
  requireValid(
    Array.isArray(r.thumbnails) &&
      r.thumbnails.length === current.ids.length &&
      new Set(r.thumbnails.map((t) => t.tileId)).size === current.ids.length,
    "Missing/duplicate thumbnails.",
  );
  for (const t of r.thumbnails) {
    requireValid(
      current.ids.includes(t.tileId) &&
        t.path === `.tiled-ai/cache/jobs/${current.jobId}/tile-${t.tileId}.png`,
      "Thumbnail is outside the job directory.",
    );
    requireValid(
      sourceKey(current.root, FileInfo.joinPaths(current.root, t.path)) ===
        t.path,
      "Thumbnail resolved outside the job directory.",
    );
  }
  requireValid(
    Array.isArray(r.needsIds) &&
      r.needsIds.every((id) => current.ids.includes(id)) &&
      Array.isArray(r.failures),
    "Invalid batch status.",
  );
  return r;
}
/** @param {Session} current */
function showReview(current) {
  if (!current.review) return;
  if (current.ui) current.ui.close();
  current.ui = analysisReviewDialog(current.review, current.root, {
    save: (sidecar, revision) => {
      if (session !== current) return;
      assertCurrent(current);
      checkAliases(current.snapshot, sidecar);
      startPhase(current, "save", { sidecar, revision });
    },
    retry: () => {
      if (session !== current) return;
      assertCurrent(current);
      const count = current.review
        ? Math.ceil(current.review.needsIds.length / current.batchSize)
        : 0;
      if (
        tiled.confirm(
          `Analyze the remaining ${count} batches? The configured provider receives these tile images, neighboring atlas crops and metadata. Existing in-memory review choices are retained.`,
        )
      )
        startPhase(current, "run");
    },
    close: () => {
      if (session === current) closeAnalysis();
    },
  });
  current.ui.show();
}
export function checkAnalysis() {
  const current = session;
  if (!current || !current.controller) return;
  const controller = current.controller,
    state = controller.check();
  if (state === "running") {
    if (current.status)
      current.status.render(
        "Analysis is still working. Check again when ready.",
        "Check Again",
      );
    return;
  }
  if (state !== "ready") {
    if (current.ui) current.ui.setBusy(false);
    if (current.status)
      current.status.render(
        controller.error ? controller.error.message : "Analysis failed.",
        null,
        "Close analysis",
      );
    return;
  }
  try {
    assertCurrent(current);
    const action = controller.job ? controller.job.request.action : "";
    if (current.status) {
      current.status.close();
      current.status = null;
    }
    if (action === "save") {
      const result = /** @type {{saved:boolean,revision:string}} */ (
        controller.result
      );
      requireValid(
        result.saved && /^[a-f0-9]{64}$/.test(result.revision),
        "Invalid save result.",
      );
      if (current.review) current.review.revision = result.revision;
      if (current.ui) {
        current.ui.saved(result.revision);
        current.ui.setBusy(false);
      }
      tiled.log(
        "Accepted tileset annotations saved. Next generation reads the sidecar.",
      );
      return;
    }
    const review = validateReview(current, controller.result);
    requireValid(
      !current.review || current.review.revision === review.revision,
      "The sidecar changed while this review was open. Your in-memory review is retained; close and reopen analysis before saving.",
    );
    // Preserve unsaved edits/accept/reject choices across explicit failed-batch retries.
    if (current.review)
      for (const old of current.review.sidecar.entries) {
        const index = review.sidecar.entries.findIndex(
          (e) => e.tileId === old.tileId,
        );
        if (index >= 0) {
          const fresh = review.sidecar.entries[index].proposed;
          review.sidecar.entries[index] = Object.assign({}, old, {
            proposed: fresh
              ? retainUserFields(fresh, old.proposed)
              : old.proposed,
          });
        }
      }
    current.review = review;
    if (action === "run") {
      showReview(current);
      return;
    }
    const dialog = new Dialog("Analyze Tileset — image disclosure");
    current.preflight = dialog;
    const body = dialog.addTextEdit("");
    body.readOnly = true;
    body.plainText = `${current.snapshot.name}\nTotal atlas tiles: ${current.snapshot.tiles.length}\nSelected: ${current.ids.length}\nRequiring analysis: ${review.needsIds.length}\nPlanned batches: ${Math.ceil(review.needsIds.length / current.batchSize)}\nProvider: ${review.provider}; model: ${review.model}\n\nStarting analysis sends labeled tile images, bounded neighboring atlas crops and imported metadata to this provider. No gameplay rules are inferred. Fake test mode stays offline.`;
    const start = dialog.addButton("Start analysis");
    start.enabled = review.needsIds.length > 0;
    start.clicked.connect(() => {
      if (session !== current) return;
      try {
        current.preflight = null;
        dialog.accept();
        startPhase(current, "run");
      } catch (error) {
        tiled.alert(String(error));
      }
    });
    dialog.addButton("Review cached / manual entries").clicked.connect(() => {
      if (session !== current) return;
      current.preflight = null;
      dialog.accept();
      showReview(current);
    });
    dialog.rejected.connect(() => {
      if (session === current && current.preflight === dialog) closeAnalysis();
    });
    dialog.show();
  } catch (error) {
    if (current.ui) current.ui.setBusy(false);
    tiled.alert(
      error instanceof Error ? error.message : "Invalid analysis result.",
    );
  }
}
/** @param {string} extensionFile */
export function registerAnalysisAction(extensionFile) {
  const action = tiled.registerAction("TiledAiAnalyzeTileset", () => {
    try {
      requireFreeJobSlot();
      const asset = tiled.activeAsset;
      requireValid(
        asset && asset.isTileMap,
        "Open the associated saved map, then choose its tileset to analyze.",
      );
      const map = /** @type {TileMap} */ (asset);
      requireValid(map.tilesets.length > 0, "The map has no tilesets.");
      const names = map.tilesets.map((s) => semanticKey(s.name));
      requireValid(
        new Set(names).size === names.length,
        "Tileset display names are ambiguous. Rename them before analysis.",
      );
      const root = projectRoot(map);
      const chooser = new Dialog("Analyze one external tileset");
      const select = chooser.addComboBox(
        "Tileset",
        map.tilesets.map((s) => s.name),
      );
      const ids = chooser.addTextInput(
        "Local IDs (up to 256)",
        map.tilesets[0].tiles
          .slice(0, 256)
          .map((t) => t.id)
          .join(","),
      );
      select.currentIndexChanged.connect(() => {
        ids.text = map.tilesets[select.currentIndex].tiles
          .slice(0, 256)
          .map((t) => t.id)
          .join(",");
      });
      const batch = chooser.addTextInput("Tiles per batch (1–32)", "32");
      chooser.addButton("Prepare local thumbnails").clicked.connect(() => {
        try {
          requireFreeJobSlot();
          const set = map.tilesets[select.currentIndex],
            snapshot = extractTileset(set, root);
          const subset = parseTileSubset(
              ids.text,
              snapshot.tiles.map((t) => t.tileId),
            ),
            batchSize = Number(batch.text);
          requireValid(
            Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 32,
            "Batch size must be 1..32.",
          );
          const current = /** @type {Session} */ ({
            token: {},
            map,
            set,
            root,
            snapshot,
            hash: snapshotHash(root, snapshot),
            ids: subset,
            batchSize,
            jobId: newId(),
            extensionFile,
            controller: null,
            status: null,
            ui: null,
            preflight: null,
            review: null,
            disconnect: () => {},
          });
          acquireJobSlot(current.token);
          session = current;
          const invalidate = (/** @type {Asset} */ value) => {
            if (session === current && (value === map || value === set))
              closeAnalysis();
          };
          tiled.assetAboutToBeClosed.connect(invalidate);
          tiled.assetReloaded.connect(invalidate);
          current.disconnect = () => {
            tiled.assetAboutToBeClosed.disconnect(invalidate);
            tiled.assetReloaded.disconnect(invalidate);
          };
          chooser.accept();
          startPhase(current, "prepare");
        } catch (error) {
          if (session && !session.controller) closeAnalysis();
          tiled.alert(
            error instanceof Error
              ? error.message
              : "Could not start analysis.",
          );
        }
      });
      chooser.show();
    } catch (error) {
      tiled.alert(
        error instanceof Error ? error.message : "Could not analyze tileset.",
      );
    }
  });
  action.text = "AI: Analyze Tileset…";
  tiled.extendMenu("Map", [{ action: "TiledAiAnalyzeTileset" }]);
}
