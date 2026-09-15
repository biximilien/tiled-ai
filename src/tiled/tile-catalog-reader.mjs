import { isTileMapAsset } from "../core/validation.mjs";
import { SelectionError } from "./map-reader.mjs";
import { CatalogError, requireTileCatalog } from "../core/tile-catalog.mjs";
import { CATALOG_LIMITS, compareText, normalizeTileMetadata, semanticKey } from "../core/tile-metadata.mjs";

/** @typedef {{severity: string, tileset: string, tileId?: number, property: string, code: string, message: string}} CatalogDiagnostic */
/** @param {Asset | null} asset */
export function buildTileCatalog(asset) {
  if (!isTileMapAsset(asset)) throw new SelectionError("Open a tile map first.");
  const map = /** @type {TileMap} */ (asset);
  /** @type {import('../core/tile-catalog.mjs').TileCatalog} */
  const catalog = { schemaVersion: 1, tilesets: [] };
  /** @type {CatalogDiagnostic[]} */
  const diagnostics = [];
  const summary = { annotated: 0, ignored: 0, invalid: 0, tilesets: map.tilesets.length };
  const seenSets = new Set();
  for (const set of map.tilesets.slice().sort((a, b) => compareText(a.name, b.name))) {
    const key = semanticKey(set.name);
    if (!key || set.name.includes(":") || seenSets.has(key)) {
      diagnostics.push({ severity: "error", tileset: set.name, property: "name", code: "invalid_tileset_name",
        message: "Referenced tileset names must be non-empty, unique ignoring case/edge whitespace, and contain no colon." });
    }
    seenSets.add(key);
    /** @type {import('../core/tile-catalog.mjs').CatalogTile[]} */
    const tiles = [];
    const seenNames = new Set();
    // The collection includes sparse/image-collection IDs; never iterate 0..tileCount.
    for (const tile of set.tiles.slice().sort((a, b) => a.id - b.id)) {
      const result = normalizeTileMetadata(tile.property("ai_name"), tile.property("ai_description"), tile.property("ai_tags"));
      for (const diagnostic of result.diagnostics) diagnostics.push({
        severity: "error", tileset: set.name, tileId: tile.id,
        property: diagnostic.property, code: diagnostic.code, message: diagnostic.message,
      });
      if (!result.metadata) {
        if (result.diagnostics.length) summary.invalid++;
        else summary.ignored++;
        continue;
      }
      const metadata = result.metadata;
      const nameKey = semanticKey(metadata.name);
      if (seenNames.has(nameKey)) diagnostics.push({ severity: "error", tileset: set.name, tileId: tile.id,
        property: "ai_name", code: "duplicate_tile_name", message: "Duplicate semantic name in this tileset (ignoring case/edge whitespace)." });
      seenNames.add(nameKey);
      summary.annotated++;
      if (summary.annotated > CATALOG_LIMITS.annotatedTiles) continue;
      /** @type {import('../core/tile-catalog.mjs').CatalogTile} */
      const entry = { tileId: tile.id, name: metadata.name, tags: metadata.tags };
      if (metadata.description !== undefined) entry.description = metadata.description;
      tiles.push(entry);
    }
    catalog.tilesets.push({ name: set.name, tiles });
  }
  if (summary.annotated > CATALOG_LIMITS.annotatedTiles) diagnostics.push({
    severity: "error", tileset: "", property: "catalog", code: "catalog_limit", message: "Catalog exceeds 500 annotated tiles.",
  });
  if (!diagnostics.length) {
    try { requireTileCatalog(catalog); }
    catch (error) { diagnostics.push({ severity: "error", tileset: "", property: "catalog", code: "invalid_catalog",
      message: error instanceof Error ? error.message : String(error) }); }
  }
  // Never expose a partial catalog after an error or limit violation.
  return { catalog: diagnostics.length ? null : catalog, diagnostics, summary };
}

/** @param {ReturnType<typeof buildTileCatalog>} result */
export function reportCatalog(result) {
  for (const diagnostic of result.diagnostics) tiled.log(JSON.stringify(diagnostic));
  if (!result.catalog) {
    const first = result.diagnostics[0];
    throw new CatalogError("INVALID_CATALOG", `Tile catalog invalid: ${first.tileset}${first.tileId === undefined ? "" : ` tile ${first.tileId}`} ${first.property}: ${first.message} See Console.`);
  }
  if (!result.summary.annotated) tiled.log("Tile catalog is empty. Add a string ai_name property to individual tiles in the tileset editor.");
  return result.catalog;
}
