import { requireObject, requireValid } from "./edit-protocol.mjs";
import {
  normalizeName,
  normalizeTags,
  normalizeDescription,
} from "./tile-metadata.mjs";
import { utf8Bytes } from "./utf8.mjs";

export const ANALYSIS_VERSION = "vision-1/preprocess-1/schema-1";
export const ROLES = /** @type {const} */ ([
  "standalone",
  "terrain_transition",
  "object_fragment",
  "animation_frame",
  "empty",
  "unknown",
]);
export const ANALYSIS_LIMITS = Object.freeze({
  tiles: 256,
  batch: 32,
  atlasTiles: 4096,
  pixels: 16777216,
  fileBytes: 16777216,
  jsonBytes: 1048576,
  imageBytes: 4194304,
  tileDimension: 256,
  timeoutMs: 30000,
});
/** @typedef {typeof ROLES[number]} Role */
/** @typedef {{tileId:number,suggestedName:string|null,description:string|null,category:string,tags:string[],placementRole:Role,uncertaintyReason:string|null}} Suggestion */
/** @typedef {{tileId:number,manual:{name?:string,description?:string,tags?:string},className:string,hasCollisionGeometry:boolean,frames:{tileId:number,duration:number}[],animationMember:boolean,wang:{name:string,ids:number[]}[]}} TileFacts */
/** @typedef {{key:string,imageKey:string,name:string,geometry:{width:number,height:number,tileWidth:number,tileHeight:number,columns:number,margin:number,spacing:number},tiles:TileFacts[]}} Snapshot */
/** @typedef {{schemaVersion:2,operation:'analyze_tileset',action:'prepare'|'run'|'save',requestId:string,jobId:string,root:string,snapshot:Snapshot,sourceHash:string,ids:number[],batchSize:number,save?:unknown}} AnalysisRequest */
/** @param {string} path */
export function relativeKey(path) {
  requireValid(
    typeof path === "string" &&
      path.length > 0 &&
      path.length <= 512 &&
      !/[\\:\x00-\x1f]/.test(path) &&
      path.split("/").every((p) => p !== "" && p !== "." && p !== ".."),
    "Expected a normalized project-relative path inside the project.",
  );
  return path;
}
/** @param {unknown} value @returns {Suggestion} */
export function suggestion(value) {
  requireObject(
    value,
    [
      "tileId",
      "suggestedName",
      "description",
      "category",
      "tags",
      "placementRole",
      "uncertaintyReason",
    ],
    "Tile suggestion",
  );
  requireValid(
    Number.isSafeInteger(value.tileId) &&
      /** @type {number} */ (value.tileId) >= 0,
    "Invalid local tile ID.",
  );
  if (value.suggestedName !== null)
    requireValid(
      normalizeName(value.suggestedName) === value.suggestedName,
      "Names must be normalized.",
    );
  if (value.description !== null)
    requireValid(
      normalizeDescription(value.description) === value.description,
      "Invalid description.",
    );
  requireValid(
    typeof value.category === "string" &&
      value.category.trim().length > 0 &&
      value.category.length <= 50,
    "Invalid category.",
  );
  requireValid(
    Array.isArray(value.tags) &&
      value.tags.every((t) => typeof t === "string" && !t.includes(",")),
    "Invalid tags.",
  );
  const tags = normalizeTags(value.tags.join(","));
  requireValid(tags.length === value.tags.length, "Duplicate tags.");
  requireValid(
    ROLES.includes(/** @type {Role} */ (value.placementRole)),
    "Invalid placement role.",
  );
  requireValid(
    value.uncertaintyReason === null ||
      (typeof value.uncertaintyReason === "string" &&
        value.uncertaintyReason.length <= 300),
    "Invalid review reason.",
  );
  return /** @type {Suggestion} */ (Object.assign({}, value, { tags }));
}
/** @param {unknown} value @param {number[]} ids */
export function suggestions(value, ids) {
  requireObject(value, ["entries"], "Analysis result");
  requireValid(
    Array.isArray(value.entries) && value.entries.length === ids.length,
    "Missing or extra analysis IDs.",
  );
  const seen = new Set();
  return value.entries.map((entry) => {
    const s = suggestion(entry);
    requireValid(
      ids.includes(s.tileId) && !seen.has(s.tileId),
      "Unknown or duplicate analysis ID.",
    );
    seen.add(s.tileId);
    return s;
  });
}
/** @param {unknown} value @returns {asserts value is AnalysisRequest} */
export function requireAnalysisRequest(value) {
  requireObject(
    value,
    [
      "schemaVersion",
      "operation",
      "action",
      "requestId",
      "jobId",
      "root",
      "snapshot",
      "sourceHash",
      "ids",
      "batchSize",
    ].concat(
      value && typeof value === "object" && "save" in value ? ["save"] : [],
    ),
    "Analysis request",
  );
  requireValid(
    value.schemaVersion === 2 &&
      value.operation === "analyze_tileset" &&
      ["prepare", "run", "save"].includes(/** @type {string} */ (value.action)),
    "Unsupported analysis operation.",
  );
  for (const id of [value.requestId, value.jobId])
    requireValid(
      typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id),
      "Invalid analysis job ID.",
    );
  requireValid(
    typeof value.root === "string" && value.root.length <= 1024,
    "Invalid project root.",
  );
  requireValid(
    typeof value.sourceHash === "string" &&
      /^[a-f0-9]{64}$/.test(value.sourceHash),
    "Invalid source fingerprint.",
  );
  requireValid(
    Number.isInteger(value.batchSize) &&
      /** @type {number} */ (value.batchSize) > 0 &&
      /** @type {number} */ (value.batchSize) <= ANALYSIS_LIMITS.batch,
    "Batch size must be 1..32.",
  );
  const s = /** @type {Snapshot} */ (value.snapshot);
  requireValid(s && typeof s === "object", "Missing tileset snapshot.");
  relativeKey(s.key);
  relativeKey(s.imageKey);
  requireValid(
    typeof s.name === "string" && s.name.trim() && !s.name.includes(":"),
    "Invalid tileset display name.",
  );
  requireValid(
    Array.isArray(s.tiles) &&
      s.tiles.length > 0 &&
      s.tiles.length <= ANALYSIS_LIMITS.atlasTiles,
    "Atlas exceeds 4096 tiles.",
  );
  const ids = s.tiles.map((t) => t.tileId);
  requireValid(
    new Set(ids).size === ids.length &&
      ids.every((id) => Number.isSafeInteger(id) && id >= 0),
    "Invalid atlas IDs.",
  );
  requireValid(
    Array.isArray(value.ids) &&
      value.ids.length > 0 &&
      value.ids.length <= ANALYSIS_LIMITS.tiles &&
      new Set(value.ids).size === value.ids.length &&
      value.ids.every((id) => ids.includes(id)),
    "Select 1..256 actual local tile IDs.",
  );
  for (const id of ids) cropRect(s.geometry, id);
  requireValid(
    utf8Bytes(JSON.stringify(value)) <= ANALYSIS_LIMITS.jsonBytes,
    "Analysis request exceeds 1 MiB.",
  );
}
/** @param {Snapshot['geometry']} g @param {number} id */
export function cropRect(g, id) {
  requireValid(
    g && Object.values(g).every(Number.isSafeInteger),
    "Atlas geometry must contain integers.",
  );
  requireValid(
    g.width > 0 &&
      g.height > 0 &&
      g.width * g.height <= ANALYSIS_LIMITS.pixels &&
      g.columns > 0 &&
      g.margin >= 0 &&
      g.spacing >= 0 &&
      g.tileWidth > 0 &&
      g.tileHeight > 0 &&
      g.tileWidth <= 256 &&
      g.tileHeight <= 256,
    "Unsupported atlas dimensions (16 MP, tiles up to 256 pixels).",
  );
  const left = g.margin + (id % g.columns) * (g.tileWidth + g.spacing);
  const top =
    g.margin + Math.floor(id / g.columns) * (g.tileHeight + g.spacing);
  requireValid(
    Number.isSafeInteger(id) &&
      id >= 0 &&
      left + g.tileWidth <= g.width &&
      top + g.tileHeight <= g.height,
    "Tile crop lies outside the atlas.",
  );
  requireValid(
    g.columns ===
      Math.floor((g.width - g.margin + g.spacing) / (g.tileWidth + g.spacing)),
    "Atlas columns do not match image geometry.",
  );
  return { left, top, width: g.tileWidth, height: g.tileHeight };
}
/** @param {number} count @param {number} batchSize */
export function analysisDeadline(count, batchSize) {
  return (
    20000 + Math.ceil(count / batchSize) * (ANALYSIS_LIMITS.timeoutMs + 2000)
  );
}
