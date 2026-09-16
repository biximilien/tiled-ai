# Tiled AI

A prototype Tiled extension intended to evolve into an AI-assisted map editing
tool. Currently, **Map → AI: Hello** displays the active tile map's dimensions
(in tiles), or asks you to open a tile map. **Map → AI: Inspect Selection** logs
a versioned JSON context for the active tile layer's rectangular tile selection.
Inspection is read-only. Optional OpenAI generation is available; deterministic
planning remains the default and makes no network requests.
**Map → AI: Fill Empty Cells (Prototype)** now uses a deterministic planner to
fill selected empty cells with the most common tile in the selection.
**Map → AI: Generate… (Prototype)** sends a supported instruction and selection
to a one-shot local Node planner, then asks before applying its validated edits.
Tiles annotated with `ai_name` can now be selected by exact semantic name using
`fill empty with grass` or `fill empty with terrain:grass`.

## Requirements

- Tiled 1.11 or newer (for dialogs and map reload lifecycle signals)
- Node.js 22 or newer, for development tooling and the local Generate planner
- Git, Windows, and optionally VS Code

## Setup

Clone this repository, open it in VS Code, and run:

```powershell
npm install
npm ci --prefix planner
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
- `src/core/tile-metadata.mjs`: annotation normalization and catalog limits.
- `src/core/tile-catalog.mjs`: catalog validation and exact semantic lookup.
- `src/core/utf8.mjs`: shared UTF-8 byte counting for payload limits.
- `src/tiled/tile-catalog-reader.mjs`: explicit tile property reads and diagnostics.
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
`require` exist. Root dependencies are development-only; `planner/` owns the
OpenAI SDK and Zod runtime dependencies, loaded exclusively inside Node.

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

This section describes the default **deterministic** provider. For natural-language
generation, use [OpenAI generation](#openai-generation-iteration-5) below.

1. Open a map, select a writable tile layer, and select a rectangle.
2. Choose **Map → AI: Generate… (Prototype)**.
3. Enter one of the supported instructions below.
4. Continue working while the non-modal status dialog stays open. Click
   **Check Status** to collect the result, or **Cancel** to stop the job.
5. Review **Apply N tile edits?** and confirm to apply, or decline to cancel.
6. Read the result in **View → Views and Toolbars → Console**.

The Console command is `tiled.trigger("TiledAiGenerate")`.

| Instruction        | Result                                                    |
| ------------------ | --------------------------------------------------------- |
| `fill empty cells` | Fill empty cells with the most common selected tile.      |
| `fill empty`       | Exact alias for `fill empty cells`.                       |
| `noop`             | Propose no changes, even for an entirely empty selection. |
| `fill empty with <name>` | Fill empty cells with one uniquely named catalog tile. |
| `fill empty with <tileset>:<name>` | Select a catalog tile by its qualified name. |

Case and surrounding whitespace are normalized. Empty input cancels without
starting a process. Other instructions fail explicitly: this is a deterministic
command router, not an AI model or arbitrary natural-language interpreter.
The fill command keeps the existing tie-breaking rule and never overwrites tiles.

The whole returned plan is validated, all tiles are resolved, and the original
map/layer/captured region is checked before confirmation. Changing the current
selection or active layer does not change the captured target. After confirmation, the
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

The standalone CLI uses exit code 0 and exactly one stdout JSON response:

```text
{ schemaVersion: 1, requestId, plan }
```

`context` and `plan` are the existing versioned contracts. Semantic requests
also include the optional `tileCatalog` field described below; the outer request
schema remains version 1. Other commands omit the catalog, so malformed tile
annotations do not block those commands. The opaque request ID
is a timestamp plus an increasing counter and must match exactly. It is only
for correlation. The CLI emits no banners or logs on stdout. Expected planner
failures return `{schemaVersion: 1, requestId, error: {code}}` with no plan and
exit code 0. Invalid input or unexpected process failures exit nonzero with
bounded diagnostic stderr. The Tiled launcher uses a reserved transport success
code, translated by the adapter, to handle a Qt completion-detection quirk
described under iteration 6. Other nonzero exit codes always reject the result.
Stderr is never a source of executable data or raw user-facing messages.

Shared constants in `src/core/planner-protocol.mjs` and `job-errors.mjs` enforce:

| Limit                        | Value                                          |
| ---------------------------- | ---------------------------------------------- |
| Instruction                  | 2,000 UTF-16 code units                        |
| Selected area                | 4,096 cells, checked before reading the matrix |
| Serialized request           | 1 MiB of UTF-8                                 |
| Stdout response              | 1 MiB of UTF-8                                 |
| Status check wait            | 0 ms                                           |
| Node hard watchdog           | 32,000 ms                                      |
| Overdue cleanup backstop     | 35,000 ms, checked only when Check Status is clicked |
| Stderr retained              | At most 16 KiB                                 |
| Termination/kill grace waits | 250 ms each                                    |

Requests are size-checked before startup; the CLI also caps stdin bytes before
parsing. Tiled checks stdout size before parsing it. On timeout it attempts
termination, waits briefly, and kills if necessary. Finished process wrappers are
released by Tiled's native destructor rather than calling `Process.close()`
explicitly: Tiled 1.11.2 calls `close()` again during garbage collection and
throws if it was already closed. This avoids spurious errors on later Generate
calls while still stopping timed-out children promptly.
Startup returns after launching Node and sending stdin. There is no wait for
planning or the network. Qt buffers child output until it is read, so the
response cap is not a hard bound on Qt's internal buffer memory. Status is
user-driven; there are no timers or polling loops in the extension.
Deterministic mode uses no model, network service, credentials,
or SDK. OpenAI mode uses the separate limits and setup below.

### Windows verification

Automated tests cover protocol rejection, real CLI input/output, fake process
failure/cleanup paths, declined confirmation, empty plans, and stale state before
and after confirmation. Real Tiled 1.11.2 / Qt 6.8.1 command-line smoke checks on
Windows confirmed PATH discovery, an explicit `TILED_AI_NODE` path containing
spaces, junction resolution, UTF-8 round trips (`forêt 世界 😀`), invalid Node
startup, and hanging-child cleanup. Iteration 6 verified immediate startup and
status checks, collection, cancellation and native disposal with the actual
installed Tiled. These were automated headless checks, not manual GUI tests.
This runtime also requires `catch (error)` rather than optional catch bindings.

**Manual GUI confirmation and one-step undo/redo remain unverified.** Use a
disposable map and the existing junction installation:

1. Start a fresh Tiled instance with Node on PATH or `TILED_AI_NODE` configured.
2. Open the Console, select a writable tile layer, and select a rectangle with
   tiles and empty cells.
3. Invoke **AI: Generate… (Prototype)**, enter `fill empty cells`, click
   **Check Status**, and confirm when ready.
4. Verify only empty cells filled. Undo once, then redo once.
5. Repeat and decline confirmation; verify nothing changes.
6. Enter `noop`, then blank input; verify neither creates an edit.
7. Enter an unsupported instruction; verify a clear error and no changes.
8. Launch a fresh Tiled with an invalid `TILED_AI_NODE` and verify the startup
   error. Restore the variable and restart Tiled.
9. Use the iteration-6 fake planner below for malformed output, delays and hangs.
10. Invoke the normal action again without reinstalling the extension. If
    convenient, use non-ASCII tileset names and confirm the round trip.

## Semantic tile catalog (iteration 4)

Annotations give the deterministic planner names such as `grass`, `water`, or
`tree`. They do not enable fuzzy matching, automatic classification, or an AI
model. Edit plans still use the existing `{ tileset, tileId }` references and
pass through the same validator, confirmation, stale-state checks, and executor.

### Annotate individual tiles

Open a tileset in Tiled's tileset editor, select a tile, and use the **Properties**
view's **Add Property** button to add these custom properties. Choose **string**
as the Tiled property type for each one:

| Property | Required? | Example |
| --- | --- | --- |
| `ai_name` | Yes, for catalog inclusion | `grass` |
| `ai_description` | No | `Plain walkable grass` |
| `ai_tags` | No | `ground, outdoor, walkable` |

Set properties on the tile itself, not on the tileset or map. Save the tileset
when you want to retain your annotations. The plugin never changes properties.
It reads explicitly assigned values with `tile.property()`; inherited class
defaults are intentionally excluded. Tiles without `ai_name` are ignored by
semantic lookup but remain usable by the existing frequency-based fill.

Return to your map and choose **Map → AI: Inspect Tile Catalog**. The Console
shows pretty-printed JSON and annotated/ignored counts. Empty catalogs explain
how to add `ai_name`. Inspection never changes the map or tilesets.

```json
{
  "schemaVersion": 1,
  "tilesets": [
    {
      "name": "terrain",
      "tiles": [
        {
          "tileId": 4,
          "name": "grass",
          "description": "Plain walkable grass",
          "tags": ["ground", "outdoor", "walkable"]
        }
      ]
    }
  ]
}
```

The adapter enumerates `Tileset.tiles`, so sparse image-collection IDs work.
Tilesets are ordered by their display name using locale-independent UTF-16
ordering, and tiles by numeric local ID. Only the three annotation properties
are read; source paths, image paths, and arbitrary custom properties are excluded.

### Semantic commands and ambiguity

Select a rectangle on a writable tile layer, invoke **AI: Generate… (Prototype)**,
and enter `fill empty with grass`. Unlike frequency-based fill, this works even
when the selection is entirely empty: the source tile comes from the catalog.
Only empty cells are changed, after confirmation, in one undoable edit.

- Names are trimmed and their display casing is preserved. Lookup uses
  JavaScript Unicode `toLowerCase()` without accent removal or transliteration.
- `fill empty with Terrain:Grass` performs exact case-insensitive qualified lookup.
  The actual tileset name is preserved in the resulting edit reference.
- Duplicate normalized tileset names invalidate the catalog, even if one has
  no annotated tiles. Duplicate semantic names within a tileset also invalidate it.
- The same name across different tilesets is allowed. Unqualified lookup then
  fails with qualified alternatives such as `terrain:grass` and `decor:grass`.
- Names containing `:` are unsupported because it separates the qualifier.
  Tileset names containing `:` also cannot be used in this catalog.
- Unknown names report up to ten deterministically sorted qualified choices.
  There is no similarity scoring, quoting/escaping syntax, alias inference,
  partial matching, or matching against tags/descriptions.

Descriptions are trimmed, omitted when empty, and retain internal whitespace.
Tags are split on commas, trimmed, and stripped of empty segments. Duplicate
tags are compared case-insensitively; the lexicographically smallest original
display variant is kept. Tags are sorted by their lowercase key.

### Limits and invalid annotations

`src/core/tile-metadata.mjs` centralizes these limits. Text lengths count trimmed
JavaScript UTF-16 code units (an emoji may count as two); metadata is never
silently truncated.

| Limit | Value |
| --- | --- |
| `ai_name` | 80 code units |
| `ai_description` | 500 code units |
| Tags per tile | 20 distinct normalized tags |
| Each tag | 50 code units |
| Annotated tiles across the map | 500 |
| Serialized catalog | 512 KiB of UTF-8 |
| Total serialized request, including catalog | Existing 1 MiB limit |

Malformed values produce structured Console diagnostics identifying the tileset,
tile ID, property, code, and message. Errors block semantic generation and return
no usable catalog; size/count violations never send a truncated catalog.
Diagnostics stay local and are not included in planner requests. Fix annotations
and run inspection again. Non-semantic commands continue to work without a catalog.

The catalog is rebuilt for each inspection or semantic request and is not cached
or written to disk. The current prototype sends all annotated tiles from all
referenced tilesets; it has no relevance filtering or incremental updates.
Before a model integration, evaluate a bounded relevance policy for larger
catalogs without silently changing the meaning of names.

### Verify in Tiled

Use a disposable map with a referenced tileset named `terrain`:

1. Annotate three different tiles with `ai_name` values `grass`, `dirt`, and `water`.
   Give grass/dirt `ground, outdoor, walkable` tags and water
   `liquid, outdoor, unwalkable` tags.
2. Return to the map, run **AI: Inspect Tile Catalog**, and check names, local
   IDs, normalized tags, and ignored counts in the Console.
3. Select a rectangle with empty cells, generate `fill empty with grass`, and
   confirm. Check that populated cells remain untouched; undo once, then redo.
4. Repeat with `fill empty with TERRAIN:GRASS`, then with an entirely empty area.
5. Annotate a tile `grass` in another tileset. Verify unqualified lookup is
   ambiguous and `terrain:grass` still succeeds.
6. Add a second `grass` inside `terrain` and verify catalog rejection. Remove
   the duplicate, then give a tile numeric `ai_tags` and check its diagnostic.
7. Confirm `fill empty cells`, `fill empty`, and `noop` still behave as before.
8. Restore valid metadata and try an accented name such as `Forêt`.

Run the existing `npm test`, `npm run check`, and type-check command above for
automated verification. Tests cover normalization, limits, deterministic ordering,
ambiguity, request size, catalog inspection, confirmation paths, and real CLI
round trips. A Tiled 1.11.2 headless smoke check additionally verified explicit
property reads, sparse IDs, Unicode process transport, semantic application to
real tile layers, and ambiguity/duplicate rejection. No new API adaptation was
needed, and the Process destructor cleanup fix remains in place.
**Catalog UI inspection, manual annotation, confirmation, and one-step undo/redo
have not been manually verified for this iteration.**

## OpenAI generation (iteration 5)

The default is `TILED_AI_PROVIDER=deterministic`. It preserves the commands above
and never contacts OpenAI. Set `TILED_AI_PROVIDER=openai` to use natural-language
instructions. Unknown provider values fail; OpenAI mode requires both
`OPENAI_API_KEY` and an explicit `OPENAI_MODEL`. There is no default model.
Choose a model available to your account that supports Responses Structured Outputs.

### Windows configuration

Install the isolated Node planner dependencies:

```powershell
npm ci --prefix planner
```

Close Tiled, then launch it from a PowerShell terminal with the configuration:

```powershell
$env:TILED_AI_PROVIDER = 'openai'
$env:OPENAI_API_KEY = 'YOUR_OPENAI_API_KEY'
$env:OPENAI_MODEL = 'YOUR_RESPONSES_STRUCTURED_OUTPUTS_MODEL'
& 'C:\Program Files\Tiled\tiled.exe'
```

Replace both placeholders locally. Launching a new window while an existing Tiled
process is running may reuse that process's old environment. Fully exit first.
The key is read only by Node from its inherited environment; it is never added
to the Tiled request, process arguments, or diagnostics. `.env.example` is a
reference template; **`.env` files are not automatically loaded** and are ignored
by Git. Return to local mode by setting `$env:TILED_AI_PROVIDER = 'deterministic'`
and restarting Tiled.

### Usage and limits

Annotate usable tiles with `ai_name` (for example `grass` and `water` in a tileset
named `terrain`). Optional `ai_description` and `ai_tags` help describe their
meaning. Check **Map → AI: Inspect Tile Catalog**. Then select a rectangle on a
writable tile layer and choose **Map → AI: Generate… (Prototype)**.
Enter, for example, `Create a small pond surrounded by grass.`

**Generation is non-blocking as of iteration 6.** Use **Check Status** to collect
the result or **Cancel** to stop it. The confirmation dialog opens only after
collection and successful validation.

| Model-mode limit | Value |
| --- | --- |
| Selected cells / proposed edits | 256 / 256 |
| Summary / reason length | 300 / 500 UTF-16 code units |
| API attempts | 1, automatic retries disabled |
| API timeout | 30 seconds; Node hard watchdog at 32 seconds |

The existing 2,000-character instruction and 1 MiB transport limits still apply.
Limits live in `src/core/model-limits.mjs`. Deterministic mode retains its
4,096-cell cap and uses the same non-blocking job workflow.

The model receives the instruction, selection width/height, occupied/empty cell
matrix, and catalog names/descriptions/tags. It receives no map-space origin,
numeric tile IDs, layer details, file paths, or images. This information is sent
to OpenAI in model mode. Stable system rules are separate from untrusted task
and catalog data. The SDK request uses `store: false` and no tools.

The official SDK uses `responses.parse` and `zodTextFormat`, following the
[OpenAI Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
The dynamic, closed schema allows only canonical qualified names such as
`terrain:grass`. Its result is `{status, summary, reason, edits}` with relative
`{dx, dy, tile}` entries. Independent validation checks status invariants, bounds,
occupied cells, duplicates, counts, names and safe arithmetic. A pure compiler
resolves semantic names into the existing numeric plan; the existing validator
runs again in Node and Tiled. No second map-editing path is introduced.

The response preserves schema version and request ID and adds optional
`metadata: {status, summary, reason}` outside the executable plan. A planned
result must have at least one edit and a null reason. A `cannot_plan` result
must have a reason and zero edits; this is also how the model reports that no
changes are needed. Such results display a read-only explanation.

For planned results, review the plain-text summary, edit count, and layer name,
then choose **Apply** or **Cancel**. Apply rechecks the live map and uses one
`TileLayerEdit`; **Ctrl+Z once** should undo the entire operation. Cancel,
refusal, incomplete output, configuration/network/timeout failures, and rejected
plans create no edit. Errors use conservative messages without raw provider
responses, prompts, credentials, or headers. Model prose is never interpreted
as HTML or used to control execution.

### Manual acceptance test (uses the paid API)

1. Configure OpenAI mode above and open a disposable map with `terrain:grass`
   and `terrain:water` in its valid catalog.
2. Select an empty 8 × 8 rectangle on a writable tile layer.
3. Choose **Map → AI: Generate… (Prototype)** and enter
   `Create a small pond surrounded by grass.`
4. Click **Check Status** until ready. Check the summary, count, and layer;
   choose **Cancel**. Verify no map change.
5. Run again and choose **Apply**. Verify only selected empty cells change and
   every placed tile comes from the catalog. Repeat with an occupied cell to
   check it remains untouched.
6. Press **Ctrl+Z once** and verify the entire generation disappears.
7. Run again on the same selection to check repeated actions and process cleanup.
8. Disconnect the network, or restart with invalid model configuration, and
   verify a clear error with no map changes.
9. Restart in deterministic mode and repeat `fill empty with terrain:grass`.

Normal tests are entirely offline: an injected model adapter and a fake HTTP
transport exercise the installed SDK. CLI tests explicitly force deterministic
mode regardless of your environment. No live smoke test is included; the steps
above are the explicit live verification path.

### Implementation and verification

- `planner/src/provider-config.mjs` and `provider-router.mjs`: configuration and routing.
- `planner/src/openai-adapter.mjs`: Responses SDK, deadline, refusal and safe errors.
- `planner/src/model-plan.mjs`: semantic schema, prompt projection, validation and compilation.
- `src/core/model-limits.mjs` and `planner-protocol.mjs`: limits and response metadata validation.
- `src/tiled/planner-process.mjs`, `generate-action.mjs`, and `plan-dialog.mjs`:
  provider-aware limits/catalog collection, transport and plain-text confirmation.
- `planner/test/model.test.mjs` plus existing process/action tests: offline regression coverage.
- `planner/package.json` and lockfile: Node-only SDK/schema dependencies;
  `scripts/check.mjs` skips dependency directories.

Baseline: 94 tests; iteration 5: **134 offline tests passing**. Syntax, type, and
diff whitespace checks also pass. Verification commands: `npm test`, `npm run check`,
`npx --yes --package typescript tsc --project jsconfig.json`, and `git diff --check`.
Installed Tiled 1.11.2 successfully imported the new runtime modules, preserved
literal HTML-like text in a read-only dialog field, and survived repeated
environment-reader wrapper garbage collection. Tiled 1.11 requires an explicit
empty label argument for `Dialog.addTextEdit`, despite newer optional typings.
**Live API generation, interactive Apply/Cancel, and editor undo still need the
manual acceptance test above.** No credentials were accessed or API request made
during implementation. Terrain transitions and visual tile interpretation are
outside this iteration.

## Non-blocking generation (iteration 6)

Only one job may exist at a time. Start **Map → AI: Generate… (Prototype)**,
enter an instruction, and continue working. The status window is non-modal:

- **Check Status / Check Again** checks once and returns immediately if running.
- **Cancel**, or the window's **X**, stops a running job and releases it.
- **Dismiss** clears a failed or stale job; **Discard** clears a ready result.
- A completed, valid result opens the existing confirmation dialog. Nothing
  applies automatically. One Apply remains one undoable `TileLayerEdit`.

There is no automatic status polling or desktop notification. Even if Node has
finished, the dialog remains unchanged until you click Check Status. A second
Generate attempt is rejected until the first job is applied, discarded, cancelled
or dismissed. Jobs are not restored after restarting Tiled or reloading extensions.

### Relevant context and map lifecycle

Jobs capture the original map, tile layer and rectangle. You may change selection,
select another layer, rename the target layer, edit cells outside that rectangle,
pan, save, or switch maps while generation runs. None of these alone makes the
result stale. If another map is active when the result arrives, the dialog asks
you to return to the original map and click **Review Result**; it never switches
maps silently.

Before confirmation and again before Apply, the extension compares a normalized
snapshot of the captured cells, their flip/rotation flags, map orientation and
tile size, and any catalog sent to the planner (including metadata and name-to-ID
resolution). Catalog and tag ordering are normalized. No context padding is sent
in the current protocol. Flags are captured locally without changing the model's
input schema. The executor still checks empty targets, layer locks, read-only
state, valid tiles and the whole numeric plan.

Changing relevant contents or catalog data makes the result stale. Deleting or
replacing the target layer also blocks application. Closing or reloading the
target map cancels/discards the job and cleans up the process. A map lifecycle
event during confirmation also prevents application. No automatic regeneration
occurs; start a new job explicitly when ready.

### Deadlines, errors and Windows compatibility

The API retains its 30-second timeout and zero retries. A referenced Node watchdog
forces exit at 32 seconds even if a provider promise never settles. When possible,
it emits a correlated `TIMEOUT` error response with no plan. After normal output
drains, Node exits explicitly so stray provider handles cannot keep it alive.
If Check Status finds a still-running child older than 35 seconds, Tiled stops it.
That check is a cleanup backstop; the Node watchdog works even when you never
click the dialog. Cancellation waits at most 250 ms after terminate, then kills
and waits at most another 250 ms.

Stdout must contain one protocol response, at most 1 MiB. Stderr retention is
bounded to at most 16 KiB (the character cap is conservative for Unicode).
Raw stderr/provider content is never shown or logged by this path. Fixed messages
explain configuration, network, refusal, timeout, invalid-result and stale-target
failures. Qt's internal pipe buffers cannot be byte-capped through this API; the
size limit is enforced when collecting output, not as a bound on Qt memory.

Two verified Tiled 1.11.2 / Qt 6.8.1 behaviors require small adapter exceptions
to the illustrative handout:

1. `waitForFinished(0)` returns **false if the process already exited** and Qt
   handled that completion. Therefore the fixed launcher changes successful
   OS exit status to **73**. The adapter checks once with `waitForFinished(0)`
   and also inspects the completed exit code; it translates 73 back to logical
   success 0. The standalone CLI still uses 0. No completion marker is mixed
   into stdout, and `atEnd` is never used to infer process completion.
2. Calling `Process.close()` explicitly causes its native destructor to close
   again and throw into the script engine. Logical disposal is idempotent,
   clears the retained wrapper, and stops a live child; the native destructor
   owns the single actual close. This preserves the earlier repeated-action fix.

The adapter follows the [Tiled Process API](https://www.mapeditor.org/docs/scripting/classes/Process.html)
and [Dialog API](https://www.mapeditor.org/docs/scripting/classes/Dialog.html), with
these workarounds verified against installed Tiled and its
[native Process implementation](https://github.com/mapeditor/tiled/blob/v1.11.2/src/tiled/scriptprocess.cpp).
`Process.start()` itself waits for OS process startup internally; it does not wait
for planning. Only cancellation has short bounded waits. Status uses zero-timeout
checks and no script loop.

### Offline delayed/hanging planner

Close Tiled, then launch from PowerShell with explicit test mode:

```powershell
$env:TILED_AI_PROVIDER = 'deterministic'
$env:TILED_AI_TEST_MODE = '1'
$env:TILED_AI_FAKE_RESULT = 'valid'
$env:TILED_AI_FAKE_DELAY_MS = '5000'
& 'C:\Program Files\Tiled\tiled.exe'
```

The fixed launcher selects `planner/fixtures/fake-planner.mjs` only in this test
mode. It never calls a model. Use `fill empty` on a region containing a source
tile, `fill empty with terrain:grass` with a valid catalog, or `noop`.

Available results: `valid`, `malformed`, `multiple`, `exit`, `mismatch`,
`oversized`, `timeout`, `hang`, and `watchdog`. `hang` deliberately ignores the
normal Node deadline so Cancel and the 35-second Tiled backstop can be tested.
`watchdog` uses an unresolved injected planner and a short test-only deadline.
The fixture also accepts `--delay-ms` and `--result` arguments when run directly
with a request piped to stdin. It is excluded from automatic test discovery.

Remove test settings and fully restart Tiled to return to normal planning:

```powershell
Remove-Item Env:TILED_AI_TEST_MODE, Env:TILED_AI_FAKE_RESULT, Env:TILED_AI_FAKE_DELAY_MS -ErrorAction SilentlyContinue
```

### Manual acceptance checklist

1. Start a delayed valid job. Pan/edit elsewhere and click Check Status before
   completion: it should report still running without freezing the editor.
2. Check after completion, cancel confirmation once, then repeat and Apply.
   Verify exactly one Undo restores all generated edits.
3. Repeat while changing selection/current layer and editing outside the captured
   rectangle. Confirm the original region remains eligible for application.
4. Repeat while editing a captured cell, flipping an existing tile, or changing a
   catalog annotation. Confirm a stale message, no generated edits, and Dismiss.
5. Switch to another map before collecting. Verify Review Result asks you to
   return; it must not switch maps or apply to the other map.
6. Run `hang`. Cancel, then start a new job. Repeat using X. Both should stop
   promptly and leave the map untouched.
7. Close/reload the target map during a delayed job; verify it cannot be applied.
   Delete the target layer during another job; collect and confirm it is stale.
8. Try malformed/mismatched output and the timeout fixture. Verify no edits.
9. Remove test mode before an optional live OpenAI check. Check responsiveness,
   collection, declined confirmation, then Apply and one-step Undo.

### Implementation report

- Core: `job-controller.mjs` owns the state machine; `context-fingerprint.mjs`
  normalizes relevant data; `job-response.mjs` validates success/error envelopes;
  `job-errors.mjs` centralizes categories, deadlines and transport limits.
- Tiled: `planner-process.mjs` retains a non-blocking runner;
  `generation-dialog.mjs` owns status controls; `job-lifecycle.mjs` connects
  snapshots, asset signals, review and application. `generate-action.mjs`,
  `map-reader.mjs` and `edit-applier.mjs` now support a captured target without
  depending on the editor's current selection.
- Node: `cli-runner.mjs`, `watchdog.mjs` and the small `cli.mjs` entry point own
  process deadlines and correlated errors. `planner/fixtures/fake-planner.mjs`
  provides offline delay/failure modes.
- Tests cover pure transitions/fingerprints, Tiled adapter lifecycle, stale targets,
  dialog cancellation and real Node pipe/process integration. Existing provider
  schema/prompt/compiler tests remain offline and unchanged.

Baseline: **134 tests**. Current result: **177 offline tests passing**. Commands:
`npm test`, `npm run check`, `npx --yes --package typescript tsc --project jsconfig.json`,
and `git diff --check`.

Installed Tiled 1.11.2 smoke verification: initial check returned unfinished,
later collection produced two valid edits, hanging-child cancellation took about
260 ms, repeated disposal/GC succeeded, and programmatic non-modal dialog closure
did not recursively cancel. A lifecycle smoke check with a real in-memory map
and layer also completed a no-op after a layer rename (editor asset signals were
supplied by a small fixture). No map files were saved or real API calls made.
**Interactive responsiveness, Apply/Cancel and one-step editor Undo remain manual
acceptance checks.** There are no automatic polls, persisted jobs, concurrent jobs,
or previews; preview rendering is deferred to iteration 7.

## Planned direction

- **v0.1–v0.2 (implemented in iteration 1):** inspect one rectangular selection
  on the active tile layer and serialize it into a small JSON context.
- **v0.3–v0.4 (implemented in iteration 2):** validate constrained `setTile`
  plans and fill empty cells through `TileLayer.edit()` with one undo step.
- **Iteration 3 (implemented):** local deterministic planner CLI over stdin/stdout,
  with response validation and confirmation.
- **Iteration 4 (implemented):** semantic tile catalog and exact named-tile fills.
- **Iteration 5 (implemented):** optional OpenAI semantic planning behind the process boundary.
- **Iteration 6 (implemented):** non-blocking single-job workflow with cancellation and stale-result checks.
- **Iteration 7:** preview rendering for ready, validated plans.

The extension stays thin. The local Node planner handles prompts, model access,
and planning; the extension inspects maps, validates edits, and applies changes.
No HTTP client runs inside Tiled and no long-running service is needed.

## License

MIT; see [LICENSE](LICENSE).
