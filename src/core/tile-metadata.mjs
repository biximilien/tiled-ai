import { EditError } from "./edit-protocol.mjs";

export const CATALOG_LIMITS = Object.freeze({
  nameCharacters: 80, descriptionCharacters: 500, tagsPerTile: 20,
  tagCharacters: 50, annotatedTiles: 500, serializedBytes: 512 * 1024,
  suggestions: 10,
});

/** @param {string} value */
export function semanticKey(value) { return value.trim().toLowerCase(); }
/** Locale-independent UTF-16 ordering. @param {string} a @param {string} b */
export function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

export class MetadataError extends EditError {
  /** @param {string} property @param {string} code @param {string} message */
  constructor(property, code, message) { super(message); this.property = property; this.code = code; }
}

/** Lengths count trimmed JavaScript UTF-16 code units; no silent truncation.
 * @param {unknown} value @param {string} property @param {number} limit
 */
function textValue(value, property, limit) {
  if (typeof value !== "string") throw new MetadataError(property, "invalid_property_type", `${property} must be a string.`);
  const text = value.trim();
  if (text.length > limit) throw new MetadataError(property, "length_limit", `${property} exceeds ${limit} characters.`);
  return text;
}

/** @param {unknown} value */
export function normalizeName(value) {
  const name = textValue(value, "ai_name", CATALOG_LIMITS.nameCharacters);
  if (!name) throw new MetadataError("ai_name", "empty_name", "ai_name must not be empty.");
  if (name.includes(":")) throw new MetadataError("ai_name", "invalid_name", "ai_name must not contain a colon.");
  return name;
}

/** @param {unknown} value */
export function normalizeDescription(value) {
  return value === undefined ? "" : textValue(value, "ai_description", CATALOG_LIMITS.descriptionCharacters);
}

/** @param {unknown} value */
export function normalizeTags(value) {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new MetadataError("ai_tags", "invalid_property_type", "ai_tags must be a string.");
  /** @type {Map<string, string>} */
  const tags = new Map();
  for (const segment of value.split(",")) {
    const tag = textValue(segment, "ai_tags", CATALOG_LIMITS.tagCharacters);
    if (!tag) continue;
    const key = semanticKey(tag);
    const previous = tags.get(key);
    // Keep the lexicographically smallest display variant, regardless of input order.
    if (previous === undefined || compareText(tag, previous) < 0) tags.set(key, tag);
  }
  if (tags.size > CATALOG_LIMITS.tagsPerTile) throw new MetadataError("ai_tags", "tag_count_limit", "ai_tags exceeds 20 distinct tags.");
  return Array.from(tags.keys()).sort(compareText).map(key => /** @type {string} */ (tags.get(key)));
}

/** @typedef {{name: string, description?: string, tags: string[]}} TileMetadata */
/** @param {unknown} name @param {unknown} description @param {unknown} tags */
export function normalizeTileMetadata(name, description, tags) {
  /** @type {MetadataError[]} */
  const diagnostics = [];
  /** @type {TileMetadata} */
  const metadata = { name: "", tags: [] };
  try { if (name !== undefined) metadata.name = normalizeName(name); }
  catch (error) { if (!(error instanceof MetadataError)) throw error; diagnostics.push(error); }
  try {
    const value = normalizeDescription(description);
    if (value) metadata.description = value;
  } catch (error) { if (!(error instanceof MetadataError)) throw error; diagnostics.push(error); }
  try { metadata.tags = normalizeTags(tags); }
  catch (error) { if (!(error instanceof MetadataError)) throw error; diagnostics.push(error); }
  return { metadata: name === undefined || diagnostics.length ? null : metadata, diagnostics };
}
