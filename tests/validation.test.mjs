import assert from "node:assert/strict";
import test from "node:test";
import { isTileMapAsset } from "../src/core/validation.mjs";

test("rejects missing assets, non-map assets, and invalid discriminators", () => {
  for (const asset of [
    null,
    undefined,
    {},
    { isTileMap: false },
    { isTileMap: "true" },
    { isTileMap: 1 },
    true,
    1,
    "map",
  ]) {
    assert.equal(isTileMapAsset(asset), false);
  }
});

test("recognizes a tile map by its discriminator", () => {
  assert.equal(isTileMapAsset({ isTileMap: true }), true);
  assert.equal(isTileMapAsset({ isTileMap: true, width: 100, height: 80 }), true);
});
