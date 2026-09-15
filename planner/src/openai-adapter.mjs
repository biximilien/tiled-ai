import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { MODEL_LIMITS } from "../../src/core/model-limits.mjs";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

/** @typedef {{schema: ReturnType<typeof import('./model-plan.mjs').semanticSchema>, input: ReturnType<typeof import('./model-plan.mjs').buildModelInput>}} ModelInput */
/** Provider-neutral boundary returns unknown semantic data; compiler distrusts it.
 * @typedef {(input: ModelInput) => Promise<unknown>} ModelAdapter */

/** Never include raw SDK errors, response bodies, or headers in diagnostics.
 * @param {unknown} error */
export function safeProviderError(error) {
  if (error instanceof OpenAI.AuthenticationError || error instanceof OpenAI.PermissionDeniedError) return new PlannerError("AUTHENTICATION", "OpenAI authentication or access failed. Check OPENAI_API_KEY and model access.");
  if (error instanceof OpenAI.RateLimitError) return new PlannerError("RATE_LIMIT", "OpenAI rate or usage limit reached. Check your quota before trying again.");
  if (error instanceof OpenAI.APIConnectionTimeoutError || error instanceof OpenAI.APIUserAbortError) return new PlannerError("TIMEOUT", "OpenAI generation timed out or was aborted (30-second limit).");
  if (error instanceof OpenAI.APIConnectionError) return new PlannerError("NETWORK", "Could not reach OpenAI. Check your network connection.");
  return new PlannerError("PROVIDER_FAILURE", "OpenAI could not produce a usable response. Check OPENAI_MODEL and service availability.");
}

/** Inject the SDK client for offline transport tests.
 * @param {{apiKey: string, model: string}} config
 * @param {Pick<OpenAI, 'responses'>} [client]
 * @returns {ModelAdapter} */
export function openaiAdapter(config, client = new OpenAI({ apiKey: config.apiKey,
  baseURL: "https://api.openai.com/v1", maxRetries: MODEL_LIMITS.attempts - 1,
  timeout: MODEL_LIMITS.timeoutMs, logLevel: "off" })) {
  return async ({ schema, input }) => {
    let response;
    try {
      response = await client.responses.parse({ model: config.model, input,
        store: false, text: { format: zodTextFormat(schema, "tile_plan") } },
      { maxRetries: MODEL_LIMITS.attempts - 1, timeout: MODEL_LIMITS.timeoutMs,
        signal: AbortSignal.timeout(MODEL_LIMITS.timeoutMs) });
    } catch (error) { throw safeProviderError(error); }
    if (response.output?.some(item => item.type === "message" && item.content.some(content => content.type === "refusal"))) {
      throw new PlannerError("REFUSAL", "OpenAI declined this request. Try a different tile-generation instruction.");
    }
    if (response.status !== "completed") throw new PlannerError("INCOMPLETE", "OpenAI did not complete the plan. Try a smaller selection or simpler instruction.");
    if (response.output_parsed === null || response.output_parsed === undefined) throw new PlannerError("MISSING_RESULT", "OpenAI returned no parsed tile plan.");
    return response.output_parsed;
  };
}
