import {
  ANALYSIS_VERSION,
  suggestion,
  relativeKey,
} from "./analysis-protocol.mjs";
import { requireObject, requireValid } from "./edit-protocol.mjs";
import {
  normalizeName,
  normalizeDescription,
  normalizeTags,
  semanticKey,
} from "./tile-metadata.mjs";

/** @typedef {import('./analysis-protocol.mjs').Suggestion} Suggestion */
/** @typedef {import('./analysis-protocol.mjs').Snapshot} Snapshot */
/** @typedef {{provider:string,model:string,version:string,sourceHash:string,configurationHash:string,fields:Record<string,string>}} Provenance */
/** @typedef {{values:Suggestion,facts:import('./analysis-protocol.mjs').TileFacts,sourceHash:string,evidenceHash:string,provenance:Provenance}} Annotation */
/** @typedef {{tileId:number,state:'suggested'|'accepted'|'rejected',accepted:Annotation|null,proposed:Annotation|null}} Entry */
/** @typedef {{schemaVersion:1,tilesetKey:string,analysisVersion:string,entries:Entry[]}} Sidecar */
export const FIELDS = [
  "suggestedName",
  "description",
  "category",
  "tags",
  "placementRole",
  "uncertaintyReason",
];
/** Preserve explicit pending corrections when new model evidence is prepared.
 * Accepted values have their own independent record and are never changed here.
 * @param {Annotation} fresh @param {Annotation|null} old */
export function retainUserFields(fresh, old) {
  if (!old) return fresh;
  const copy = /** @type {Annotation} */ (JSON.parse(JSON.stringify(fresh)));
  for (const field of FIELDS)
    if (old.provenance.fields[field] === "user-edited") {
      Object.assign(copy.values, {
        [field]: old.values[/** @type {keyof Suggestion} */ (field)],
      });
      copy.provenance.fields[field] = "user-edited";
    }
  return copy;
}
/** @param {string} key @returns {Sidecar} */
export function emptySidecar(key) {
  return {
    schemaVersion: 1,
    tilesetKey: relativeKey(key),
    analysisVersion: ANALYSIS_VERSION,
    entries: [],
  };
}
/** @param {unknown} value @param {string} key @returns {Sidecar} */
export function validateSidecar(value, key) {
  requireObject(
    value,
    ["schemaVersion", "tilesetKey", "analysisVersion", "entries"],
    "Sidecar",
  );
  requireValid(
    value.schemaVersion === 1 && value.analysisVersion === ANALYSIS_VERSION,
    "Unsupported tileset sidecar version. Reanalyze using a compatible extension.",
  );
  requireValid(
    value.tilesetKey === relativeKey(key),
    "Sidecar tileset identity mismatch; moved sources require fresh analysis.",
  );
  requireValid(
    Array.isArray(value.entries) && value.entries.length <= 4096,
    "Invalid sidecar entries.",
  );
  const seen = new Set();
  for (const entry of value.entries) {
    requireObject(
      entry,
      ["tileId", "state", "accepted", "proposed"],
      "Sidecar entry",
    );
    requireValid(
      Number.isSafeInteger(entry.tileId) &&
        /** @type {number} */ (entry.tileId) >= 0 &&
        !seen.has(entry.tileId),
      "Invalid/duplicate sidecar tile ID.",
    );
    seen.add(entry.tileId);
    requireValid(
      ["suggested", "accepted", "rejected"].includes(
        /** @type {string} */ (entry.state),
      ),
      "Invalid review state.",
    );
    for (const a of [entry.accepted, entry.proposed])
      if (a !== null) {
        requireObject(
          a,
          ["values", "facts", "sourceHash", "evidenceHash", "provenance"],
          "Annotation",
        );
        requireValid(
          suggestion(a.values).tileId === entry.tileId,
          "Annotation tile ID mismatch.",
        );
        requireObject(
          a.facts,
          [
            "tileId",
            "manual",
            "className",
            "hasCollisionGeometry",
            "frames",
            "animationMember",
            "wang",
          ],
          "Imported tile facts",
        );
        requireValid(
          a.facts.tileId === entry.tileId &&
            typeof a.facts.className === "string" &&
            typeof a.facts.hasCollisionGeometry === "boolean" &&
            typeof a.facts.animationMember === "boolean" &&
            Array.isArray(a.facts.frames) &&
            Array.isArray(a.facts.wang),
          "Invalid imported facts.",
        );
        for (const hash of [a.sourceHash, a.evidenceHash])
          requireValid(
            typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
            "Invalid annotation fingerprint.",
          );
        requireObject(
          a.provenance,
          [
            "provider",
            "model",
            "version",
            "sourceHash",
            "configurationHash",
            "fields",
          ],
          "Provenance",
        );
        requireValid(
          a.provenance.version === ANALYSIS_VERSION &&
            a.provenance.sourceHash === a.sourceHash,
          "Invalid provenance version/source.",
        );
        requireValid(
          typeof a.provenance.configurationHash === "string" &&
            /^[a-f0-9]{64}$/.test(a.provenance.configurationHash),
          "Missing analysis configuration fingerprint.",
        );
        for (const text of [a.provenance.provider, a.provenance.model])
          requireValid(
            typeof text === "string" && text.length > 0 && text.length <= 150,
            "Invalid provider provenance.",
          );
        requireObject(a.provenance.fields, FIELDS, "Field provenance");
        requireValid(
          Object.values(a.provenance.fields).every(
            (v) =>
              typeof v === "string" &&
              [
                "model",
                "deterministic",
                "manual",
                "reviewed",
                "user-edited",
              ].includes(v),
          ),
          "Invalid field provenance.",
        );
      }
    requireValid(
      entry.accepted !== null || entry.proposed !== null,
      "Empty sidecar entry.",
    );
    requireValid(
      entry.state !== "accepted" || entry.accepted !== null,
      "Accepted entry has no accepted annotation.",
    );
  }
  return /** @type {Sidecar} */ (JSON.parse(JSON.stringify(value)));
}
/** Manual presence, including empty text, wins separately for every field.
 * @param {{name?:unknown,description?:unknown,tags?:unknown}} manual @param {Suggestion|null} accepted */
export function mergeManual(manual, accepted) {
  return {
    name:
      manual.name !== undefined
        ? manual.name
        : accepted && accepted.suggestedName !== null
          ? accepted.suggestedName
          : undefined,
    description:
      manual.description !== undefined
        ? manual.description
        : accepted && accepted.description !== null
          ? accepted.description
          : undefined,
    tags:
      manual.tags !== undefined
        ? manual.tags
        : accepted
          ? accepted.tags.join(",")
          : undefined,
  };
}
/** @param {Entry|undefined} entry @param {string} sourceHash */
export function eligibleAnnotation(entry, sourceHash) {
  const a = entry && entry.state !== "rejected" ? entry.accepted : null;
  return a &&
    a.sourceHash === sourceHash &&
    a.values.placementRole === "standalone"
    ? a.values
    : null;
}
/** Reserve manual aliases and all accepted text, including stale corrections.
 * @param {Snapshot} snapshot @param {Sidecar} sidecar @param {Suggestion[]} values */
export function uniqueCandidates(snapshot, sidecar, values) {
  const used = new Map();
  for (const t of snapshot.tiles)
    if (t.manual.name && t.manual.name.trim())
      used.set(semanticKey(t.manual.name), t.tileId);
  for (const e of sidecar.entries) {
    const a = e.accepted || e.proposed;
    if (a && a.values.suggestedName)
      used.set(semanticKey(a.values.suggestedName), e.tileId);
  }
  return values
    .slice()
    .sort((a, b) => a.tileId - b.tileId)
    .map((v) => {
      const copy = suggestion(v);
      if (!copy.suggestedName) return copy;
      const base = copy.suggestedName;
      let name = base,
        n = 0;
      while (
        used.has(semanticKey(name)) &&
        used.get(semanticKey(name)) !== copy.tileId
      ) {
        const suffix = `_variant_${copy.tileId}${n ? `_${n}` : ""}`;
        name = base.slice(0, 80 - suffix.length) + suffix;
        n++;
      }
      copy.suggestedName = name;
      used.set(semanticKey(name), copy.tileId);
      return copy;
    });
}
/** @param {Snapshot} snapshot @param {Sidecar} sidecar */
export function checkAliases(snapshot, sidecar) {
  const used = new Set();
  for (const tile of snapshot.tiles) {
    const entry = sidecar.entries.find((e) => e.tileId === tile.tileId);
    const name =
      tile.manual.name !== undefined
        ? tile.manual.name
        : entry && entry.state !== "rejected" && entry.accepted
          ? entry.accepted.values.suggestedName
          : null;
    if (name === null || name === undefined || name.trim() === "") continue;
    const key = semanticKey(normalizeName(name));
    requireValid(
      !used.has(key),
      `Duplicate semantic alias "${name}". Manual aliases cannot be renamed automatically.`,
    );
    used.add(key);
  }
}
/** @param {Entry} entry @param {Suggestion} edited @param {Snapshot} snapshot @param {string} sourceHash */
export function acceptEntry(entry, edited, snapshot, sourceHash) {
  const base =
    entry.accepted && entry.accepted.sourceHash === sourceHash
      ? entry.accepted
      : entry.proposed;
  requireValid(
    base && base.sourceHash === sourceHash,
    "This entry is stale. Analyze current source images before accepting it.",
  );
  const values = suggestion(edited);
  requireValid(values.tileId === entry.tileId, "Cannot change tile ID.");
  const manual = snapshot.tiles.find((t) => t.tileId === entry.tileId);
  requireValid(manual, "Tile no longer exists.");
  const fields = Object.assign({}, base.provenance.fields);
  for (const field of FIELDS)
    fields[field] =
      JSON.stringify(values[/** @type {keyof Suggestion} */ (field)]) !==
      JSON.stringify(base.values[/** @type {keyof Suggestion} */ (field)])
        ? "user-edited"
        : fields[field] === "user-edited"
          ? "user-edited"
          : "reviewed";
  if (manual.manual.name !== undefined) {
    values.suggestedName = manual.manual.name.trim()
      ? normalizeName(manual.manual.name)
      : null;
    fields.suggestedName = "manual";
  }
  if (manual.manual.description !== undefined) {
    values.description = normalizeDescription(manual.manual.description);
    fields.description = "manual";
  }
  if (manual.manual.tags !== undefined) {
    values.tags = normalizeTags(manual.manual.tags);
    fields.tags = "manual";
  }
  const accepted = Object.assign({}, base, {
    values: suggestion(values),
    provenance: Object.assign({}, base.provenance, { fields }),
  });
  return Object.assign({}, entry, {
    state: /** @type {const} */ ("accepted"),
    accepted,
  });
}
