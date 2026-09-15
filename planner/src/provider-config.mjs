import { plannerProvider } from "../../src/core/model-limits.mjs";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

/** Called only inside Node. Never serialize the returned credentials.
 * @param {Record<string, string | undefined>} env */
export function providerConfig(env) {
  let provider;
  try { provider = plannerProvider(env.TILED_AI_PROVIDER); }
  catch { throw new PlannerError("CONFIGURATION", "Unsupported TILED_AI_PROVIDER. Use deterministic or openai."); }
  if (provider === "deterministic") return { provider };
  if (!env.OPENAI_API_KEY?.trim()) throw new PlannerError("CONFIGURATION", "OpenAI mode requires OPENAI_API_KEY in the planner environment.");
  if (!env.OPENAI_MODEL?.trim()) throw new PlannerError("CONFIGURATION", "OpenAI mode requires an explicit OPENAI_MODEL in the planner environment.");
  return { provider, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL.trim() };
}
