import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analysisReviewDialog } from "../src/tiled/analysis-review-dialog.mjs";
import { validateSidecar } from "../src/core/analysis-catalog.mjs";

/** @param {import('node:test').TestContext} t */
function fixture(t) {
  const sidecar = validateSidecar(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/analysis/example.catalog.json", import.meta.url),
        "utf8",
      ),
    ),
    "atlas.tsx",
  );
  sidecar.entries.sort((a, b) => a.tileId - b.tileId);
  for (const e of sidecar.entries) {
    e.accepted = null;
    e.state = "suggested";
  }
  const first = sidecar.entries[0];
  assert.ok(first.proposed);
  const snapshot = {
    key: "atlas.tsx",
    imageKey: "atlas.png",
    name: "fixture",
    geometry: {
      width: 58,
      height: 40,
      tileWidth: 18,
      tileHeight: 12,
      columns: 3,
      margin: 2,
      spacing: 1,
    },
    tiles: sidecar.entries.map((e) => {
      assert.ok(e.proposed);
      return e.proposed.facts;
    }),
  };
  const report = {
    snapshot,
    sourceHash: first.proposed.sourceHash,
    revision: null,
    sidecar,
    thumbnails: sidecar.entries.map((e) => ({
      tileId: e.tileId,
      path: `.tiled-ai/cache/jobs/ui-fixture/tile-${e.tileId}.png`,
      pixelHash: "0".repeat(64),
      empty: false,
    })),
    needsIds: [],
    failures: [],
    provider: "fake",
    model: "fixture",
    batchSize: 32,
    cachedCount: 0,
  };
  class Signal {
    /** @type {(()=>void)[]} */
    callbacks = [];
    connect(/** @type {()=>void} */ fn) {
      this.callbacks.push(fn);
    }
    emit() {
      for (const fn of this.callbacks) fn();
    }
  }
  class Widget {
    constructor(/** @type {string} */ label, /** @type {string} */ text = "") {
      this.label = label;
      this.text = text;
    }
    clicked = new Signal();
    currentIndexChanged = new Signal();
    enabled = true;
    currentIndex = 0;
  }
  class FakeDialog {
    rejected = new Signal();
    /** @type {Widget[]} */
    widgets = [];
    enabled = true;
    add(/** @type {string} */ label, /** @type {string} */ text = "") {
      const w = new Widget(label, text);
      this.widgets.push(w);
      return w;
    }
    addTextEdit(/** @type {string} */ s) {
      return this.add(s);
    }
    addComboBox(/** @type {string} */ s) {
      return this.add(s);
    }
    addHeading(/** @type {string} */ s) {
      return this.add(s);
    }
    addImage(/** @type {string} */ s) {
      return this.add(s);
    }
    addButton(/** @type {string} */ s) {
      return this.add(s);
    }
    addTextInput(/** @type {string} */ s, /** @type {string} */ value) {
      return this.add(s, value);
    }
    clear() {
      this.widgets = [];
    }
    show() {}
    reject() {
      this.rejected.emit();
    }
  }
  const alerts = /** @type {string[]} */ ([]);
  for (const [key, value] of Object.entries({
    Dialog: FakeDialog,
    Image: class {},
    FileInfo: {
      joinPaths: (/** @type {string} */ a, /** @type {string} */ b) =>
        `${a}/${b}`,
    },
    tiled: { alert: (/** @type {string} */ m) => alerts.push(m) },
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  let saves = 0,
    closes = 0;
  const ui = analysisReviewDialog(report, "fixture", {
    save: () => {
      saves++;
    },
    retry() {},
    close: () => {
      closes++;
      ui.close();
    },
  });
  const dialog = /** @type {FakeDialog} */ (/** @type {unknown} */ (ui.dialog));
  const find = (/** @type {string} */ label) => {
    const w = dialog.widgets.find((w) => w.label === label);
    assert.ok(w, `Missing ${label}`);
    return w;
  };
  return {
    ui,
    dialog,
    find,
    report,
    alerts,
    get saves() {
      return saves;
    },
    get closes() {
      return closes;
    },
  };
}
test("thumbnail pages support corrections, acceptance, saving and mutation-free close", (t) => {
  const f = fixture(t);
  assert.equal(
    f.dialog.widgets.filter((w) => w.label.startsWith("Tile ")).length,
    2,
  );
  f.find("Name").text = "reviewed_grass";
  f.find("Accept selected").clicked.emit();
  const entry = f.report.sidecar.entries.find((e) => e.tileId === 0);
  assert.equal(entry?.accepted?.values.suggestedName, "reviewed_grass");
  assert.equal(entry?.accepted?.provenance.fields.suggestedName, "user-edited");
  f.find("Next page").clicked.emit();
  assert.ok(f.find("Tile 2"));
  f.find("Reject selected").clicked.emit();
  assert.equal(
    f.report.sidecar.entries.find((e) => e.tileId === 2)?.state,
    "rejected",
  );
  assert.equal(f.saves, 0);
  const oldSave = f.find("Save Accepted");
  oldSave.clicked.emit();
  assert.equal(f.saves, 1);
  f.find("Close without saving").clicked.emit();
  oldSave.clicked.emit();
  assert.equal(f.saves, 1);
  assert.equal(f.closes, 1);
  assert.deepEqual(f.alerts, []);
});
test("pending review edits can be saved without accepting a tile", (t) => {
  const f = fixture(t);
  f.find("Name").text = "pending_grass";
  f.find("Keep edits pending").clicked.emit();
  f.find("Next page").clicked.emit();
  f.find("Previous page").clicked.emit();
  assert.equal(f.find("Name").text, "pending_grass");
  f.find("Save Accepted").clicked.emit();
  const entry = f.report.sidecar.entries.find((e) => e.tileId === 0);
  assert.equal(entry?.proposed?.values.suggestedName, "pending_grass");
  assert.equal(entry?.proposed?.provenance.fields.suggestedName, "user-edited");
  assert.equal(entry?.accepted, null);
  assert.equal(entry?.state, "suggested");
  assert.equal(f.saves, 1);
  assert.deepEqual(f.alerts, []);
});

test("busy review blocks duplicate saves and group acceptance preserves role restrictions", (t) => {
  const f = fixture(t);
  f.ui.setBusy(true);
  f.find("Save Accepted").clicked.emit();
  assert.equal(f.saves, 0);
  f.ui.setBusy(false);
  f.find("Accept group").clicked.emit();
  assert.ok(f.report.sidecar.entries.every((e) => e.accepted));
  assert.equal(
    f.report.sidecar.entries.find((e) => e.tileId === 2)?.accepted?.values
      .placementRole,
    "terrain_transition",
  );
  assert.equal(
    f.report.sidecar.entries.find((e) => e.tileId === 3)?.accepted?.values
      .placementRole,
    "object_fragment",
  );
  f.ui.close();
  assert.equal(f.saves, 0);
});
