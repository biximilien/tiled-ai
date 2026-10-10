import { sharp } from "../planner/src/atlas-images.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(
  new URL("../tests/fixtures/analysis/", import.meta.url),
);
mkdirSync(directory, { recursive: true });
const width = 58,
  height = 40,
  tw = 18,
  th = 12,
  margin = 2,
  spacing = 1;
const pixels = Buffer.alloc(width * height * 4);
for (let id = 0; id < 8; id++)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      if (id === 4) continue;
      let rgb =
        id === 1 || id === 5 || id === 6 ? [45, 110, 210] : [60, 165, 75];
      if (id === 2 && x + y > 16) rgb = [45, 110, 210];
      if (id === 3) {
        if (x < 3 || x > 14) continue;
        rgb = y < 8 ? [30, 110, 40] : [120, 75, 35];
      }
      if (id === 7) {
        if (y < 4 && x < 8) continue;
        rgb = y < 5 ? [170, 55, 45] : [170, 165, 155];
      }
      if ((x + y) % 5 === 0) rgb = rgb.map((c) => Math.min(255, c + 25));
      const i =
        ((margin + Math.floor(id / 3) * (th + spacing) + y) * width +
          margin +
          (id % 3) * (tw + spacing) +
          x) *
        4;
      pixels.set(rgb.concat(255), i);
    }
await sharp(pixels, { raw: { width, height, channels: 4 } })
  .png()
  .toFile(directory + "atlas.png");
writeFileSync(
  directory + "atlas.tsx",
  `<?xml version="1.0" encoding="UTF-8"?>
<tileset version="1.10" tiledversion="1.11.2" name="analysis-fixture" tilewidth="18" tileheight="12" spacing="1" margin="2" tilecount="8" columns="3">
 <image source="atlas.png" width="58" height="40"/>
 <tile id="3" type="tree-part"><objectgroup><object id="1" x="6" y="8" width="6" height="4"/></objectgroup></tile>
 <tile id="5"><animation><frame tileid="5" duration="150"/><frame tileid="6" duration="150"/></animation></tile>
 <tile id="7" type="building-part"/>
</tileset>\n`,
);
writeFileSync(
  directory + "map.tmx",
  `<?xml version="1.0" encoding="UTF-8"?>
<map version="1.10" tiledversion="1.11.2" orientation="orthogonal" renderorder="right-down" width="20" height="15" tilewidth="18" tileheight="12" infinite="0" nextlayerid="2" nextobjectid="1">
 <tileset firstgid="1" source="atlas.tsx"/>
 <layer id="1" name="Ground" width="20" height="15"><data encoding="csv">${Array(300).fill(0).join(",")}</data></layer>
</map>\n`,
);
writeFileSync(
  directory + "evaluation.json",
  JSON.stringify(
    {
      note: "Synthetic fixture author intent, not a live-model accuracy measurement. Human review still required.",
      tiles: [
        { tileId: 0, appearance: "grass interior", role: "standalone" },
        { tileId: 1, appearance: "water interior", role: "standalone" },
        {
          tileId: 2,
          appearance: "grass/water corner",
          role: "terrain_transition",
        },
        {
          tileId: 3,
          appearance: "tree fragment with collision geometry",
          role: "object_fragment",
        },
        { tileId: 4, appearance: "transparent", role: "empty" },
        { tileId: 5, appearance: "animated water", role: "animation_frame" },
        { tileId: 6, appearance: "water frame", role: "animation_frame" },
        { tileId: 7, appearance: "building fragment", role: "object_fragment" },
      ],
    },
    null,
    2,
  ) + "\n",
);
