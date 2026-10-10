# Small atlas evaluation fixture

The contact sheet was visually inspected during implementation. These are
synthetic tiles, not evidence of real-world model accuracy. The offline adapter
uses fixed IDs and imported metadata; it does not classify images.

| ID | Visible appearance | Expected review role |
| --- | --- | --- |
| 0 | Green striped interior | standalone (grass candidate) |
| 1 | Blue striped interior | standalone (water candidate) |
| 2 | Diagonal green/blue corner | terrain_transition |
| 3 | Narrow green block with brown base | object_fragment; tree identity is supported by its class |
| 4 | Transparent | empty |
| 5, 6 | Blue striped frames | animation_frame, from imported animation metadata |
| 7 | Partial red roof and gray wall | object_fragment; building identity is supported by its class |
| 8 | Transparent trailing atlas cell | empty when enumerated by Tiled |

Tiled 1.11.2 enumerates all nine cells in this atlas grid despite the saved
`tilecount="8"`. Analysis uses the actual loaded IDs. The last row includes an
unused cell, and the geometry has a 2-pixel margin, 1-pixel spacing and 18×12 tiles.

The image review verified separate ID gutters, clear transparent-cell backgrounds,
and intact crop pixels. Fragment identities remain ambiguous without their class
metadata; this is intentional. Animation membership overrides a default standalone
suggestion. Collision geometry on tile 3 stays a source fact, not a walkability rule.

`example.catalog.json` is a synthetic accepted-sidecar example. It is not installed
under `.tiled-ai/catalogs`, and it does not make the fixture eligible automatically.
Run Analyze Tileset and Save Accepted to exercise actual persistence.

## Accuracy and review-effort worksheet

No live vision request was made. Classification error rates and human review time
are **unmeasured**, separate from passing unit tests and native control probes.
For a real-provider evaluation, record for each ID: proposed role/name, expected
role, correction needed, and time spent reviewing. Start with accepting IDs 0 and
1 and rejecting or retaining descriptive-only roles for the remaining tiles.
Repeat on representative project art before judging usefulness or accuracy.
