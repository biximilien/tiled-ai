import { startJsonProcess } from "./planner-process.mjs";
import { requireAnalysisRequest } from "../core/analysis-protocol.mjs";
import { TILED_SUCCESS_EXIT, JobError } from "../core/job-errors.mjs";
import { requireObject, requireValid } from "../core/edit-protocol.mjs";
import { fileHash, readAnalysisJson, sourceKey } from "./analysis-source.mjs";

const BOOTSTRAP = `import {realpathSync} from 'node:fs';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
process.on('exit',code=>{if(code===0)process.exitCode=${TILED_SUCCESS_EXIT};});
await import(pathToFileURL(resolve(dirname(realpathSync(process.argv[1])),'../planner/src/analysis-cli.mjs')).href);`;
/** @param {import('../core/analysis-protocol.mjs').AnalysisRequest} request @param {string} extensionFile */
export function startAnalysis(request, extensionFile) {
  requireAnalysisRequest(request);
  return startJsonProcess(JSON.stringify(request), [
    "--input-type=module",
    "--eval",
    BOOTSTRAP,
    FileInfo.canonicalPath(extensionFile),
  ]);
}
/** @param {ReturnType<import('../core/job-controller.mjs').Runner['collect']>} output @param {import('../core/analysis-protocol.mjs').AnalysisRequest} request */
export function parseAnalysisResponse(output, request) {
  requireValid(
    output.exitCode === 0 && output.stdout.length <= 4096,
    "Tileset analysis process failed or returned an oversized envelope.",
  );
  const response = JSON.parse(output.stdout);
  requireValid(
    response &&
      response.schemaVersion === 2 &&
      response.operation === "analyze_tileset" &&
      response.action === request.action &&
      response.requestId === request.requestId,
    "Analysis response version, operation or request ID mismatch.",
  );
  if (response.error) {
    requireObject(
      response,
      ["schemaVersion", "operation", "action", "requestId", "error"],
      "Analysis error",
    );
    const messages = /** @type {Record<string,string>} */ ({
      INVALID_SIDECAR: "The tileset sidecar is malformed, belongs to another source, or uses an unsupported version. It was not overwritten. Inspect the project .tiled-ai/catalogs file before retrying.",
      CONFIGURATION:
        "Configure TILED_AI_PROVIDER=openai with OPENAI_MODEL and OPENAI_API_KEY, or use explicit offline test mode.",
      TIMEOUT: "Tileset analysis exceeded its batch-derived deadline.",
      SAVE_CONFLICT:
        "Save conflict: the sidecar changed on disk. Your review remains in memory; reopen analysis before saving.",
      SOURCE_CHANGED:
        "The tileset source changed. Save/reload and restart analysis.",
      VISION_CONFIGURATION:
        "OPENAI_MODEL must accept images and Responses Structured Outputs. No model was substituted.",
    });
    requireValid(
      typeof response.error === "string",
      "Invalid analysis error code.",
    );
    throw new JobError(
      "analysis_failed",
      messages[response.error] ||
        "Tileset analysis/save failed. Check source files, permissions, Node dependencies and provider configuration. In-memory review is retained after a failed save.",
    );
  }
  requireObject(
    response,
    ["schemaVersion", "operation", "action", "requestId", "artifact", "hash"],
    "Analysis response",
  );
  const expected = `.tiled-ai/cache/jobs/${request.jobId}/${request.requestId}.json`;
  requireValid(
    response.artifact === expected,
    "Unexpected analysis artifact path.",
  );
  const path = FileInfo.joinPaths(request.root, expected);
  requireValid(
    sourceKey(request.root, path) === expected &&
      fileHash(path, 1048576) === response.hash,
    "Analysis artifact is outside its job directory or has changed.",
  );
  return readAnalysisJson(path);
}
