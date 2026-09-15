import { providerConfig } from "./provider-config.mjs";
import { routeRequest } from "./command-router.mjs";
import { requirePlannerRequest } from "../../src/core/planner-protocol.mjs";

/** SDK/schema dependencies load only in model mode.
 * @param {unknown} request
 * @param {Record<string, string | undefined>} env
 * @param {import('./openai-adapter.mjs').ModelAdapter} [adapter] */
export async function planRequest(request, env, adapter) {
  const config = providerConfig(env);
  requirePlannerRequest(request);
  if (config.provider === "deterministic") return routeRequest(request);
  const { semanticSchema, buildModelInput, compileSemanticPlan } = await import("./model-plan.mjs");
  const schema = semanticSchema(request);
  const input = buildModelInput(request);
  if (!adapter) {
    const { openaiAdapter } = await import("./openai-adapter.mjs");
    adapter = openaiAdapter(/** @type {{apiKey:string, model:string}} */ (config));
  }
  return compileSemanticPlan(await adapter({ schema, input }), request);
}
