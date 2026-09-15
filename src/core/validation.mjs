/**
 * Check Tiled's tile-map discriminator without accessing the Tiled runtime.
 * @param {unknown} asset
 * @returns {asset is { isTileMap: true }}
 */
export function isTileMapAsset(asset) {
  return (
    typeof asset === "object" &&
    asset !== null &&
    "isTileMap" in asset &&
    asset.isTileMap === true
  );
}
