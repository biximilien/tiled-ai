# Tiled AI

A prototype Tiled extension intended to evolve into an AI-assisted map editing
tool. Currently, **Map → AI: Hello** displays the active tile map's dimensions
(in tiles), or asks you to open a tile map. **Map → AI: Inspect Selection** logs
a versioned JSON context for the active tile layer's rectangular tile selection.
Inspection is read-only. No AI integration is implemented.

## Requirements

- Tiled 1.8 or newer (for JavaScript modules)
- Node.js 22 or newer, for development tooling only
- Git, Windows, and optionally VS Code

## Setup

Clone this repository, open it in VS Code, and run:

```powershell
npm install
```

The official `@mapeditor/tiled-api` development dependency supplies Tiled API
completion and JavaScript checking through `jsconfig.json`. `@types/node`
supplies types for the Node test runner; Node APIs are not available in Tiled.
There is no build step.

In Tiled, open **Edit → Preferences → Plugins** and use the button that opens
the extensions directory. Verify that location before creating the junction.
The following PowerShell example uses the usual Windows location; replace it
if your installation uses a different one:

```powershell
$extensionsDir = "$env:LOCALAPPDATA\Tiled\extensions"
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
New-Item `
  -ItemType Junction `
  -Path (Join-Path $extensionsDir "tiled-ai") `
  -Target "C:\dev\tiled-ai\src"
```

Replace `C:\dev\tiled-ai\src` with the absolute path to this repository's `src`
folder. Link `src`, so Tiled loads `main.mjs` without loading development files.

To uninstall, verify that the item is the junction you created, then remove
only the link (do not use `-Recurse`):

```powershell
Get-Item -LiteralPath (Join-Path $extensionsDir "tiled-ai") |
  Format-List FullName, LinkType, Target
Remove-Item -LiteralPath (Join-Path $extensionsDir "tiled-ai")
```

Removing the junction leaves the repository intact.

## Development and verification

Edit in VS Code → save → Tiled reloads the extension → test **Map → AI: Hello**.
If a change is not picked up, restart Tiled.

1. Open **View → Views and Toolbars → Console**. Look for `Tiled AI loaded`.
2. Create or open a map, for example 100 by 80 tiles.
3. Choose **Map → AI: Hello** and confirm the dialog says `Map: 100 × 80`.
4. With a tileset active, confirm it says `Open a tile map first.`
5. With no asset open, invoke `tiled.trigger("TiledAiHello")` in the Console
   if the Map menu is disabled, and confirm the same message.

Use `tiled.log()` and the Console for debugging. See the official
[Tiled scripting guide](https://doc.mapeditor.org/en/stable/reference/scripting/)
for extension loading and reloading, and the
[API reference](https://www.mapeditor.org/docs/scripting/) for available APIs.

## Testing

```powershell
npm test
npm run check
npx --yes --package typescript tsc --project jsconfig.json
```

Tests use Node's built-in runner for core validation, selection serialization,
invalid editor states, action registration, and error reporting. Small fake
objects stand in for the Tiled API. `check` checks syntax in all runtime modules.
The final command downloads a temporary TypeScript checker and checks JavaScript
types without emitting files; VS Code also checks these types. No formatter or
lint command is configured.

## Inspect Selection

Select a tile layer and use Tiled's rectangular tile selection tool to select
an area. Choose **Map → AI: Inspect Selection**, then read the JSON in
**View → Views and Toolbars → Console**.

Only one non-empty rectangle is supported. Disjoint selections, selections with
holes, and other regions represented by multiple rectangles are rejected;
the action does not substitute their bounding box. Missing maps and non-tile
layers produce actionable alerts.

Example output for a 3 × 3 selection:

```json
{
  "schemaVersion": 1,
  "map": {
    "width": 100,
    "height": 80,
    "tileWidth": 16,
    "tileHeight": 16,
    "infinite": false
  },
  "layer": { "id": 3, "name": "Ground" },
  "selection": { "x": 12, "y": 8, "width": 3, "height": 3 },
  "cells": [
    [{ "tileset": "terrain", "tileId": 4 }, null, { "tileset": "terrain", "tileId": 9 }],
    [null, { "tileset": "terrain", "tileId": 4 }, null],
    [null, null, null]
  ]
}
```

Rows run from top to bottom and cells from left to right; `cells[0][0]` is at
the selection origin. `null` is an empty cell. Tile IDs are local to the named
tileset, not TMX global IDs. Infinite-map selections retain negative tile
coordinates. Flip/rotation flags are intentionally omitted in schema version 1.
The output includes no file paths, raw map documents, or custom metadata.

### Manual integration test

1. Open the Console and a finite orthogonal map.
2. Select a tile layer with at least two tile types and one empty cell.
3. Select a 3 × 3 tile rectangle, then save the map so it has no modified marker.
4. Invoke **Map → AI: Inspect Selection**.
5. Copy the JSON into a JSON editor/parser and confirm it parses. Compare its
   selection origin, three rows of three cells, local tile IDs, tileset names,
   and map/layer dimensions and identity against the map.
6. Make a disjoint or non-rectangular selection and invoke the action again.
   Confirm it refuses the selection with a clear alert.
7. Try an empty selection, a non-tile layer, and no open map. For the last case,
   use `tiled.trigger("TiledAiInspectSelection")` in the Console if the menu is
   disabled. Each should give a useful alert.
8. Confirm inspection never adds a modified marker to the map.
9. If an infinite map is available, repeat with negative selection coordinates.

Development verification used Tiled 1.11.2 with `@mapeditor/tiled-api` 1.12.0.
The reader passed a command-line smoke check using real Tiled tiles, layers,
and regions. Headless Tiled has no editor selection, so that check supplied a
selection fixture; the live selection, menu, and dialogs require the manual
steps above. No version-specific API substitution was needed. The reader
guards missing `currentLayer` values despite the typings declaring it non-null,
and narrows `Layer` to `TileLayer` after checking `isTileLayer`.

## Architecture

- `src/main.mjs`: startup log and action registration.
- `src/core/validation.mjs`: pure validation without Tiled runtime access.
- `src/tiled/actions.mjs`: Tiled API integration and dialogs.
- `src/tiled/map-reader.mjs`: editor-state validation and read-only selection context.
- `tests/validation.test.mjs`: core validation tests.
- `tests/map-reader.test.mjs`: selection context and action tests using small fixtures.

Tiled runs the extension in its own JavaScript environment, not Node.js.
Runtime code must not assume `fs`, `path`, `process`, `Buffer`, `fetch`, or
`require` exist. All package dependencies are for development only.

Future edits will go through Tiled's scripting API, including undo/redo, rather
than parsing or modifying TMX/XML. Model output will be a constrained list of
edits such as `{ x, y, tileset, tileId }`: the LLM is an untrusted planner, and
the plugin validates and executes its proposals.

## Planned direction

- **v0.1–v0.2 (implemented in iteration 1):** inspect one rectangular selection
  on the active tile layer and serialize it into a small JSON context.
- **v0.3:** accept a constrained list of tile edits.
- **v0.4:** apply edits through `TileLayer.edit()`.
- **v0.5:** communicate with a local AI backend over HTTP.
- **v0.6:** selection-aware generation and preview.

The extension will stay thin. A future local service will handle prompts,
model access, and planning; the extension will inspect maps, validate edits,
apply changes, and present previews. No HTTP client or backend is needed yet.

## License

MIT; see [LICENSE](LICENSE).
