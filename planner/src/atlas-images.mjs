import sharp from "sharp";
export { sharp };
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  cropRect,
  ANALYSIS_LIMITS,
} from "../../src/core/analysis-protocol.mjs";
import { contentHash } from "../../src/core/content-hash.mjs";
import { boundedRead, projectPath } from "./analysis-storage.mjs";
import { XMLParser } from "fast-xml-parser";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

/** @typedef {{tileId:number,png:Buffer,pixelHash:string,empty:boolean,rect:ReturnType<typeof cropRect>,thumbnail:string}} Crop */
/** @param {string} root @param {import('../../src/core/analysis-protocol.mjs').Snapshot} snapshot @param {number[]} ids @param {string} jobId */
export async function atlasCrops(root, snapshot, ids, jobId) {
  const source = boundedRead(
    projectPath(root, snapshot.imageKey),
    ANALYSIS_LIMITS.fileBytes,
  );
  let image = sharp(source, {
    limitInputPixels: ANALYSIS_LIMITS.pixels,
    animated: false,
  });
  const metadata = await image.metadata();
  const g = snapshot.geometry;
  if (
    metadata.width !== g.width ||
    metadata.height !== g.height ||
    (metadata.pages || 1) !== 1
  )
    throw new Error(
      "Saved image dimensions differ from loaded tileset, or atlas is animated. Reload the tileset.",
    );
  const sourceText = boundedRead(projectPath(root, snapshot.key)).toString(
    "utf8",
  );
  // Reject DTDs; only standard XML character entities are relevant here.
  if (/<!DOCTYPE/i.test(sourceText))
    throw new Error("DTD-bearing tilesets are unsupported.");
  const xml = snapshot.key.toLowerCase().endsWith(".tsx");
  const saved = xml
    ? new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "",
        processEntities: true,
        trimValues: false,
        parseTagValue: false,
      }).parse(sourceText).tileset
    : JSON.parse(sourceText);
  if (
    !saved ||
    Number(saved.tilewidth) !== g.tileWidth ||
    Number(saved.tileheight) !== g.tileHeight ||
    Number(saved.columns) !== g.columns ||
    Number(saved.margin || 0) !== g.margin ||
    Number(saved.spacing || 0) !== g.spacing ||
    saved.name !== snapshot.name
  )
    throw new PlannerError(
      "SOURCE_CHANGED",
      "Loaded tileset geometry differs from saved metadata. Save/reload and restart analysis.",
    );
  const transparent =
    typeof saved.image === "object"
      ? saved.image.trans
      : saved.transparentcolor;
  let keyColor = /** @type {number[]|null} */ (null);
  if (transparent !== undefined) {
    const hex = String(transparent).replace(/^#/, "");
    if (!/^[a-f0-9]{6}$/i.test(hex))
      throw new Error("Invalid atlas transparency color.");
    keyColor = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  if (keyColor) {
    const decoded = await image
      .clone()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer();
    for (let i = 0; i < decoded.length; i += 4)
      if (
        decoded[i] === keyColor[0] &&
        decoded[i + 1] === keyColor[1] &&
        decoded[i + 2] === keyColor[2]
      )
        decoded[i + 3] = 0;
    image = sharp(decoded, {
      raw: { width: g.width, height: g.height, channels: 4 },
    });
  }
  const savedTiles = xml
    ? Array.isArray(saved.tile)
      ? saved.tile
      : saved.tile
        ? [saved.tile]
        : []
    : saved.tiles || [];
  for (const fact of snapshot.tiles) {
    const tile =
      savedTiles.find(
        (/** @type {{id:string|number}} */ t) => Number(t.id) === fact.tileId,
      ) || {};
    const frames = xml
      ? tile.animation
        ? (Array.isArray(tile.animation.frame)
            ? tile.animation.frame
            : [tile.animation.frame]
          ).map((/** @type {{tileid:string,duration:string}} */ f) => ({
            tileId: Number(f.tileid),
            duration: Number(f.duration),
          }))
        : []
      : (tile.animation || []).map(
          (/** @type {{tileid:number,duration:number}} */ f) => ({
            tileId: f.tileid,
            duration: f.duration,
          }),
        );
    const collision = xml
      ? Boolean(tile.objectgroup && tile.objectgroup.object)
      : Boolean(
          tile.objectgroup &&
          tile.objectgroup.objects &&
          tile.objectgroup.objects.length,
        );
    if (
      (tile.class || tile.type || "") !== fact.className ||
      JSON.stringify(frames) !== JSON.stringify(fact.frames) ||
      collision !== fact.hasCollisionGeometry
    )
      throw new PlannerError(
        "SOURCE_CHANGED",
        "Loaded structural metadata differs from disk. Save/reload the tileset.",
      );
    const properties = xml
      ? tile.properties
        ? Array.isArray(tile.properties.property)
          ? tile.properties.property
          : [tile.properties.property]
        : []
      : tile.properties || [];
    for (const [field, property] of [
      ["name", "ai_name"],
      ["description", "ai_description"],
      ["tags", "ai_tags"],
    ]) {
      const found = properties.find(
        (/** @type {{name:string}} */ p) => p.name === property,
      );
      if (
        found &&
        String(
          found.value === undefined ? found["#text"] || "" : found.value,
        ) !== fact.manual[/** @type {keyof typeof fact.manual} */ (field)]
      )
        throw new PlannerError(
          "SOURCE_CHANGED",
          "Loaded manual annotation differs from disk. Save/reload the tileset.",
        );
    }
  }
  /** @type {Crop[]} */ const crops = [];
  for (const tileId of ids) {
    const rect = cropRect(g, tileId);
    const raw = await image
      .clone()
      .extract(rect)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer();
    if (keyColor)
      for (let i = 0; i < raw.length; i += 4)
        if (
          raw[i] === keyColor[0] &&
          raw[i + 1] === keyColor[1] &&
          raw[i + 2] === keyColor[2]
        )
          raw[i + 3] = 0;
    const empty = raw.every((v, i) => i % 4 !== 3 || v === 0);
    const png = await sharp(raw, {
      raw: { width: rect.width, height: rect.height, channels: 4 },
    })
      .png()
      .toBuffer();
    const thumbnail = `.tiled-ai/cache/jobs/${jobId}/tile-${tileId}.png`;
    const path = projectPath(root, thumbnail);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      projectPath(root, `.tiled-ai/cache/jobs/${jobId}/crop-${tileId}.png`),
      png,
    );
    await sharp(png)
      .resize(96, 96, {
        fit: "contain",
        kernel: "nearest",
        background: { r: 112, g: 112, b: 112, alpha: 1 },
      })
      .png()
      .toFile(path);
    crops.push({
      tileId,
      png,
      pixelHash: contentHash(raw),
      empty,
      rect,
      thumbnail,
    });
  }
  return { crops, image };
}
/** SVG contains numeric IDs only; gutters are outside the 96x96 sprite area.
 * @param {Crop[]} crops */
export async function contactSheet(crops) {
  if (!crops.length || crops.length > 32)
    throw new Error("Contact sheet must contain 1..32 tiles.");
  const columns = Math.min(8, crops.length),
    width = columns * 104,
    height = Math.ceil(crops.length / columns) * 124;
  /** @type {import('sharp').OverlayOptions[]} */ const overlays = [];
  for (let i = 0; i < crops.length; i++) {
    const left = (i % columns) * 104 + 4,
      top = Math.floor(i / columns) * 124;
    const tile = await sharp(crops[i].png)
      .flatten({ background: "#707070" })
      .resize(96, 96, {
        fit: "contain",
        kernel: "nearest",
        background: "#707070",
      })
      .png()
      .toBuffer();
    overlays.push({ input: tile, left, top });
    const label = Buffer.from(
      `<svg width="96" height="24"><rect width="96" height="24" fill="#ededed"/><text x="4" y="18" font-size="15" fill="#111">ID ${crops[i].tileId}</text></svg>`,
    );
    overlays.push({ input: label, left, top: top + 96 });
  }
  const data = await sharp({
    create: { width, height, channels: 3, background: "#ededed" },
  })
    .composite(overlays)
    .png()
    .toBuffer();
  if (data.length > ANALYSIS_LIMITS.imageBytes)
    throw new Error("Contact sheet exceeds 4 MiB.");
  return data;
}
/** A bounded neighboring crop for each tile; absolute crop origin accompanies it.
 * @param {import('sharp').Sharp} image @param {Crop} tile @param {import('../../src/core/analysis-protocol.mjs').Snapshot['geometry']} g */
export async function contextCrop(image, tile, g) {
  const left = Math.max(0, tile.rect.left - g.tileWidth - g.spacing),
    top = Math.max(0, tile.rect.top - g.tileHeight - g.spacing);
  const width = Math.min(g.width - left, g.tileWidth * 3 + g.spacing * 2),
    height = Math.min(g.height - top, g.tileHeight * 3 + g.spacing * 2);
  const png = await image
    .clone()
    .extract({ left, top, width, height })
    .flatten({ background: "#707070" })
    .resize(192, 192, { fit: "inside", kernel: "nearest" })
    .png()
    .toBuffer();
  return { origin: { left, top, width, height }, png };
}
