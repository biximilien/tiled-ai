import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { contentHash } from "../../src/core/content-hash.mjs";
import {
  cropRect,
  suggestions,
  analysisDeadline,
  requireAnalysisRequest,
  ANALYSIS_VERSION,
} from "../../src/core/analysis-protocol.mjs";
import {
  acceptEntry,
  eligibleAnnotation,
  mergeManual,
  validateSidecar,
  checkAliases,
  uniqueCandidates,
} from "../../src/core/analysis-catalog.mjs";
import { analyzeTileset, fakeVision } from "../src/tileset-analysis.mjs";
import { atlasCrops, contactSheet, sharp } from "../src/atlas-images.mjs";
import {
  loadSidecar,
  sourceHash,
  projectPath,
  atomicJson,
  sidecarKey,
} from "../src/analysis-storage.mjs";
import { parseTileSubset } from "../../src/tiled/analysis-action.mjs";
import { buildTileCatalog } from "../../src/tiled/tile-catalog-reader.mjs";
import { visionAdapter } from "../src/vision-adapter.mjs";
import OpenAI from "openai";
import { JobController } from "../../src/core/job-controller.mjs";
import {
  acquireJobSlot,
  releaseJobSlot,
  requireFreeJobSlot,
} from "../../src/core/job-slot.mjs";
import { parseJobResponse } from "../../src/core/job-response.mjs";
import { plannerRequest } from "../../tests/helpers/planner-fixture.mjs";
import { parseAnalysisResponse } from "../../src/tiled/analysis-process.mjs";

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tiled-analysis-"));
  cpSync(new URL("../../tests/fixtures/analysis", import.meta.url), root, {
    recursive: true,
    filter: (p) => !p.includes(".tiled-ai"),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** @type {import('../../src/core/analysis-protocol.mjs').Snapshot} */
  const snapshot = {
    key: "atlas.tsx",
    imageKey: "atlas.png",
    name: "analysis-fixture",
    geometry: {
      width: 58,
      height: 40,
      tileWidth: 18,
      tileHeight: 12,
      columns: 3,
      margin: 2,
      spacing: 1,
    },
    tiles: Array.from({ length: 8 }, (_, id) => ({
      tileId: id,
      manual: {},
      className: id === 3 ? "tree-part" : id === 7 ? "building-part" : "",
      hasCollisionGeometry: id === 3,
      frames:
        id === 5
          ? [
              { tileId: 5, duration: 150 },
              { tileId: 6, duration: 150 },
            ]
          : [],
      animationMember: id === 5 || id === 6,
      wang: [],
    })),
  };
  /** @type {import('../../src/core/analysis-protocol.mjs').AnalysisRequest} */
  const request = {
    schemaVersion: 2,
    operation: "analyze_tileset",
    action: "run",
    requestId: "request-1",
    jobId: "job-1",
    root,
    snapshot,
    sourceHash: sourceHash(root, snapshot),
    ids: snapshot.tiles.map((t) => t.tileId),
    batchSize: 3,
  };
  return { root, snapshot, request, env: { TILED_AI_TEST_MODE: "1" } };
}
/** @param {Awaited<ReturnType<typeof analyzeTileset>>} result */
function review(result) {
  assert.ok("sidecar" in result);
  return result;
}

test("shared Qt/Node SHA-256 matches standard crypto for Unicode and binary data", () => {
  for (const value of [
    "",
    "Forêt 🌲",
    Buffer.from(Array.from({ length: 130 }, (_, i) => i)),
    Buffer.alloc(1024 * 1024, 91),
  ])
    assert.equal(
      contentHash(value),
      createHash("sha256").update(value).digest("hex"),
    );
});
test("atlas geometry handles margins, spacing, non-square tiles, incomplete rows and bounds", () => {
  const g = {
    width: 58,
    height: 40,
    tileWidth: 18,
    tileHeight: 12,
    columns: 3,
    margin: 2,
    spacing: 1,
  };
  assert.deepEqual(cropRect(g, 7), {
    left: 21,
    top: 28,
    width: 18,
    height: 12,
  });
  for (const bad of [
    { ...g, columns: 4 },
    { ...g, spacing: -1 },
    { ...g, width: 1e8 },
    { ...g, tileWidth: 300 },
  ])
    assert.throws(() => cropRect(bad, 7));
  assert.throws(() => cropRect(g, 9), /outside/);
  assert.throws(() => cropRect(g, -1));
});
test("exact alpha crops and ID gutters preserve source pixels; transparent cells excluded", async (t) => {
  const f = fixture(t);
  const { crops } = await atlasCrops(
    f.root,
    f.snapshot,
    f.request.ids,
    f.request.jobId,
  );
  assert.equal(crops[4].empty, true);
  assert.equal(crops[3].empty, false);
  const raw = await sharp(crops[0].png).raw().toBuffer();
  const expected = await sharp(join(f.root, "atlas.png"))
    .extract(cropRect(f.snapshot.geometry, 0))
    .raw()
    .toBuffer();
  assert.deepEqual(raw, expected);
  const sheet = await contactSheet(crops.slice(0, 3));
  const metadata = await sharp(sheet).metadata();
  assert.equal(metadata.width, 312);
  assert.equal(metadata.height, 124);
  const sprite = await sharp(sheet)
    .extract({ left: 4, top: 0, width: 96, height: 96 })
    .raw()
    .toBuffer();
  const resized = await sharp(crops[0].png)
    .flatten({ background: "#707070" })
    .resize(96, 96, {
      fit: "contain",
      kernel: "nearest",
      background: "#707070",
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  // Composite output adds alpha; compare RGB only.
  const channels = (await sharp(sheet).metadata()).channels;
  assert.deepEqual(
    channels === 4 ? Buffer.from(sprite.filter((_, i) => i % 4 !== 3)) : sprite,
    resized,
  );
  assert.ok(existsSync(join(f.root, ".tiled-ai/cache/jobs/job-1/crop-0.png")));
});
test("color-key transparency is applied to exact crops without making ordinary black transparent", async (t) => {
  const f = fixture(t);
  let xml = readFileSync(join(f.root, "atlas.tsx"), "utf8").replace(
    'source="atlas.png"',
    'source="atlas.png" trans="3ca54b"',
  );
  writeFileSync(join(f.root, "atlas.tsx"), xml);
  const { crops } = await atlasCrops(f.root, f.snapshot, [0], "color-job");
  const raw = await sharp(crops[0].png).raw().toBuffer();
  assert.equal(raw[7], 0);
  assert.equal(raw[3], 255);
});
test("fake vision completes prepare/review/save/load with no generation leakage", async (t) => {
  const f = fixture(t);
  const before = readFileSync(join(f.root, "atlas.tsx"));
  let calls = 0;
  const adapter = async (
    /** @type {import('../src/vision-adapter.mjs').VisionInput} */ b,
  ) => {
    calls++;
    assert.ok(!b.ids.includes(4));
    assert.equal(b.ids.length, b.contexts.length);
    return fakeVision(b);
  };
  const prepared = review(
    await analyzeTileset({ ...f.request, action: "prepare" }, f.env, adapter),
  );
  assert.equal(calls, 0);
  assert.equal(prepared.needsIds.length, 7);
  const r = review(await analyzeTileset(f.request, f.env, adapter));
  assert.equal(calls, 3);
  assert.equal(r.failures.length, 0);
  assert.ok(r.sidecar.entries.every((e) => e.accepted === null));
  assert.equal(loadSidecar(f.root, f.snapshot.key).revision, null);
  for (let i = 0; i < r.sidecar.entries.length; i++) {
    const e = r.sidecar.entries[i];
    assert.ok(e.proposed);
    r.sidecar.entries[i] = acceptEntry(
      e,
      e.proposed.values,
      r.snapshot,
      r.sourceHash,
    );
  }
  const result = await analyzeTileset(
    {
      ...f.request,
      action: "save",
      save: { sidecar: r.sidecar, revision: r.revision },
    },
    f.env,
  );
  assert.ok("saved" in result);
  const loaded = loadSidecar(f.root, f.snapshot.key);
  assert.ok(loaded.revision);
  const eligible = loaded.sidecar.entries
    .filter((e) => eligibleAnnotation(e, r.sourceHash))
    .map((e) => e.tileId)
    .sort((a, b) => a - b);
  assert.deepEqual(eligible, [0, 1]);
  assert.deepEqual(readFileSync(join(f.root, "atlas.tsx")), before);
  const again = review(await analyzeTileset(f.request, f.env, adapter));
  assert.equal(calls, 3);
  assert.equal(again.needsIds.length, 0);
});
test("cached rerun makes zero calls; source/context or analysis config changes invalidate proposals", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const adapter = async (
    /** @type {import('../src/vision-adapter.mjs').VisionInput} */ b,
  ) => {
    calls++;
    return fakeVision(b);
  };
  await analyzeTileset(f.request, f.env, adapter);
  await analyzeTileset(f.request, f.env, adapter);
  assert.equal(calls, 3);
  await analyzeTileset({ ...f.request, batchSize: 2 }, f.env, adapter);
  assert.equal(calls, 7);
  // Change an atlas pixel outside the selected tile; neighboring evidence is conservative whole-source invalidation.
  const image = await sharp(join(f.root, "atlas.png"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  image.data[0] = 42;
  await sharp(image.data, {
    raw: { width: image.info.width, height: image.info.height, channels: 4 },
  })
    .png()
    .toFile(join(f.root, "replacement.png"));
  writeFileSync(
    join(f.root, "atlas.png"),
    readFileSync(join(f.root, "replacement.png")),
  );
  await assert.rejects(
    () => analyzeTileset(f.request, f.env, adapter),
    /source changed/,
  );
  f.request.sourceHash = sourceHash(f.root, f.snapshot);
  await analyzeTileset(f.request, f.env, adapter);
  assert.equal(calls, 10);
});
test("manual field presence and explicit empty values win; accepted user edits survive reanalysis", async (t) => {
  assert.deepEqual(
    mergeManual(
      { name: "manual", description: "", tags: "" },
      {
        tileId: 0,
        suggestedName: "model",
        description: "model",
        category: "ground",
        tags: ["ground"],
        placementRole: "standalone",
        uncertaintyReason: null,
      },
    ),
    { name: "manual", description: "", tags: "" },
  );
  const f = fixture(t);
  const r = review(await analyzeTileset(f.request, f.env));
  const e = r.sidecar.entries.find((e) => e.tileId === 0);
  assert.ok(e?.proposed);
  const edited = {
    ...e.proposed.values,
    suggestedName: "my_grass",
    description: "User correction",
  };
  r.sidecar.entries[r.sidecar.entries.indexOf(e)] = acceptEntry(
    e,
    edited,
    r.snapshot,
    r.sourceHash,
  );
  await analyzeTileset(
    {
      ...f.request,
      action: "save",
      save: { sidecar: r.sidecar, revision: null },
    },
    f.env,
  );
  const next = review(await analyzeTileset(f.request, f.env));
  const accepted = next.sidecar.entries.find((e) => e.tileId === 0)?.accepted;
  assert.equal(accepted?.values.suggestedName, "my_grass");
  assert.equal(accepted?.provenance.fields.description, "user-edited");
});
test("saved pending corrections survive cache and fresh analysis without acceptance", async (t) => {
  const f = fixture(t);
  const r = review(await analyzeTileset(f.request, f.env));
  const entry = r.sidecar.entries.find((e) => e.tileId === 0);
  assert.ok(entry?.proposed);
  entry.proposed.values.suggestedName = "pending_grass";
  entry.proposed.provenance.fields.suggestedName = "user-edited";
  await analyzeTileset(
    {
      ...f.request,
      action: "save",
      save: { sidecar: r.sidecar, revision: null },
    },
    f.env,
  );
  for (const batchSize of [3, 2]) {
    const next = review(
      await analyzeTileset({ ...f.request, batchSize }, f.env),
    );
    const pending = next.sidecar.entries.find((e) => e.tileId === 0);
    assert.equal(pending?.proposed?.values.suggestedName, "pending_grass");
    assert.equal(
      pending?.proposed?.provenance.fields.suggestedName,
      "user-edited",
    );
    assert.equal(pending?.accepted, null);
    assert.equal(pending?.state, "suggested");
  }
  writeFileSync(
    join(f.root, "atlas.tsx"),
    readFileSync(join(f.root, "atlas.tsx"), "utf8") + "\n",
  );
  f.request.sourceHash = sourceHash(f.root, f.snapshot);
  const fresh = review(await analyzeTileset(f.request, f.env));
  const pending = fresh.sidecar.entries.find((e) => e.tileId === 0);
  assert.equal(pending?.proposed?.values.suggestedName, "pending_grass");
  assert.equal(pending?.proposed?.sourceHash, f.request.sourceHash);
  assert.equal(pending?.accepted, null);
});

test("partial failed batches stay pending; explicit rerun calls only failed IDs", async (t) => {
  const f = fixture(t);
  const seen = /** @type {number[][]} */ ([]);
  const adapter = async (
    /** @type {import('../src/vision-adapter.mjs').VisionInput} */ b,
  ) => {
    seen.push(b.ids);
    if (b.ids.includes(3)) throw new Error("fixture failure");
    return fakeVision(b);
  };
  const r = review(await analyzeTileset(f.request, f.env, adapter));
  assert.equal(r.failures.length, 1);
  assert.ok(r.sidecar.entries.every((e) => e.accepted === null));
  const expected = r.failures[0].ids;
  seen.length = 0;
  await analyzeTileset(f.request, f.env, async (b) => {
    seen.push(b.ids);
    return fakeVision(b);
  });
  assert.deepEqual(seen, [expected]);
});
test("model IDs and closed suggestion schema are independently validated", async () => {
  const good = await fakeVision({
    ids: [0, 1],
    facts: [],
    sheet: Buffer.alloc(0),
    contexts: [],
  });
  assert.equal(suggestions(good, [0, 1]).length, 2);
  for (const bad of [
    { entries: [good.entries[0]] },
    { entries: [good.entries[0], good.entries[0]] },
    { entries: [good.entries[0], { ...good.entries[1], tileId: 99 }] },
    { entries: good.entries.map((e) => ({ ...e, state: "accepted" })) },
    { entries: good.entries.map((e) => ({ ...e, placementRole: "walkable" })) },
  ])
    assert.throws(() => suggestions(bad, [0, 1]));
});
test("aliases preserve tile identity across groups; manual collisions fail rather than rename manual aliases", async (t) => {
  const f = fixture(t);
  const r = review(await analyzeTileset(f.request, f.env));
  const proposals = r.sidecar.entries.flatMap((e) =>
    e.proposed?.values.suggestedName ? [e.proposed.values.suggestedName] : [],
  );
  assert.equal(new Set(proposals).size, proposals.length);
  const a = r.sidecar.entries.find((e) => e.tileId === 0);
  assert.ok(a?.proposed);
  f.snapshot.tiles[1].manual.name = a.proposed.values.suggestedName || "grass";
  r.sidecar.entries[r.sidecar.entries.indexOf(a)] = acceptEntry(
    a,
    a.proposed.values,
    f.snapshot,
    r.sourceHash,
  );
  assert.throws(() => checkAliases(f.snapshot, r.sidecar), /Duplicate/);
  const candidates = uniqueCandidates(f.snapshot, r.sidecar, [
    { ...a.proposed.values, tileId: 2 },
  ]);
  assert.match(candidates[0].suggestedName || "", /_variant_2/);
});
test("sidecar version, corruption, stale eligibility and optimistic save conflicts", async (t) => {
  const f = fixture(t);
  const r = review(await analyzeTileset(f.request, f.env));
  const e = r.sidecar.entries[0];
  assert.ok(e.proposed);
  r.sidecar.entries[0] = acceptEntry(
    e,
    e.proposed.values,
    r.snapshot,
    r.sourceHash,
  );
  assert.equal(eligibleAnnotation(r.sidecar.entries[0], "f".repeat(64)), null);
  assert.throws(
    () => validateSidecar({ ...r.sidecar, schemaVersion: 99 }, f.snapshot.key),
    /Unsupported/,
  );
  assert.throws(() => validateSidecar(r.sidecar, "moved.tsx"), /identity/);
  await analyzeTileset(
    {
      ...f.request,
      action: "save",
      save: { sidecar: r.sidecar, revision: null },
    },
    f.env,
  );
  await assert.rejects(
    () =>
      analyzeTileset(
        {
          ...f.request,
          action: "save",
          save: { sidecar: r.sidecar, revision: null },
        },
        f.env,
      ),
    /conflict/,
  );
  const file = projectPath(f.root, sidecarKey(f.snapshot.key));
  writeFileSync(file, "broken");
  assert.throws(() => loadSidecar(f.root, f.snapshot.key));
});
test("atomic replacement preserves prior content on failure and detects changes just before rename", (t) => {
  const f = fixture(t),
    key = ".tiled-ai/catalogs/test.json";
  const revision = atomicJson(f.root, key, { v: 1 }, null);
  assert.throws(
    () =>
      atomicJson(f.root, key, { v: 2 }, revision, () => {
        throw new Error("write failure");
      }),
    /write failure/,
  );
  assert.deepEqual(JSON.parse(readFileSync(projectPath(f.root, key), "utf8")), {
    v: 1,
  });
  assert.throws(
    () =>
      atomicJson(f.root, key, { v: 2 }, revision, () =>
        writeFileSync(projectPath(f.root, key), '{"external":true}'),
      ),
    /conflict/,
  );
  const next = atomicJson(
    f.root,
    key,
    { v: 3 },
    contentHash(readFileSync(projectPath(f.root, key))),
  );
  assert.equal(next, contentHash(readFileSync(projectPath(f.root, key))));
});
test("Windows/project paths and subset limits reject traversal and accidental huge runs", (t) => {
  const f = fixture(t);
  for (const path of [
    "../outside",
    "C:/elsewhere/file",
    "a\\b",
    "/absolute",
    "a/../b",
  ])
    assert.throws(() => projectPath(f.root, path));
  assert.deepEqual(parseTileSubset("0-2,5", f.request.ids), [0, 1, 2, 5]);
  assert.throws(() => parseTileSubset("0-9999", f.request.ids));
  assert.throws(() => parseTileSubset("20", f.request.ids));
  assert.ok(analysisDeadline(256, 32) > 8 * 30000);
  assert.throws(() =>
    requireAnalysisRequest({ ...f.request, operation: "generate" }),
  );
});
test("real analysis CLI returns a bounded correlated operation envelope with job-local artifacts", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      new URL("../src/analysis-cli.mjs", import.meta.url).pathname.replace(
        /^\/([A-Z]:)/i,
        "$1",
      ),
    ],
    {
      input: JSON.stringify(f.request),
      encoding: "utf8",
      env: { ...process.env, TILED_AI_TEST_MODE: "1" },
      timeout: 30000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.operation, "analyze_tileset");
  assert.equal(value.requestId, f.request.requestId);
  assert.ok(result.stdout.length < 4096);
  assert.equal(
    value.hash,
    contentHash(readFileSync(projectPath(f.root, value.artifact))),
  );
});

test("actual catalog boundary loads only fresh accepted standalone entries and keeps manual behavior", async (t) => {
  const f = fixture(t),
    r = review(await analyzeTileset(f.request, f.env));
  r.sidecar.entries = r.sidecar.entries.map((e) => {
    assert.ok(e.proposed);
    return acceptEntry(e, e.proposed.values, r.snapshot, r.sourceHash);
  });
  await analyzeTileset(
    {
      ...f.request,
      action: "save",
      save: { sidecar: r.sidecar, revision: null },
    },
    f.env,
  );
  const g = f.snapshot.geometry;
  const set = {
    fileName: join(f.root, "atlas.tsx"),
    imageFileName: join(f.root, "atlas.png"),
    name: f.snapshot.name,
    modified: false,
    isCollection: false,
    imageWidth: g.width,
    imageHeight: g.height,
    tileWidth: g.tileWidth,
    tileHeight: g.tileHeight,
    columnCount: g.columns,
    margin: g.margin,
    tileSpacing: g.spacing,
    wangSets: [],
    tiles: f.snapshot.tiles.map((fact) => ({
      id: fact.tileId,
      className: fact.className,
      frames: fact.frames,
      objectGroup: fact.hasCollisionGeometry ? { objects: [{}] } : null,
      property: (/** @type {string} */ name) =>
        fact.manual[
          /** @type {'name'|'description'|'tags'} */ (name.replace(/^ai_/, ""))
        ],
    })),
  };
  const map = /** @type {TileMap} */ (
    /** @type {unknown} */ ({
      isTileMap: true,
      fileName: join(f.root, "map.tmx"),
      tilesets: [set],
    })
  );
  class Binary {
    constructor(/** @type {string} */ path) {
      this.path = path;
      this.size = statSync(path).size;
    }
    readAll() {
      return new Uint8Array(readFileSync(this.path)).buffer;
    }
    close() {}
  }
  class Text {
    constructor(/** @type {string} */ path) {
      this.path = path;
    }
    readAll() {
      return readFileSync(this.path, "utf8");
    }
    close() {}
  }
  const host = {
    BinaryFile: Binary,
    TextFile: Text,
    File: { exists: existsSync },
    FileInfo: {
      path: dirname,
      canonicalPath: realpathSync,
      relativePath: relative,
      joinPaths: join,
    },
    tiled: { projectFilePath: "", log() {} },
  };
  for (const [key, value] of Object.entries(host)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  let catalog = buildTileCatalog(map);
  assert.ok(catalog.catalog);
  assert.deepEqual(
    catalog.catalog.tilesets[0].tiles.map((t) => t.tileId),
    [0, 1],
  );
  // Explicit manual annotation on a fragment retains its previous generation eligibility.
  f.snapshot.tiles[3].manual.name = "manual_tree_part";
  catalog = buildTileCatalog(map);
  assert.ok(catalog.catalog);
  assert.deepEqual(
    catalog.catalog.tilesets[0].tiles.map((t) => t.tileId),
    [3],
  ); // all sidecars stale after metadata change
  const path = projectPath(f.root, sidecarKey(f.snapshot.key));
  writeFileSync(path, '{"schemaVersion":999}');
  catalog = buildTileCatalog(map);
  assert.equal(catalog.catalog, null);
  assert.equal(catalog.diagnostics[0].code, "invalid_sidecar");
});

test("vision SDK request contains labeled images, fixed instructions, deadline and zero retries", async () => {
  const expected = await fakeVision({
    ids: [0],
    facts: [],
    sheet: Buffer.alloc(0),
    contexts: [],
  });
  let calls = 0;
  const client = new OpenAI({
    apiKey: "offline-test-key",
    maxRetries: 0,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(/** @type {string} */ (init?.body));
      assert.equal(body.model, "configured-image-model");
      assert.equal(body.store, false);
      assert.equal(body.input[0].role, "system");
      assert.ok(
        body.input[1].content.some(
          (/** @type {{type:string}} */ c) => c.type === "input_image",
        ),
      );
      assert.equal(body.text.format.strict, true);
      assert.ok(!("tools" in body));
      return new Response(
        JSON.stringify({
          id: "resp_fake",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "configured-image-model",
          output: [
            {
              id: "msg_fake",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(expected),
                  annotations: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const adapter = visionAdapter(
    { apiKey: "offline-test-key", model: "configured-image-model" },
    client,
  );
  const result = await adapter({
    ids: [0],
    facts: [],
    sheet: Buffer.from("fixture"),
    contexts: [],
  });
  assert.equal(calls, 1);
  assert.equal(result.entries[0].tileId, 0);
});
for (const failure of [
  "refusal",
  "incomplete",
  "missing",
  "bad_ids",
  "timeout",
  "no_vision",
])
  test(`vision ${failure} never produces suggestions`, async () => {
    const client = /** @type {Pick<OpenAI,'responses'>} */ (
      /** @type {unknown} */ ({
        responses: {
          parse: async (
            /** @type {unknown} */ _body,
            /** @type {{maxRetries:number,timeout:number,signal:AbortSignal}} */ options,
          ) => {
            assert.equal(options.maxRetries, 0);
            assert.equal(options.timeout, 30000);
            assert.ok(options.signal instanceof AbortSignal);
            if (failure === "timeout")
              throw new OpenAI.APIConnectionTimeoutError();
            if (failure === "no_vision")
              throw new OpenAI.BadRequestError(
                400,
                { message: "raw secret provider details" },
                "bad",
                new Headers(),
              );
            if (failure === "refusal")
              return {
                status: "completed",
                output: [{ type: "message", content: [{ type: "refusal" }] }],
              };
            return {
              status: failure === "incomplete" ? "incomplete" : "completed",
              output: [],
              output_parsed: failure === "missing" ? null : { entries: [] },
            };
          },
        },
      })
    );
    await assert.rejects(
      () =>
        visionAdapter(
          { apiKey: "offline-test-key", model: "unchanged" },
          client,
        )({ ids: [0], facts: [], sheet: Buffer.alloc(0), contexts: [] }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("raw secret"));
        return true;
      },
    );
  });

test("analysis operation cannot cross map-edit protocol or accept another phase/request", (t) => {
  const f = fixture(t);
  const envelope = {
    schemaVersion: 2,
    operation: "analyze_tileset",
    action: "run",
    requestId: f.request.requestId,
    artifact: "ignored",
    hash: "x",
  };
  const output = { exitCode: 0, stdout: JSON.stringify(envelope), stderr: "" };
  assert.throws(() => parseJobResponse(output, plannerRequest()), /version/);
  for (const change of [
    { operation: "generate" },
    { requestId: "other" },
    { action: "save" },
    { artifact: "../escape.json" },
  ])
    assert.throws(() =>
      parseAnalysisResponse(
        { ...output, stdout: JSON.stringify({ ...envelope, ...change }) },
        f.request,
      ),
    );
});
test("analysis shares job exclusion; longer deadline and cancellation reject late results", () => {
  const first = {},
    next = {};
  acquireJobSlot(first);
  assert.throws(() => requireFreeJobSlot());
  releaseJobSlot({});
  assert.throws(() => requireFreeJobSlot());
  releaseJobSlot(first);
  acquireJobSlot(next);
  releaseJobSlot(first);
  assert.throws(() => requireFreeJobSlot());
  releaseJobSlot(next);
  let now = 0,
    finished = false,
    stopped = 0;
  const controller = new JobController({
    clock: () => now,
    timeoutMs: analysisDeadline(256, 32),
    readCurrentContext: () => "snapshot",
    parseResponse: () => ({ operation: "analyze_tileset" }),
    startRunner: (/** @type {{operation:string}} */ _request) => ({
      finished: () => finished,
      collect: () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
      dispose: () => {
        stopped++;
      },
    }),
  });
  controller.start({ operation: "analyze_tileset" }, "snapshot");
  now = 40000;
  assert.equal(controller.check(), "running");
  controller.cancel();
  finished = true;
  assert.equal(controller.check(), "cancelled");
  assert.equal(controller.result, null);
  assert.equal(stopped, 1);
  controller.clear();
  assert.equal(controller.state, "idle");
});
