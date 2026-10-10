import { registerActions } from "./tiled/actions.mjs";
import { registerPreviewTool } from "./tiled/preview-tool.mjs";
import { registerPreviewFixture } from "./tiled/preview-fixture.mjs";

tiled.log("Tiled AI loaded");
registerActions(__filename);
registerPreviewTool();
registerPreviewFixture(__filename);
