# Tiled AI

A prototype Tiled extension intended to evolve into an AI-assisted map editing
tool. Currently, **Map → AI: Hello** displays the active tile map's dimensions
(in tiles), or asks you to open a tile map. No AI integration is implemented.

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
```

Tests use Node's built-in runner to exercise the pure validation function.
`check` checks syntax in all runtime modules. VS Code checks JavaScript types.
The steps above verify actual Tiled loading, menus, and dialogs separately.

## Architecture

- `src/main.mjs`: startup log and action registration.
- `src/core/validation.mjs`: pure validation without Tiled runtime access.
- `src/tiled/actions.mjs`: Tiled API integration and dialogs.
- `tests/validation.test.mjs`: core validation tests.

Tiled runs the extension in its own JavaScript environment, not Node.js.
Runtime code must not assume `fs`, `path`, `process`, `Buffer`, `fetch`, or
`require` exist. All package dependencies are for development only.

Future edits will go through Tiled's scripting API, including undo/redo, rather
than parsing or modifying TMX/XML. Model output will be a constrained list of
edits such as `{ x, y, tileset, tileId }`: the LLM is an untrusted planner, and
the plugin validates and executes its proposals.

## Planned direction

- **v0.1:** inspect the active layer / selected map region.
- **v0.2:** serialize a region into a small JSON context.
- **v0.3:** accept a constrained list of tile edits.
- **v0.4:** apply edits through `TileLayer.edit()`.
- **v0.5:** communicate with a local AI backend over HTTP.
- **v0.6:** selection-aware generation and preview.

The extension will stay thin. A future local service will handle prompts,
model access, and planning; the extension will inspect maps, validate edits,
apply changes, and present previews. No HTTP client or backend is needed yet.

## License

MIT; see [LICENSE](LICENSE).
