import { writeSync } from "node:fs";
import { analyzeTileset } from "./tileset-analysis.mjs";
import {
  requireAnalysisRequest,
  analysisDeadline,
  ANALYSIS_LIMITS,
} from "../../src/core/analysis-protocol.mjs";
import { atomicJson } from "./analysis-storage.mjs";
import { contentHash } from "../../src/core/content-hash.mjs";
import { PlannerError } from "../../src/core/planner-protocol.mjs";

// Separate operation/version: never routed through the map-edit CLI.
let request;
let timer;
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > ANALYSIS_LIMITS.jsonBytes) throw new Error("Input too large");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requireAnalysisRequest(parsed);
  request = parsed;
  const envelope = {
    schemaVersion: 2,
    operation: "analyze_tileset",
    action: request.action,
    requestId: request.requestId,
  };
  timer = setTimeout(
    () => {
      writeSync(
        1,
        JSON.stringify(Object.assign({}, envelope, { error: "TIMEOUT" })) +
          "\n",
      );
      process.exit(0);
    },
    analysisDeadline(request.ids.length, request.batchSize),
  );
  const result = await analyzeTileset(request, process.env);
  const artifact = `.tiled-ai/cache/jobs/${request.jobId}/${request.requestId}.json`;
  const hash = atomicJson(request.root, artifact, result, undefined);
  writeSync(
    1,
    JSON.stringify(Object.assign({}, envelope, { artifact, hash })) + "\n",
  );
} catch (error) {
  if (request)
    writeSync(
      1,
      JSON.stringify({
        schemaVersion: 2,
        operation: "analyze_tileset",
        action: request.action,
        requestId: request.requestId,
        error: error instanceof PlannerError ? error.code : "ANALYSIS_FAILED",
      }) + "\n",
    );
  else process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
}
// No stray SDK handles may outlive the bounded job.
process.exit(process.exitCode || 0);
