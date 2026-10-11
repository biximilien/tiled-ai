import { requireFreeJobSlot } from "../core/job-slot.mjs";

/** @typedef {{provider:string,model:string,apiKey:string}} Settings */
/** @type {Settings|null} */ let configured = null;
let settingsPath = "";
let remembered = false;

/** @param {unknown} value @returns {Settings} */
export function validateSettings(value) {
  const s = /** @type {Settings} */ (value);
  if (
    !s ||
    !["openai", "deterministic"].includes(s.provider) ||
    typeof s.model !== "string" ||
    typeof s.apiKey !== "string" ||
    s.model.length > 200 ||
    s.apiKey.length > 4096 ||
    /[\r\n\0]/.test(s.model + s.apiKey)
  )
    throw new Error(
      "Invalid AI settings. Choose a provider and enter a single-line model ID and API key.",
    );
  return {
    provider: s.provider,
    model: s.model.trim(),
    apiKey: s.apiKey.trim(),
  };
}

/** Apply only to a child environment, never protocol data or command arguments.
 * @param {Process} child */
export function applyAiSettings(child) {
  if (!configured) return;
  child.setEnv("TILED_AI_PROVIDER", configured.provider);
  child.setEnv("OPENAI_MODEL", configured.model);
  // An empty saved key lets an existing environment key remain available.
  if (configured.apiKey) child.setEnv("OPENAI_API_KEY", configured.apiKey);
}

/** @param {Process} child */
export function configuredProvider(child) {
  return configured ? configured.provider : child.getEnv("TILED_AI_PROVIDER");
}

export function registerSettingsAction() {
  const env = new Process();
  const home =
    env.getEnv("APPDATA") ||
    env.getEnv("XDG_CONFIG_HOME") ||
    FileInfo.joinPaths(env.getEnv("HOME"), ".config");
  settingsPath = FileInfo.joinPaths(home, "tiled-ai/settings.json");
  try {
    if (File.exists(settingsPath)) {
      const file = new TextFile(settingsPath, TextFile.ReadOnly);
      try {
        const text = file.readAll();
        if (text.length > 8192) throw new Error("Oversized settings.");
        configured = validateSettings(JSON.parse(text));
        remembered = Boolean(configured.apiKey);
      } finally {
        file.close();
      }
    }
  } catch (error) {
    tiled.alert(
      "Could not load Tiled AI settings. Open Edit > AI: Settings to replace them. Environment settings remain available.",
    );
  }
  const action = tiled.registerAction("TiledAiSettings", () => {
    try {
      requireFreeJobSlot();
      showSettings();
    } catch (error) {
      tiled.alert(
        error instanceof Error ? error.message : "Could not open AI settings.",
      );
    }
  });
  action.text = "AI: Settings…";
  tiled.extendMenu("Edit", [{ action: "TiledAiSettings" }]);
}

function showSettings() {
  const env = new Process();
  const current = configured || {
    provider: env.getEnv("TILED_AI_PROVIDER") || "deterministic",
    model: env.getEnv("OPENAI_MODEL") || "",
    apiKey: "",
  };
  const dialog = new Dialog("Tiled AI Settings");
  const provider = dialog.addComboBox("Provider", [
    "Local deterministic (no API)",
    "OpenAI",
  ]);
  provider.currentIndex = current.provider === "openai" ? 1 : 0;
  const model = dialog.addTextInput("Model ID", current.model);
  const key = dialog.addTextInput("API key", current.apiKey);
  // Native QLineEdit property available in Qt, omitted by Tiled's typings.
  /** @type {Qt.QLineEdit & {echoMode:number}} */ (key).echoMode = 2;
  key.placeholderText = "Enter key, or leave blank to use environment key";
  const storage = dialog.addComboBox("Remember API key", [
    "This Tiled session only",
    "Save locally (unencrypted)",
  ]);
  storage.currentIndex = remembered ? 1 : 0;
  const note = dialog.addTextEdit("");
  note.readOnly = true;
  note.plainText =
    "Applies to generation and tileset analysis. For analysis, choose a model supporting images and structured outputs.\nProvider and model are saved for future launches. Remembered keys are stored unencrypted in your user settings, outside project files.\n" +
    settingsPath;
  dialog.addButton("Save").clicked.connect(() => {
    try {
      requireFreeJobSlot();
      const next = validateSettings({
        provider: provider.currentIndex === 1 ? "openai" : "deterministic",
        model: model.text,
        apiKey: key.text,
      });
      if (
        next.provider === "openai" &&
        (!next.model || !(next.apiKey || env.getEnv("OPENAI_API_KEY")))
      )
        throw new Error("OpenAI requires a model ID and an API key.");
      if (!File.makePath(FileInfo.path(settingsPath)))
        throw new Error("Could not create settings directory.");
      const file = new TextFile(settingsPath, TextFile.WriteOnly);
      try {
        file.write(
          JSON.stringify({
            provider: next.provider,
            model: next.model,
            apiKey: storage.currentIndex === 1 ? next.apiKey : "",
          }),
        );
        file.commit();
        // commit() closes the native TextFile, including its safe-write handle.
      } catch (error) {
        // Cancel an unfinished write. A failed commit may already have closed it.
        try { file.close(); } catch (closeError) { /* Preserve the original error. */ }
        throw error;
      }
      configured = next;
      remembered = storage.currentIndex === 1;
      key.text = "";
      dialog.accept();
    } catch (error) {
      tiled.alert(
        "Could not save AI settings. " +
          (error instanceof Error ? error.message : "Please try again."),
      );
    }
  });
  dialog.addButton("Cancel").clicked.connect(() => dialog.reject());
  dialog.exec();
  key.text = "";
}
