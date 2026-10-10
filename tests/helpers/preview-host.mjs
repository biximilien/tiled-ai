import { registerPreviewTool } from "../../src/tiled/preview-tool.mjs";

/** @type {Tool} */ let registered;
export function captureTool(/** @type {string} */ _name, /** @type {ToolDefinition} */ definition) {
  registered = /** @type {Tool} */ (definition);
  Object.defineProperty(registered, "map", { get: () => tiled.activeAsset });
  return registered;
}
export function activatePreview() { registerPreviewTool(); registered.activated?.call(registered); registered.mouseEntered?.call(registered); }
export function deactivatePreview() { registered?.deactivated?.call(registered); }
export function previewKey(/** @type {number} */ key) { registered.keyPressed?.call(registered, key, 0); }

export class PreviewLayer {
  name = "";
  /** @type {Map<string,Tile>} */ cells = new Map();
  /** @param {number} x @param {number} y */ tileAt(x, y) { return this.cells.get(`${x},${y}`) || null; }
  edit() {
    /** @type {{x:number,y:number,tile:Tile}[]} */ const pending = [];
    return { setTile: (/** @type {number} */ x, /** @type {number} */ y, /** @type {Tile} */ tile) => pending.push({ x, y, tile }),
      apply: () => { for (const p of pending) this.cells.set(`${p.x},${p.y}`, p.tile); } };
  }
}
export class PreviewMap {
  static Orthogonal = 0;
  /** @type {PreviewLayer[]} */ layers = [];
  /** @param {number} width @param {number} height */ setSize(width, height) { this.width = width; this.height = height; }
  /** @param {number} width @param {number} height */ setTileSize(width, height) { this.tileWidth = width; this.tileHeight = height; }
  /** @param {PreviewLayer} layer */ addLayer(layer) { this.layers.push(layer); }
}
/** @param {import('node:test').TestContext} t */
export function previewHost(t) {
  for (const [key, value] of Object.entries({ TileMap: PreviewMap, TileLayer: PreviewLayer })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
}
