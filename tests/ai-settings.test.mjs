import test from "node:test";
import assert from "node:assert/strict";
import {
  registerSettingsAction,
  applyAiSettings,
  configuredProvider,
  validateSettings,
} from "../src/tiled/ai-settings.mjs";
import { acquireJobSlot, releaseJobSlot } from "../src/core/job-slot.mjs";

test("settings menu saves outside projects, protects key by default, persists opt-in and cancels safely", (t) => {
  const disk = new Map();
  const actions = new Map();
  const alerts = /** @type {string[]} */ ([]);
  let interact = /** @param {any} dialog */ (dialog) => {};
  let failWrite = false;
  class Signal {
    callbacks = /** @type {(()=>void)[]} */ ([]);
    connect(/** @type {()=>void} */ fn) {
      this.callbacks.push(fn);
    }
    emit() {
      this.callbacks.forEach((fn) => fn());
    }
  }
  class DialogMock {
    widgets = new Map();
    add(/** @type {string} */ label, text = "") {
      const widget = { text, currentIndex: 0, clicked: new Signal() };
      this.widgets.set(label, widget);
      return widget;
    }
    addComboBox(/** @type {string} */ label) {
      return this.add(/** @type {string} */ label);
    }
    addTextInput(/** @type {string} */ label, /** @type {string} */ value) {
      return this.add(label, value);
    }
    addTextEdit(/** @type {string} */ label) {
      return this.add(/** @type {string} */ label);
    }
    addButton(/** @type {string} */ label) {
      return this.add(/** @type {string} */ label);
    }
    exec() {
      interact(this);
    }
    accept() {}
    reject() {}
  }
  const globals = {
    Process: class {
      getEnv(/** @type {string} */ name) {
        return name === "APPDATA" ? "C:/user/config" : "";
      }
    },
    FileInfo: {
      joinPaths: (/** @type {string} */ a, /** @type {string} */ b) =>
        a + "/" + b,
      path: (/** @type {string} */ p) => p.slice(0, p.lastIndexOf("/")),
    },
    File: {
      exists: (/** @type {string} */ p) => disk.has(p),
      makePath: () => true,
    },
    TextFile: class {
      static ReadOnly = 0;
      static WriteOnly = 1;
      text = "";
      constructor(/** @type {string} */ path) {
        this.path = path;
      }
      readAll() {
        return disk.get(this.path);
      }
      write(/** @type {string} */ text) {
        this.text = text;
      }
      commit() {
        if (this.closed) throw new Error("TextFile already closed");
        this.closed = true;
        if (failWrite) throw new Error("Disk unavailable");
        disk.set(this.path, this.text);
      }
      closed = false;
      close() {
        if (this.closed) throw new Error("TextFile already closed");
        this.closed = true;
      }
    },
    Dialog: DialogMock,
    tiled: {
      registerAction: (
        /** @type {string} */ id,
        /** @type {()=>void} */ fn,
      ) => {
        actions.set(id, fn);
        return {};
      },
      extendMenu: () => {},
      alert: (/** @type {string} */ message) => alerts.push(message),
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  registerSettingsAction();
  const open = () => actions.get("TiledAiSettings")();
  const environment = new Map();
  const child = /** @type {Process} */ (
    /** @type {unknown} */ ({
      setEnv: (/** @type {string} */ key, /** @type {string} */ value) =>
        environment.set(key, value),
      getEnv: () => "deterministic",
    })
  );
  interact = (dialog) => {
    assert.equal(dialog.widgets.get("API key").echoMode, 2);
    dialog.widgets.get("Provider").currentIndex = 1;
    dialog.widgets.get("Model ID").text = "vision-model";
    dialog.widgets.get("API key").text = "test-secret";
    dialog.widgets.get("Save").clicked.emit();
  };
  open();
  applyAiSettings(child);
  assert.equal(environment.get("OPENAI_API_KEY"), "test-secret");
  assert.equal(configuredProvider(child), "openai");
  const path = "C:/user/config/tiled-ai/settings.json";
  assert.equal(JSON.parse(disk.get(path)).apiKey, "");
  interact = (dialog) => {
    dialog.widgets.get("Remember API key").currentIndex = 1;
    dialog.widgets.get("Save").clicked.emit();
  };
  open();
  assert.equal(JSON.parse(disk.get(path)).apiKey, "test-secret");
  interact = (dialog) => {
    dialog.widgets.get("Model ID").text = "cancelled";
    dialog.widgets.get("Cancel").clicked.emit();
  };
  open();
  applyAiSettings(child);
  assert.equal(environment.get("OPENAI_MODEL"), "vision-model");
  failWrite = true;
  interact = (dialog) => {
    dialog.widgets.get("Model ID").text = "failed";
    dialog.widgets.get("Save").clicked.emit();
  };
  open();
  applyAiSettings(child);
  assert.equal(environment.get("OPENAI_MODEL"), "vision-model");
  failWrite = false;
  interact = (dialog) => {
    dialog.widgets.get("Remember API key").currentIndex = 0;
    dialog.widgets.get("Save").clicked.emit();
  };
  open();
  assert.equal(JSON.parse(disk.get(path)).apiKey, "");
  const token = {};
  acquireJobSlot(token);
  try {
    open();
    assert.match(alerts[alerts.length - 1], /Finish or close/);
  } finally {
    releaseJobSlot(token);
  }
  assert.ok(alerts.every((message) => !message.includes("test-secret")));
});

test("settings reject unsupported providers and control characters without echoing credentials", () => {
  assert.throws(
    () => validateSettings({ provider: "other", model: "x", apiKey: "secret" }),
    /Invalid AI settings/,
  );
  assert.throws(
    () =>
      validateSettings({
        provider: "openai",
        model: "x",
        apiKey: "secret\nkey",
      }),
    /Invalid AI settings/,
  );
});
