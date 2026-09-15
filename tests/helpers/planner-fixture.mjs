export function plannerRequest() {
  return {
    schemaVersion: 1,
    requestId: "opaque-é-1",
    instruction: "fill empty cells",
    context: {
      schemaVersion: 1,
      map: { width: 100, height: 80, tileWidth: 16, tileHeight: 16, infinite: false },
      layer: { id: 3, name: "Ground" },
      selection: { x: 12, y: 8, width: 3, height: 1 },
      cells: [[{ tileset: "terrain", tileId: 4 }, null, null]],
    },
  };
}
