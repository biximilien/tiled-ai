# Tiled AI

A prototype Tiled extension intended to evolve into an AI-assisted map editing
tool. Currently, **Map → AI: Hello** displays the active tile map's dimensions
(in tiles), or asks you to open a tile map. **Map → AI: Inspect Selection** logs
a versioned JSON context for the active tile layer's rectangular tile selection.
Inspection is read-only. No AI integration is implemented.
**Map → AI: Fill Empty Cells (Prototype)** now uses a deterministic planner to
fill selected empty cells with the most common tile in the selection.
**Map → AI: Generate… (Prototype)** sends a supported instruction and selection
to a one-shot local Node planner, then asks before applying its validated edits.

## Requirements

- Tiled 1.8 or newer (for JavaScript modules)
- Node.js 22 or newer, for development tooling and the local Generate planner
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
deterministic planning, complete plan validation, atomic application, invalid
editor states, action registration, and error reporting. Small fake
objects stand in for the Tiled API. `check` checks syntax in all runtime modules.
The final command downloads a temporary TypeScript checker and checks JavaScript
types without emitting files; VS Code also checks these types. CLI integration
tests launch Node and check real stdin/stdout and exit codes. `check` covers
extension, planner, test, and tooling syntax. No formatter or
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
    [
      { "tileset": "terrain", "tileId": 4 },
      null,
      { "tileset": "terrain", "tileId": 9 }
    ],
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
- `src/core/fill-empty-planner.mjs`: deterministic planning using plain context data.
- `src/core/edit-protocol.mjs`: versioned data types, shape checks, and domain errors.
- `src/core/edit-validation.mjs`: whole-plan validation against the inspected context.
- `src/tiled/edit-applier.mjs`: live target checks, tile resolution, and one atomic edit.
- `src/core/planner-protocol.mjs`: shared request/response validation and limits.
- `src/tiled/planner-process.mjs`: direct Node startup, UTF-8 transport, and cleanup.
- `src/tiled/generate-action.mjs`: prompt, snapshot checks, and confirmation.
- `planner/src/cli.mjs`: one-shot Node stdin/stdout entry point.
- `planner/src/command-router.mjs`: explicit instruction routing to the existing planner.
- `tests/validation.test.mjs`: core validation tests.
- `tests/map-reader.test.mjs`: selection context and action tests using small fixtures.
- `tests/edit-validation.test.mjs`: planner outcomes and invalid command rejection.
- `tests/edit-applier.test.mjs`: resolution, mutation ordering, editor guards, and fill action.

Tiled runs the extension in its own JavaScript environment, not Node.js.
Runtime code must not assume `fs`, `path`, `process`, `Buffer`, `fetch`, or
`require` exist. All package dependencies are for development only.

Edits go through Tiled's scripting API, including undo/redo. The planner is an
untrusted producer of plain commands, the validator checks the whole plan,
and the adapter is the authoritative executor. No TMX/XML is parsed or rewritten.

## Fill Empty Cells (Prototype)

On one tile layer, select a non-empty rectangle and choose
**Map → AI: Fill Empty Cells (Prototype)**. This deterministic operation calls
no AI service. It counts each `(tileset name, local tile ID)` pair and fills
only empty cells with the most frequent pair. Existing tiles are never overwritten.
Ties choose the lexicographically smaller tileset name (case-sensitive UTF-16
ordering, independent of locale), then the lower numeric local tile ID.

The Console reports the number of filled cells. All commands use one new
`TileLayerEdit` with one `apply()` call, producing one undo step; press **Ctrl+Z**
to undo the entire fill. A full selection reports no empty cells and creates
no edit. An entirely empty selection reports that no source tile exists.

The planner receives only the inspection JSON. Its output uses this envelope:

```json
{
  "schemaVersion": 1,
  "target": {
    "layerId": 3,
    "selection": { "x": 12, "y": 8, "width": 2, "height": 1 }
  },
  "edits": [
    {
      "operation": "setTile",
      "x": 13,
      "y": 8,
      "tile": { "tileset": "terrain", "tileId": 4 }
    }
  ]
}
```

Every command must pass validation before an edit is created. Missing or
ambiguous tileset names, missing local IDs, out-of-selection coordinates,
duplicate coordinates, occupied cells, and unsupported fields/operations reject
the whole plan. The executor also rejects changed maps, layers, selections or
contents, read-only maps/layers, and locked layers or parent groups. It resolves
every tile before mutation and does not save the map. New fills have no flip or
rotation flags; existing tiles and their flags remain untouched.

### Manual editing test (disposable map)

1. Open **View → Views and Toolbars → Console** and a disposable map.
2. Choose a tile layer containing at least two tile types and empty cells.
3. Select a rectangle where one tile identity is clearly most frequent.
4. Invoke **Map → AI: Fill Empty Cells (Prototype)**.
5. Confirm only empty cells filled, the most common original tile was used,
   and every originally populated cell stayed unchanged.
6. Press **Ctrl+Z once**: the entire generated fill should disappear. Redo once
   and confirm it returns.
7. Select a fully populated rectangle and save the disposable map to clear its
   modified marker. Invoke the action and confirm it reports no empty cells
   without marking the map modified.
8. Select an entirely empty rectangle and confirm the no-source-tile alert.
9. Try a non-rectangular selection and a locked layer; confirm clear rejection.
10. If convenient, repeat on an infinite map with negative tile coordinates.

Automated adapter tests confirm all tiles resolve before `edit()`, exactly one
`apply()` is called for a fill, and invalid/no-op plans create no edit. A Tiled
1.11.2 command-line smoke check also filled six cells using real Tiled tiles and
edits, preserved an existing different tile, rejected a missing-ID plan without
mutation, and handled the subsequent no-op. Editor state was supplied by a
fixture because headless Tiled has no live selection or editor undo stack.
**GUI menu behavior and one-step undo/redo have not been manually confirmed.**

Compatibility: this installed Tiled 1.11.2 JavaScript engine rejects object
spread syntax, so runtime modules copy protocol fields explicitly. Its
`Tileset.tile(id)` throws `Invalid tile ID` for a missing ID, despite the 1.12.0
typings declaring a non-null `Tile` return. The adapter converts this known
exception (and a possible null result) into a precise validation failure;
unexpected exceptions still reach diagnostic logging.

## Generate… (Prototype): local planner process

1. Open a map, select a writable tile layer, and select a rectangle.
2. Choose **Map → AI: Generate… (Prototype)**.
3. Enter one of the supported instructions below.
4. Review **Apply N tile edits?** and confirm to apply, or decline to cancel.
5. Read the result in **View → Views and Toolbars → Console**.

The Console command is `tiled.trigger("TiledAiGenerate")`.

| Instruction        | Result                                                    |
| ------------------ | --------------------------------------------------------- |
| `fill empty cells` | Fill empty cells with the most common selected tile.      |
| `fill empty`       | Exact alias for `fill empty cells`.                       |
| `noop`             | Propose no changes, even for an entirely empty selection. |

Case and surrounding whitespace are normalized. Empty input cancels without
starting a process. Other instructions fail explicitly: this is a deterministic
command router, not an AI model or arbitrary natural-language interpreter.
The fill command keeps the existing tie-breaking rule and never overwrites tiles.

The whole returned plan is validated, all tiles are resolved, and the original
map/layer/selection is checked before confirmation. After confirmation, the
executor repeats validation and stale-state checks immediately before mutation.
Declining applies nothing. Empty plans report **No changes were proposed** with
no confirmation, edit, or modified marker. Accepted edits use the existing single
undo step and never automatically save the map.

### Node discovery and junction installation

The existing junction to `src/` remains sufficient; keep `planner/` next to
`src/` in the repository. No build, extra junction, or server is needed.

The action invokes `node` through Tiled's `Process` API using executable/argument
parameters, without a shell. Node must be on the PATH inherited by Tiled. Check
`node --version` before launching Tiled, or set an explicit executable:

```powershell
$env:TILED_AI_NODE = (Get-Command node).Source
& "C:\Program Files\Tiled\tiled.exe"
```

You can instead assign a full Node executable path, such as
`C:\Program Files\nodejs\node.exe`. Do not include command-line flags or extra
quote characters in the variable value. Set the environment before starting a
fresh Tiled instance; an already running instance retains its previous environment.

Tiled captures `main.mjs`'s `__filename` at startup. On this Windows installation,
`FileInfo.canonicalPath()` does **not** resolve directory junctions. A fixed
Node bootstrap uses `fs.realpathSync()` on that extension file, then Node path
utilities to locate the sibling `planner/src/cli.mjs`. The bootstrap runs via
Node's `--eval` argument; it contains no user-provided code. Instructions and
context travel only through stdin. It resolves the extension's own path and
does not read map files or scan directories. Missing Node or planner files
produce a clear error.

### Protocol and limits

The extension sends exactly one UTF-8 JSON request through stdin and closes the
write channel to signal EOF:

```text
{ schemaVersion: 1, requestId, instruction, context }
```

Success requires exit code 0 and exactly one stdout JSON response:

```text
{ schemaVersion: 1, requestId, plan }
```

`context` and `plan` are the existing versioned contracts. The opaque request ID
is a timestamp plus an increasing counter and must match exactly. It is only
for correlation. The CLI emits no banners or logs on stdout. Failures exit
nonzero and report `[CODE] message` on stderr, distinguishing malformed JSON,
unsupported schema, invalid request/context, unsupported instruction, planner
failure, size limits, and unexpected internal errors. Tiled logs diagnostics and
shows concise failures; valid-looking stdout never overrides a failing exit code.

Shared constants in `src/core/planner-protocol.mjs` enforce:

| Limit                        | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| Instruction                  | 2,000 UTF-16 code units                        |
| Selected area                | 4,096 cells, checked before reading the matrix |
| Serialized request           | 1 MiB of UTF-8                                 |
| Stdout response              | 1 MiB of UTF-8                                 |
| Planner wait                 | 5,000 ms                                       |
| Termination/kill grace waits | 250 ms each                                    |

Requests are size-checked before startup; the CLI also caps stdin bytes before
parsing. Tiled checks stdout size before parsing it. On timeout it attempts
termination, waits briefly, and kills if necessary. Finished process wrappers are
released by Tiled's native destructor rather than calling `Process.close()`
explicitly: Tiled 1.11.2 calls `close()` again during garbage collection and
throws if it was already closed. This avoids spurious errors on later Generate
calls while still stopping timed-out children promptly.
The synchronous call can block the editor briefly (up to the timeout plus
cleanup). Qt buffers child output until it is read, so the response cap is not
a hard bound on Qt's internal buffer memory. Before real model calls, replace
this synchronous prototype with cancellable asynchronous transport and bounded
streaming output. No model, network service, credentials, or SDK is used here.

### Windows verification

Automated tests cover protocol rejection, real CLI input/output, fake process
failure/cleanup paths, declined confirmation, empty plans, and stale state before
and after confirmation. Real Tiled 1.11.2 / Qt 6.8.1 command-line smoke checks on
Windows confirmed PATH discovery, an explicit `TILED_AI_NODE` path containing
spaces, junction resolution, UTF-8 round trips (`forêt 世界 😀`), invalid Node
startup, and a five-second timeout that terminated, killed, waited, and closed a
real hanging child. These were automated headless checks, not manual GUI tests.
This runtime also requires `catch (error)` rather than optional catch bindings.

**Manual GUI confirmation and one-step undo/redo remain unverified.** Use a
disposable map and the existing junction installation:

1. Start a fresh Tiled instance with Node on PATH or `TILED_AI_NODE` configured.
2. Open the Console, select a writable tile layer, and select a rectangle with
   tiles and empty cells.
3. Invoke **AI: Generate… (Prototype)**, enter `fill empty cells`, and confirm.
4. Verify only empty cells filled. Undo once, then redo once.
5. Repeat and decline confirmation; verify nothing changes.
6. Enter `noop`, then blank input; verify neither creates an edit.
7. Enter an unsupported instruction; verify a clear error and no changes.
8. Launch a fresh Tiled with an invalid `TILED_AI_NODE` and verify the startup
   error. Restore the variable and restart Tiled.
9. For failure testing only, back up `planner/src/cli.mjs` outside `src/`, replace
   its contents with `process.stdout.write("not JSON")`, and verify rejection.
10. Replace its contents with `process.stdin.resume(); setInterval(() => {}, 1000)`
    and verify timeout recovery. Restore the exact original CLI afterwards.
11. Invoke the normal action again without reinstalling the extension. If
    convenient, use non-ASCII tileset names and confirm the round trip.

## Planned direction

- **v0.1–v0.2 (implemented in iteration 1):** inspect one rectangular selection
  on the active tile layer and serialize it into a small JSON context.
- **v0.3–v0.4 (implemented in iteration 2):** validate constrained `setTile`
  plans and fill empty cells through `TileLayer.edit()` with one undo step.
- **Iteration 3 (implemented):** local deterministic planner CLI over stdin/stdout,
  with response validation and confirmation.
- **Future backend:** replace deterministic interpretation behind the process boundary.
- **v0.6:** selection-aware generation and preview.

The extension will stay thin. A future local planner will handle prompts,
model access, and planning; the extension will inspect maps, validate edits,
apply changes, and present previews. No HTTP client or long-running service is needed.

## License

MIT; see [LICENSE](LICENSE).
