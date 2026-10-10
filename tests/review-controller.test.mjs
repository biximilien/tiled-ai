import test from "node:test";
import assert from "node:assert/strict";
import { ReviewController } from "../src/core/review-controller.mjs";
import { plannerRequest } from "./helpers/planner-fixture.mjs";
import { routeRequest } from "../planner/src/command-router.mjs";
import { buildPreview } from "../src/tiled/preview-builder.mjs";
import { previewHost, PreviewLayer } from "./helpers/preview-host.mjs";

function fixture() {
  const context = plannerRequest().context;
  const plan = routeRequest(plannerRequest()).plan;
  const tile = /** @type {Tile} */ (/** @type {unknown} */ ({ id: 4 }));
  const state = { visible: true, valid: true, renderFails: false, applyFails: false, count: 0, hides: 0, resource: tile,
    rendered: /** @type {import('../src/core/review-controller.mjs').Placement[]|null} */ (null),
    applied: /** @type {import('../src/core/review-controller.mjs').Placement[]|null} */ (null) };
  const review = new ReviewController("review-1", plan, context, {
    validate: value => { if (!state.valid) throw new Error("stale context"); return value.edits.map(p => ({ x: p.x, y: p.y, tile: state.resource })); },
    canShow: () => state.visible,
    render: placements => { if (state.renderFails) throw new Error("render failed"); state.rendered = placements; },
    hide: () => { state.hides++; },
    apply: (canonical, placements) => {
      assert.equal(canonical, review.plan); state.count++; state.applied = placements;
      if (state.applyFails) throw new Error("native application error");
      return placements.length;
    },
  });
  return { state, review, plan, context, tile };
}

test("canonical plan is copied/frozen; renderer and applier share identical placements", () => {
  const f = fixture(); f.plan.edits[0].x = 999;
  assert.equal(f.review.plan.edits[0].x, 13); assert.ok(Object.isFrozen(f.review.plan.edits[0]));
  f.review.refresh(); assert.equal(f.review.apply("wrong"), 0);
  assert.equal(f.review.apply("review-1"), 2); assert.equal(f.review.apply("review-1"), 0);
  assert.equal(f.state.count, 1); assert.equal(f.state.rendered, f.state.applied);
  assert.equal(f.review.previewVisible, false);
});

for (const failure of ["context", "resource", "render"]) test(`${failure} failure prevents live application`, () => {
  const f = fixture(); f.review.refresh();
  if (failure === "context") f.state.valid = false;
  if (failure === "resource") f.state.resource = /** @type {Tile} */ (/** @type {unknown} */ ({ id: 4 }));
  if (failure === "render") { f.state.renderFails = true; f.review.refresh(); }
  assert.equal(f.review.apply("review-1"), 0); assert.equal(f.state.count, 0);
  assert.equal(f.review.state, "stale"); assert.equal(f.review.previewVisible, false);
});

test("hide/resume revalidates; discard and obsolete callbacks never apply", () => {
  const f = fixture(); f.review.refresh(); f.state.visible = false; f.review.refresh();
  assert.equal(f.review.previewVisible, false); assert.equal(f.review.state, "reviewing");
  assert.equal(f.review.apply("review-1"), 0);
  f.state.visible = true; f.review.refresh(); assert.ok(f.review.previewVisible);
  f.review.discard("wrong"); assert.equal(f.review.state, "reviewing");
  f.review.discard("review-1"); f.review.discard("review-1"); f.review.refresh(); f.review.apply("review-1");
  assert.equal(f.state.count, 0); assert.equal(f.review.state, "discarded");
});

test("visibility is checked at Apply even without a lifecycle notification", () => {
  const f = fixture(); f.review.refresh(); f.state.visible = false;
  assert.equal(f.review.apply("review-1"), 0); assert.equal(f.state.count, 0); assert.equal(f.review.previewVisible, false);
});

test("application exceptions are not reported as rollback or retried", () => {
  const f = fixture(); f.review.refresh(); f.state.applyFails = true;
  f.review.apply("review-1"); f.review.apply("review-1");
  assert.equal(f.state.count, 1); assert.equal(f.review.state, "failed");
  assert.match(f.review.message, /may have changed/);
});

test("sparse detached preview preserves absolute and negative coordinates and multiple resources", t => {
  previewHost(t);
  const tileA = /** @type {Tile} */ (/** @type {unknown} */ ({ id: 4 }));
  const tileB = /** @type {Tile} */ (/** @type {unknown} */ ({ id: 8 }));
  const source = /** @type {TileMap} */ (/** @type {unknown} */ ({ width: 24, height: 18, tileWidth: 32, tileHeight: 16, orientation: 0, infinite: true }));
  const preview = buildPreview(source, [{ x: 12, y: 8, tile: tileA }, { x: 14, y: 10, tile: tileB }, { x: -2, y: -4, tile: tileA }]);
  const layer = /** @type {unknown} */ (preview.layers[0]); assert.ok(layer instanceof PreviewLayer);
  assert.equal(layer.tileAt(12, 8), tileA); assert.equal(layer.tileAt(14, 10), tileB);
  assert.equal(layer.tileAt(-2, -4), tileA); assert.equal(layer.tileAt(13, 8), null);
  assert.equal(layer.cells.size, 3); assert.equal(preview.tileWidth, 32); assert.equal(preview.tileHeight, 16);
});
