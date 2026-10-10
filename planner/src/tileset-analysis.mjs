import { existsSync } from "node:fs";
import {
  ANALYSIS_VERSION,
  requireAnalysisRequest,
  suggestions,
  ANALYSIS_LIMITS,
} from "../../src/core/analysis-protocol.mjs";
import {
  checkAliases,
  FIELDS,
  uniqueCandidates,
  validateSidecar,
  retainUserFields,
} from "../../src/core/analysis-catalog.mjs";
import { contentHash } from "../../src/core/content-hash.mjs";
import { providerConfig } from "./provider-config.mjs";
import { visionAdapter } from "./vision-adapter.mjs";
import { atlasCrops, contactSheet, contextCrop } from "./atlas-images.mjs";
import {
  projectPath,
  boundedRead,
  sourceHash,
  loadSidecar,
  sidecarKey,
  atomicJson,
} from "./analysis-storage.mjs";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

/** @typedef {import('../../src/core/analysis-protocol.mjs').AnalysisRequest} Request */
/** @typedef {{snapshot:Request['snapshot'],sourceHash:string,revision:string|null,sidecar:import('../../src/core/analysis-catalog.mjs').Sidecar,
 * thumbnails:{tileId:number,path:string,pixelHash:string,empty:boolean}[],needsIds:number[],failures:{ids:number[],code:string}[],provider:string,model:string,batchSize:number,cachedCount:number}} AnalysisReview */
/** Deterministic fixture labels exercise behavior, not real image classification.
 * @param {import('./vision-adapter.mjs').VisionInput} batch */
export async function fakeVision(batch) {
  return {
    entries: batch.ids.map((id) => {
      const facts = batch.facts.find((f) => f.tileId === id);
      const role =
        facts && facts.animationMember
          ? "animation_frame"
          : facts && facts.className.endsWith("-part")
            ? "object_fragment"
            : id % 6 === 2
              ? "terrain_transition"
              : id % 6 === 3
                ? "object_fragment"
                : "standalone";
      return {
        tileId: id,
        suggestedName: id % 2 ? "water" : "grass",
        description: "Offline fixture suggestion; review the actual image.",
        category: role === "standalone" ? "terrain interiors" : role,
        tags: [id % 2 ? "water" : "grass"],
        placementRole: role,
        uncertaintyReason:
          role === "standalone"
            ? null
            : "Review fragment/transition/animation context.",
      };
    }),
  };
}
/** @param {Request} request @param {Record<string,string|undefined>} env
 * @param {(batch:import('./vision-adapter.mjs').VisionInput)=>Promise<unknown>} [injected] @returns {Promise<AnalysisReview|{saved:true,revision:string}>} */
export async function analyzeTileset(request, env, injected) {
  requireAnalysisRequest(request);
  const assertSource = () => {
    if (sourceHash(request.root, request.snapshot) !== request.sourceHash)
      throw new PlannerError(
        "SOURCE_CHANGED",
        "Tileset source changed. Save/reload and restart analysis.",
      );
  };
  assertSource();
  const loaded = loadSidecar(request.root, request.snapshot.key);
  if (request.action === "save") {
    const save = /** @type {{sidecar:unknown,revision:string|null}} */ (
      request.save
    );
    if (!save || !(save.revision === null || typeof save.revision === "string"))
      throw new Error("Missing save revision.");
    const sidecar = validateSidecar(save.sidecar, request.snapshot.key);
    checkAliases(request.snapshot, sidecar);
    const revision = atomicJson(
      request.root,
      sidecarKey(request.snapshot.key),
      sidecar,
      save.revision,
      assertSource,
    );
    return { saved: true, revision };
  }
  const config =
    env.TILED_AI_TEST_MODE === "1" || injected
      ? { provider: "fake", model: "fixture-v1" }
      : providerConfig(env);
  if (config.provider === "deterministic")
    throw new PlannerError(
      "CONFIGURATION",
      "Tileset vision requires TILED_AI_PROVIDER=openai and an image-capable OPENAI_MODEL, or explicit TILED_AI_TEST_MODE=1 for offline fixtures.",
    );
  const model = "model" in config ? /** @type {string} */ (config.model) : "";
  const configHash = contentHash(
    JSON.stringify({
      version: ANALYSIS_VERSION,
      provider: config.provider,
      model,
      batchSize: request.batchSize,
    }),
  );
  const cacheKey = `.tiled-ai/cache/proposals/${contentHash(request.snapshot.key + request.sourceHash + configHash)}.json`;
  let cache =
    /** @type {import('../../src/core/analysis-catalog.mjs').Sidecar} */ ({
      schemaVersion: 1,
      tilesetKey: request.snapshot.key,
      analysisVersion: ANALYSIS_VERSION,
      entries: [],
    });
  if (existsSync(projectPath(request.root, cacheKey))) {
    try {
      cache = validateSidecar(
        JSON.parse(
          boundedRead(projectPath(request.root, cacheKey)).toString("utf8"),
        ),
        request.snapshot.key,
      );
    } catch {
      /* Disposable corrupt cache is recomputed, never used as accepted data. */
    }
  }
  const sidecar = loaded.sidecar;
  for (const entry of cache.entries)
    if (entry.proposed && entry.proposed.sourceHash === request.sourceHash) {
      const existing = sidecar.entries.find((e) => e.tileId === entry.tileId);
      if (existing)
        existing.proposed = retainUserFields(entry.proposed, existing.proposed);
      else
        sidecar.entries.push({
          tileId: entry.tileId,
          state: "suggested",
          accepted: null,
          proposed: entry.proposed,
        });
    }
  const { crops, image } = await atlasCrops(
    request.root,
    request.snapshot,
    request.ids,
    request.jobId,
  );
  /** @type {AnalysisReview} */
  const review = {
    snapshot: request.snapshot,
    sourceHash: request.sourceHash,
    revision: loaded.revision,
    sidecar,
    thumbnails: crops.map((c) => ({
      tileId: c.tileId,
      path: c.thumbnail,
      pixelHash: c.pixelHash,
      empty: c.empty,
    })),
    needsIds: [],
    failures: [],
    provider: config.provider,
    model,
    batchSize: request.batchSize,
    cachedCount: 0,
  };
  /** @param {import('../../src/core/analysis-protocol.mjs').Suggestion} values @param {string} evidenceHash @param {boolean} [empty] */
  const store = (values, evidenceHash, empty = false) => {
    // Animation membership is authoritative: a frame cannot default to standalone.
    const facts = request.snapshot.tiles.find(
      (t) => t.tileId === values.tileId,
    );
    if (!facts) throw new Error("Suggestion has no source facts.");
    if (facts && facts.animationMember && values.placementRole === "standalone")
      values = Object.assign({}, values, {
        placementRole: "animation_frame",
        uncertaintyReason: "Imported animation membership requires review.",
      });
    const annotation = {
      values,
      facts,
      sourceHash: request.sourceHash,
      evidenceHash,
      provenance: {
        provider: empty ? "deterministic" : config.provider,
        model: empty ? "alpha-test" : model,
        version: ANALYSIS_VERSION,
        sourceHash: request.sourceHash,
        configurationHash: configHash,
        fields: Object.fromEntries(
          FIELDS.map((f) => [f, empty ? "deterministic" : "model"]),
        ),
      },
    };
    let entry = sidecar.entries.find((e) => e.tileId === values.tileId);
    if (!entry) {
      entry = {
        tileId: values.tileId,
        state: "suggested",
        accepted: null,
        proposed: null,
      };
      sidecar.entries.push(entry);
    }
    entry.proposed = retainUserFields(annotation, entry.proposed);
    const index = cache.entries.findIndex((e) => e.tileId === values.tileId);
    const cached = {
      tileId: values.tileId,
      state: /** @type {const} */ ("suggested"),
      accepted: null,
      proposed: annotation,
    };
    if (index < 0) cache.entries.push(cached);
    else cache.entries[index] = cached;
  };
  for (const crop of crops) {
    const fact = request.snapshot.tiles.find((t) => t.tileId === crop.tileId);
    const entry = sidecar.entries.find((e) => e.tileId === crop.tileId);
    if (crop.empty) {
      store(
        {
          tileId: crop.tileId,
          suggestedName: null,
          description: "Fully transparent atlas cell.",
          category: "empty",
          tags: [],
          placementRole: "empty",
          uncertaintyReason: null,
        },
        contentHash(crop.pixelHash + configHash + request.sourceHash),
        true,
      );
      continue;
    }
    if (
      (fact && fact.manual.name !== undefined) ||
      (entry &&
        ((entry.accepted && entry.accepted.sourceHash === request.sourceHash) ||
          (entry.proposed &&
            entry.proposed.sourceHash === request.sourceHash &&
            entry.proposed.provenance.configurationHash === configHash)))
    ) {
      review.cachedCount++;
      continue;
    }
    review.needsIds.push(crop.tileId);
  }
  if (request.action === "run") {
    const adapter =
      injected ||
      (config.provider === "fake"
        ? fakeVision
        : visionAdapter(/** @type {{apiKey:string,model:string}} */ (config)));
    const pending = review.needsIds.slice();
    review.needsIds = [];
    for (let start = 0; start < pending.length; start += request.batchSize) {
      const ids = pending.slice(start, start + request.batchSize);
      try {
        const selected = crops.filter((c) => ids.includes(c.tileId));
        const sheet = await contactSheet(selected);
        const contexts = [];
        for (const tile of selected)
          contexts.push(
            Object.assign(
              { tileId: tile.tileId },
              await contextCrop(image, tile, request.snapshot.geometry),
            ),
          );
        const facts = request.snapshot.tiles.filter((t) =>
          ids.includes(t.tileId),
        );
        const evidenceHash = contentHash(
          request.sourceHash +
            configHash +
            contentHash(sheet) +
            JSON.stringify(facts) +
            contexts
              .map((c) => JSON.stringify(c.origin) + contentHash(c.png))
              .join(""),
        );
        const parsed = suggestions(
          await adapter({ ids, facts, sheet, contexts }),
          ids,
        );
        for (const value of uniqueCandidates(request.snapshot, sidecar, parsed))
          store(value, evidenceHash);
        assertSource();
        atomicJson(request.root, cacheKey, cache, undefined);
      } catch (error) {
        review.failures.push({
          ids,
          code: error instanceof PlannerError ? error.code : "INVALID_BATCH",
        });
        review.needsIds.push(...ids);
      }
    }
  }
  assertSource();
  validateSidecar(sidecar, request.snapshot.key);
  // Empty-cell proposals and successful batches are disposable cache, never accepted automatically.
  atomicJson(request.root, cacheKey, cache, undefined);
  return review;
}
