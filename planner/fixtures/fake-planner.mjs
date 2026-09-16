// Explicit development fixture: no SDK imports and no network access.
import { routeRequest } from "../src/command-router.mjs";
import { runPlannerCli } from "../src/cli-runner.mjs";

const args = process.argv.slice(2);
/** @param {string} key @param {string} fallback */
function option(key, fallback) { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; }
const mode = option("--result", process.env.TILED_AI_FAKE_RESULT || "valid");
if (mode === "watchdog") {
  await runPlannerCli({ timeoutMs: 40, plan: async () => new Promise(() => {}) });
} else {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString("utf8");
  const request = JSON.parse(input);
  const delay = Math.min(60000, Math.max(0, Number(option("--delay-ms", process.env.TILED_AI_FAKE_DELAY_MS || "0")) || 0));
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  if (mode === "hang") await new Promise(() => { setInterval(() => {}, 1000); });
  else if (mode === "malformed") process.stdout.write("{broken\n");
  else if (mode === "multiple") process.stdout.write("{} {}\n");
  else if (mode === "exit") process.exitCode = 1;
  else if (mode === "oversized") process.stdout.write("x".repeat(1024 * 1024 + 1));
  else {
    const response = mode === "timeout" ? { schemaVersion: 1, requestId: request.requestId, error: { code: "TIMEOUT" } }
      : routeRequest(request);
    if (mode === "mismatch") response.requestId = "wrong-request";
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}
