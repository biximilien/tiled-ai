import {
  ANALYSIS_LIMITS,
  cropRect,
  relativeKey,
} from "../core/analysis-protocol.mjs";
import { contentHash } from "../core/content-hash.mjs";
import { EditError, requireValid } from "../core/edit-protocol.mjs";
import {
  validateSidecar,
  eligibleAnnotation,
  mergeManual,
} from "../core/analysis-catalog.mjs";

/** @param {string} path @param {number} [limit] */
export function fileHash(path, limit = ANALYSIS_LIMITS.fileBytes) {
  const file = new BinaryFile(path, BinaryFile.ReadOnly);
  try {
    requireValid(file.size <= limit, "Analysis source/file is too large.");
    return contentHash(new Uint8Array(file.readAll()));
  } finally {
    file.close();
  }
}
/** @param {string} root @param {string} path */
export function sourceKey(root, path) {
  return relativeKey(
    FileInfo.relativePath(root, FileInfo.canonicalPath(path)).replace(
      /\\/g,
      "/",
    ),
  );
}
/** @param {TileMap} map */
export function projectRoot(map) {
  const anchor = tiled.projectFilePath || map.fileName;
  requireValid(
    Boolean(anchor),
    "Save the map or open a saved Tiled project before analyzing tilesets.",
  );
  return FileInfo.canonicalPath(FileInfo.path(anchor));
}
/** @param {Tileset} set @param {string} root @param {string} [sourceFile] Explicit filename for document-free native probes. @returns {import('../core/analysis-protocol.mjs').Snapshot} */
export function extractTileset(set, root, sourceFile = set.fileName) {
  requireValid(
    Boolean(sourceFile) && File.exists(sourceFile),
    "Analyze Tileset requires a saved external tileset. Export embedded tilesets first.",
  );
  requireValid(
    !set.modified,
    "Save tileset changes, then restart analysis. Unsaved metadata cannot be combined with disk images.",
  );
  requireValid(
    !set.isCollection && Boolean(set.imageFileName),
    "Image-collection tilesets are not supported by atlas analysis.",
  );
  requireValid(
    /\.(png|webp|jpg|jpeg|tif|tiff)$/i.test(set.imageFileName),
    "Analyze Tileset currently supports PNG, WebP, JPEG and TIFF atlas files.",
  );
  requireValid(
    set.tiles.length <= ANALYSIS_LIMITS.atlasTiles,
    "Analyze Tileset supports at most 4096 atlas tiles; select up to 256 per run.",
  );
  // Qt maps an invalid QColor to black; Node reads an explicit saved image trans
  // attribute to distinguish absent color-key transparency from black transparency.
  const geometry = {
    width: set.imageWidth,
    height: set.imageHeight,
    tileWidth: set.tileWidth,
    tileHeight: set.tileHeight,
    columns: set.columnCount,
    margin: set.margin,
    spacing: set.tileSpacing,
  };
  const members = new Set();
  for (const t of set.tiles)
    for (const frame of t.frames) members.add(frame.tileId);
  const tiles = set.tiles
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((tile) => {
      cropRect(geometry, tile.id);
      /** @type {import('../core/analysis-protocol.mjs').TileFacts['manual']} */ const manual =
        {};
      for (const pair of [
        ["name", "ai_name"],
        ["description", "ai_description"],
        ["tags", "ai_tags"],
      ]) {
        const value = tile.property(pair[1]);
        if (value !== undefined) {
          requireValid(
            typeof value === "string",
            `${pair[1]} must be a string.`,
          );
          manual[/** @type {keyof typeof manual} */ (pair[0])] = value;
        }
      }
      return {
        tileId: tile.id,
        manual,
        className: tile.className,
        hasCollisionGeometry: Boolean(
          tile.objectGroup && tile.objectGroup.objects.length,
        ),
        frames: tile.frames.map((f) => ({
          tileId: f.tileId,
          duration: f.duration,
        })),
        animationMember: members.has(tile.id),
        wang: set.wangSets
          .map((w) => ({ name: w.name, ids: w.wangId(tile) }))
          .filter((w) => w.ids.some(Boolean)),
      };
    });
  return {
    key: sourceKey(root, sourceFile),
    imageKey: sourceKey(root, set.imageFileName),
    name: set.name,
    geometry,
    tiles,
  };
}
/** @param {string} root @param {import('../core/analysis-protocol.mjs').Snapshot} snapshot */
export function snapshotHash(root, snapshot) {
  return contentHash(
    JSON.stringify(snapshot) +
      "\n" +
      fileHash(FileInfo.joinPaths(root, snapshot.key)) +
      "\n" +
      fileHash(FileInfo.joinPaths(root, snapshot.imageKey)),
  );
}
/** @param {string} path */
export function readAnalysisJson(path) {
  const size = new BinaryFile(path, BinaryFile.ReadOnly);
  try {
    requireValid(
      size.size <= ANALYSIS_LIMITS.jsonBytes,
      "Analysis JSON exceeds 1 MiB.",
    );
  } finally {
    size.close();
  }
  const file = new TextFile(path, TextFile.ReadOnly);
  try {
    return JSON.parse(file.readAll());
  } finally {
    file.close();
  }
}
/** Read only accepted eligible entries. No sidecar means unchanged manual behavior.
 * @param {TileMap} map @param {Tileset} set */
export function sidecarAnnotations(map, set) {
  /** @type {Map<number,import('../core/analysis-protocol.mjs').Suggestion>} */ const values =
    new Map();
  if (!set.fileName || (!map.fileName && !tiled.projectFilePath)) return values;
  const root = projectRoot(map);
  let key;
  try {
    key = sourceKey(root, set.fileName);
  } catch (error) {
    return values;
  } // Outside-project manual tilesets retain their previous behavior.
  const path = FileInfo.joinPaths(
    root,
    `.tiled-ai/catalogs/${contentHash(key)}.json`,
  );
  if (!File.exists(path)) return values;
  const sidecar = validateSidecar(readAnalysisJson(path), key);
  let snapshot, hash;
  try {
    snapshot = extractTileset(set, root);
    hash = snapshotHash(root, snapshot);
  } catch (error) {
    tiled.log(
      `Sidecar annotations excluded: ${error instanceof Error ? error.message : "source unavailable"}`,
    );
    return values;
  }
  const ids = new Set(snapshot.tiles.map((t) => t.tileId));
  for (const entry of sidecar.entries) {
    if (!ids.has(entry.tileId)) continue;
    const tile = snapshot.tiles.find((t) => t.tileId === entry.tileId);
    const accepted =
      tile &&
      tile.manual.name !== undefined &&
      entry.state !== "rejected" &&
      entry.accepted &&
      entry.accepted.sourceHash === hash
        ? entry.accepted.values
        : eligibleAnnotation(entry, hash);
    if (accepted) values.set(entry.tileId, accepted);
  }
  if (sidecar.entries.some((e) => e.accepted && e.accepted.sourceHash !== hash))
    tiled.log(
      `Stale sidecar annotations excluded for ${set.name}. Analyze and review current source images.`,
    );
  return values;
}

export { mergeManual };
