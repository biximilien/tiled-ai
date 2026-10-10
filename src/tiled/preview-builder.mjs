import { EditError } from "../core/edit-protocol.mjs";

/** Native brush coordinates are already absolute. Its item supplies the active
 * layer's offset; until viewport tests cover offsets/parallax, reject them.
 * @param {TileMap} map @param {TileLayer} layer */
export function requirePreviewGeometry(map, layer) {
  if (map.orientation !== TileMap.Orthogonal) throw new EditError("AI Preview currently requires an orthogonal map.");
  for (let current = /** @type {Layer|null} */ (layer); current; current = current.parentLayer) {
    if (current.offset.x !== 0 || current.offset.y !== 0 || current.parallaxFactor.x !== 1 || current.parallaxFactor.y !== 1) {
      throw new EditError("AI Preview does not yet support layer/group offsets or parallax. No generated edits were applied.");
    }
  }
}

/** @param {TileLayer} layer */
export function previewTargetVisible(layer) {
  for (let current = /** @type {Layer|null} */ (layer); current; current = current.parentLayer) {
    if (!current.visible || current.opacity <= 0) return false;
  }
  return true;
}

/** Build only proposed cells; never clone/add a layer to the live document.
 * Schema 1 permits only untransformed setTile placements.
 * @param {TileMap} source @param {{x:number,y:number,tile:Tile}[]} placements */
export function buildPreview(source, placements) {
  const preview = new TileMap();
  preview.setTileSize(source.tileWidth, source.tileHeight);
  preview.setSize(source.width, source.height);
  preview.orientation = source.orientation;
  preview.infinite = source.infinite;
  const layer = new TileLayer();
  layer.name = "AI Preview";
  preview.addLayer(layer);
  const edit = layer.edit();
  for (const placement of placements) edit.setTile(placement.x, placement.y, placement.tile);
  edit.apply();
  return preview;
}
