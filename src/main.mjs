import { registerActions } from "./tiled/actions.mjs";
import { registerPreviewTool } from "./tiled/preview-tool.mjs";
import { registerPreviewFixture } from "./tiled/preview-fixture.mjs";
import { registerAnalysisAction } from "./tiled/analysis-action.mjs";
import { registerSettingsAction } from "./tiled/ai-settings.mjs";

tiled.log("Tiled AI loaded");
registerSettingsAction();
registerActions(__filename);
registerPreviewTool();
registerPreviewFixture(__filename);
registerAnalysisAction(__filename);
