import {
  existsSync,
  readFileSync,
  statSync,
  realpathSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { contentHash } from "../../src/core/content-hash.mjs";
import {
  ANALYSIS_LIMITS,
  relativeKey,
} from "../../src/core/analysis-protocol.mjs";
import {
  emptySidecar,
  validateSidecar,
} from "../../src/core/analysis-catalog.mjs";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

/** Resolve every existing ancestor, including Windows junctions, before I/O.
 * @param {string} root @param {string} key */
export function projectPath(root, key) {
  relativeKey(key);
  const base = realpathSync(root);
  const path = resolve(base, key);
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("Invalid project path.");
    ancestor = parent;
  }
  const rel = relative(base, realpathSync(ancestor));
  if (
    rel === ".." ||
    rel.startsWith("..\\") ||
    rel.startsWith("../") ||
    isAbsolute(rel)
  )
    throw new Error("Artifact/source path leaves the project.");
  return path;
}
/** @param {string} path @param {number} [limit] */
export function boundedRead(path, limit = ANALYSIS_LIMITS.jsonBytes) {
  if (statSync(path).size > limit)
    throw new Error("Analysis file exceeds its size limit.");
  const data = readFileSync(path);
  if (data.length > limit)
    throw new Error("Analysis file grew beyond its size limit.");
  return data;
}
/** @param {string} root @param {import('../../src/core/analysis-protocol.mjs').Snapshot} snapshot */
export function sourceHash(root, snapshot) {
  return contentHash(
    JSON.stringify(snapshot) +
      "\n" +
      contentHash(
        boundedRead(projectPath(root, snapshot.key), ANALYSIS_LIMITS.fileBytes),
      ) +
      "\n" +
      contentHash(
        boundedRead(
          projectPath(root, snapshot.imageKey),
          ANALYSIS_LIMITS.fileBytes,
        ),
      ),
  );
}
/** @param {string} key */ export function sidecarKey(key) {
  return `.tiled-ai/catalogs/${contentHash(key)}.json`;
}
/** @param {string} root @param {string} key */
export function loadSidecar(root, key) {
  const path = projectPath(root, sidecarKey(key));
  if (!existsSync(path)) return { sidecar: emptySidecar(key), revision: null };
  const bytes = boundedRead(path);
  try {
    return { sidecar: validateSidecar(JSON.parse(bytes.toString("utf8")), key), revision: contentHash(bytes) };
  } catch (error) { throw new PlannerError("INVALID_SIDECAR", "The saved tileset sidecar is malformed, mismatched or uses an unsupported version. It was not overwritten."); }
}
/** Same-directory fsync + rename; never truncate the destination. Lock coordinates app writers.
 * @param {string} root @param {string} key @param {unknown} value @param {string|null|undefined} expected
 * @param {()=>void} [beforeReplace] */
export function atomicJson(
  root,
  key,
  value,
  expected,
  beforeReplace = () => {},
) {
  const path = projectPath(root, key);
  mkdirSync(dirname(path), { recursive: true });
  projectPath(root, key);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text) > ANALYSIS_LIMITS.jsonBytes)
    throw new Error("Sidecar/artifact exceeds 1 MiB.");
  const lock = `${path}.lock`,
    temp = `${path}.${process.pid}.tmp`;
  let fd;
  let tempWritten = false;
  try {
    fd = openSync(lock, "wx");
    const compare = () => {
      if (
        expected !== undefined &&
        (existsSync(path) ? contentHash(boundedRead(path)) : null) !== expected
      )
        throw new PlannerError(
          "SAVE_CONFLICT",
          "Save conflict: sidecar changed on disk. Close and reopen analysis; your review remains in memory.",
        );
    };
    compare();
    const out = openSync(temp, "wx");
    tempWritten = true;
    try {
      writeFileSync(out, text, "utf8");
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    beforeReplace();
    compare();
    projectPath(root, key);
    renameSync(temp, path);
    tempWritten = false;
    return contentHash(text);
  } finally {
    if (tempWritten && existsSync(temp)) unlinkSync(temp);
    if (fd !== undefined) {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}
