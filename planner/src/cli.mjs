import { runPlannerCli } from "./cli-runner.mjs";
await runPlannerCli();
// Stdout has drained. Do not let a provider's leftover handles retain Node.
process.exit(process.exitCode || 0);
