export const MODEL_LIMITS = Object.freeze({
  selectedCells: 256, edits: 256, summaryCharacters: 300,
  reasonCharacters: 500, attempts: 1, timeoutMs: 30000,
});

/** Only this non-secret setting is shared with the Tiled host.
 * @param {string | undefined} value */
export function plannerProvider(value) {
  const provider = value === undefined || value === "" ? "deterministic" : value;
  if (provider !== "deterministic" && provider !== "openai") {
    throw new Error("Unsupported TILED_AI_PROVIDER. Use deterministic or openai.");
  }
  return provider;
}
