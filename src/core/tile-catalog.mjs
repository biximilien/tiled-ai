import { EditError, integer, requireArray, requireObject } from "./edit-protocol.mjs";
import { CATALOG_LIMITS, compareText, normalizeName, normalizeDescription, normalizeTags, semanticKey } from "./tile-metadata.mjs";
import { utf8Bytes } from "./utf8.mjs";

/** @typedef {import('./tile-metadata.mjs').TileMetadata & {tileId: number}} CatalogTile */
/** @typedef {{schemaVersion: number, tilesets: {name: string, tiles: CatalogTile[]}[]}} TileCatalog */
export class CatalogError extends EditError {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.code = code; }
}

/** @param {unknown} condition @param {string} code @param {string} message @returns {asserts condition} */
function check(condition, code, message) { if (!condition) throw new CatalogError(code, message); }

/** Defensive validation of the separately versioned, already normalized wire catalog.
 * @param {unknown} catalog @returns {asserts catalog is TileCatalog}
 */
export function requireTileCatalog(catalog) {
  try {
    requireObject(catalog, ["schemaVersion", "tilesets"], "Tile catalog");
    check(catalog.schemaVersion === 1, "INVALID_CATALOG", "Unsupported tile catalog schema version.");
    requireArray(catalog.tilesets, "Catalog tilesets");
    const names = new Set();
    let count = 0;
    let previousSet = "";
    for (const tileset of catalog.tilesets) {
      requireObject(tileset, ["name", "tiles"], "Catalog tileset");
      check(typeof tileset.name === "string" && semanticKey(tileset.name) !== "" && !tileset.name.includes(":"),
        "INVALID_CATALOG", "Tileset names must be non-empty strings without colons.");
      const key = semanticKey(tileset.name);
      check(!names.has(key), "DUPLICATE_TILESET", "Duplicate normalized tileset name in catalog.");
      names.add(key);
      check(compareText(previousSet, tileset.name) <= 0, "INVALID_CATALOG", "Catalog tilesets must be sorted by name.");
      previousSet = tileset.name;
      requireArray(tileset.tiles, "Catalog tiles");
      count += tileset.tiles.length;
      check(count <= CATALOG_LIMITS.annotatedTiles, "CATALOG_LIMIT", "Catalog exceeds 500 annotated tiles.");
      const tileNames = new Set();
      let previousId = -1;
      for (const tile of tileset.tiles) {
        const keys = ["tileId", "name", "tags"];
        if (tile && Object.prototype.hasOwnProperty.call(tile, "description")) keys.push("description");
        requireObject(tile, keys, "Catalog tile");
        check(integer(tile.tileId) && tile.tileId >= 0 && tile.tileId > previousId,
          "INVALID_CATALOG", "Catalog tiles must have unique ascending local IDs.");
        previousId = tile.tileId;
        check(normalizeName(tile.name) === tile.name, "INVALID_CATALOG", "Catalog tile names must be trimmed.");
        const nameKey = semanticKey(/** @type {string} */ (tile.name));
        check(!tileNames.has(nameKey), "DUPLICATE_TILE_NAME", `Duplicate semantic name in tileset "${tileset.name}".`);
        tileNames.add(nameKey);
        if (keys.includes("description")) {
          check(typeof tile.description === "string" && tile.description !== "" && normalizeDescription(tile.description) === tile.description,
            "INVALID_CATALOG", "Catalog descriptions must be non-empty trimmed strings.");
        }
        requireArray(tile.tags, "Catalog tags");
        check(tile.tags.every(tag => typeof tag === "string" && tag.length > 0 && !tag.includes(",")),
          "INVALID_CATALOG", "Catalog tags must be non-empty strings without commas.");
        check(JSON.stringify(normalizeTags(tile.tags.join(","))) === JSON.stringify(tile.tags),
          "INVALID_CATALOG", "Catalog tags must be normalized, unique, and sorted.");
      }
    }
    check(utf8Bytes(JSON.stringify(catalog)) <= CATALOG_LIMITS.serializedBytes,
      "CATALOG_LIMIT", "Serialized tile catalog exceeds 512 KiB.");
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    throw new CatalogError("INVALID_CATALOG", error instanceof Error ? error.message : String(error));
  }
}

/** @param {unknown} catalog @param {string} reference */
export function lookupSemanticTile(catalog, reference) {
  requireTileCatalog(catalog);
  const parts = reference.trim().split(":");
  check(parts.length <= 2 && parts.every(part => part.trim().length > 0), "INVALID_TILE_REFERENCE", "Use name or tileset:name with non-empty names.");
  const qualifier = parts.length === 2 ? semanticKey(parts[0]) : null;
  const name = semanticKey(parts[parts.length - 1]);
  /** @type {{tileset: string, tileId: number, name: string}[]} */
  const entries = [];
  for (const set of catalog.tilesets) for (const tile of set.tiles) {
    entries.push({ tileset: set.name, tileId: tile.tileId, name: tile.name });
  }
  const matches = entries.filter(tile => semanticKey(tile.name) === name &&
    (qualifier === null || semanticKey(tile.tileset) === qualifier));
  const choices = (matches.length ? matches : entries).map(tile => `${tile.tileset}:${tile.name}`)
    .sort((a, b) => compareText(semanticKey(a), semanticKey(b)) || compareText(a, b));
  const suggestions = choices.slice(0, CATALOG_LIMITS.suggestions).join(", ");
  check(matches.length !== 0, "UNKNOWN_TILE", `Unknown tile "${reference.slice(0, 160)}". Available tiles include: ${suggestions || "none; add ai_name to tiles"}.`);
  check(matches.length === 1, "AMBIGUOUS_TILE", `Ambiguous tile name. Use a qualified reference: ${suggestions}.`);
  return { tileset: matches[0].tileset, tileId: matches[0].tileId };
}

/** @param {string} instruction */
export function isSemanticInstruction(instruction) {
  const normalized = instruction.trim().toLowerCase();
  return normalized === "fill empty with" || normalized.startsWith("fill empty with ");
}
