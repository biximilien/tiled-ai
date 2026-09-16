import { compareText } from "./tile-metadata.mjs";

/** @typedef {{context: import('./edit-protocol.mjs').SelectionContext, orientation: string,
 * flags: number[][], catalog?: import('./tile-catalog.mjs').TileCatalog}} RelevantContext */

/** Inputs are locally read/validated snapshots, not raw planner responses.
 * Excludes selection UI, layer name, map filename, viewport and outside cells.
 * @param {RelevantContext} snapshot */
export function fingerprintContext(snapshot) {
  const context = snapshot.context;
  const catalog = snapshot.catalog ? snapshot.catalog.tilesets.map(set => ({
    name: set.name,
    tiles: set.tiles.map(tile => ({ name: tile.name, tileId: tile.tileId,
      description: tile.description || "", tags: tile.tags.slice().sort(compareText),
    })).sort((a, b) => compareText(a.name, b.name)),
  })).sort((a, b) => compareText(a.name, b.name)) : null;
  return JSON.stringify({ orientation: snapshot.orientation,
    tileWidth: context.map.tileWidth, tileHeight: context.map.tileHeight,
    infinite: context.map.infinite, layerId: context.layer.id,
    region: { x: context.selection.x, y: context.selection.y,
      width: context.selection.width, height: context.selection.height },
    cells: context.cells.map(row => row.map(tile => tile ? { tileset: tile.tileset, tileId: tile.tileId } : null)),
    flags: snapshot.flags, catalog });
}
