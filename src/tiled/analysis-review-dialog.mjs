import { requireValid } from "../core/edit-protocol.mjs";
import { ROLES, suggestion } from "../core/analysis-protocol.mjs";
import {
  acceptEntry,
  checkAliases,
  FIELDS,
} from "../core/analysis-catalog.mjs";
import { relativeKey } from "../core/analysis-protocol.mjs";
import { normalizeTags } from "../core/tile-metadata.mjs";

/** Paginated native images + one detail editor; model text never becomes HTML.
 * @param {import('../../planner/src/tileset-analysis.mjs').AnalysisReview} review @param {string} root
 * @param {{save:(sidecar:import('../core/analysis-catalog.mjs').Sidecar,revision:string|null)=>void,retry:()=>void,close:()=>void}} handlers */
export function analysisReviewDialog(review, root, handlers) {
  const dialog = new Dialog("AI tileset annotation review");
  let closed = false,
    busy = false,
    page = 0,
    group = "All",
    selected = -1;
  /** @param {import('../core/analysis-catalog.mjs').Entry} e */
  const annotationFor = (e) => {
    const a = e.accepted || e.proposed;
    requireValid(a, "Missing annotation.");
    return a;
  };
  /** @type {(()=>void)|null} */ let readDraft = null;
  /** @type {Map<number,import('../core/analysis-protocol.mjs').Suggestion>} */ const drafts =
    new Map();
  /** @param {number} id */ const entryFor = (id) =>
    review.sidecar.entries.find((e) => e.tileId === id);
  /** @param {import('../core/analysis-catalog.mjs').Entry} entry */
  const valuesFor = (entry) =>
    drafts.get(entry.tileId) ||
    (entry.proposed &&
    Object.values(entry.proposed.provenance.fields).includes("user-edited")
      ? entry.proposed.values
      : annotationFor(entry).values);
  const idsForGroup = () =>
    review.thumbnails
      .map((t) => t.tileId)
      .filter((id) => {
        const e = entryFor(id);
        if (group === "All") return true;
        if (!e) return group === "Needs review";
        const a = annotationFor(e);
        return group === "Needs review"
          ? e.state !== "accepted" ||
              a.sourceHash !== review.sourceHash ||
              Boolean(a.values.uncertaintyReason) ||
              a.values.placementRole === "unknown"
          : valuesFor(e).category === group.slice(10);
      });
  /** @param {()=>void} fn */ const guarded = (fn) => () => {
    if (closed || busy) return;
    try {
      fn();
    } catch (error) {
      tiled.alert(
        error instanceof Error ? error.message : "Could not update review.",
      );
    }
  };
  /** @param {number[]} ids */
  function accept(ids) {
    if (readDraft) readDraft();
    const copy = JSON.parse(JSON.stringify(review.sidecar));
    for (const id of ids) {
      const index = copy.entries.findIndex(
        (/** @type {import('../core/analysis-catalog.mjs').Entry} */ e) =>
          e.tileId === id,
      );
      if (index >= 0)
        copy.entries[index] = acceptEntry(
          copy.entries[index],
          valuesFor(copy.entries[index]),
          review.snapshot,
          review.sourceHash,
        );
    }
    checkAliases(review.snapshot, copy);
    review.sidecar = copy;
    render();
  }
  function render() {
    readDraft = null;
    dialog.clear();
    const groups = ["All", "Needs review"].concat(
      Array.from(
        new Set(review.sidecar.entries.map((e) => valuesFor(e).category)),
      )
        .sort()
        .map((c) => `Category: ${c}`),
    );
    if (!groups.includes(group)) group = "All";
    const status = dialog.addTextEdit("");
    status.readOnly = true;
    status.styleSheet = "max-height: 80px;";
    status.plainText = `${review.snapshot.name}: ${review.thumbnails.length} selected tiles; ${review.failures.length} failed batches.\nAccepted standalone entries can enter generation. Other roles are descriptive only. Changes stay in memory until Save Accepted.\n${review.failures.map((f) => `${f.code}: IDs ${f.ids.join(", ")}`).join("\n")}`;
    const groupBox = dialog.addComboBox("Group", groups);
    groupBox.currentIndex = groups.indexOf(group);
    groupBox.currentIndexChanged.connect(
      guarded(() => {
        if (readDraft) readDraft();
        group = groups[groupBox.currentIndex];
        page = 0;
        selected = -1;
        render();
      }),
    );
    const ids = idsForGroup();
    page = Math.max(0, Math.min(page, Math.ceil(ids.length / 2) - 1));
    const pageIds = ids.slice(page * 2, page * 2 + 2);
    dialog.addHeading(
      `Page ${page + 1} / ${Math.max(1, Math.ceil(ids.length / 2))}`,
      true,
    );
    for (const id of pageIds) {
      const thumb = review.thumbnails.find((t) => t.tileId === id);
      if (!thumb) continue;
      relativeKey(thumb.path);
      if (!/^\.tiled-ai\/cache\/jobs\/[\w-]+\/tile-\d+\.png$/.test(thumb.path))
        throw new Error("Invalid thumbnail artifact path.");
      dialog.addImage(
        `Tile ${id}`,
        new Image(FileInfo.joinPaths(root, thumb.path)),
      );
    }
    const prev = dialog.addButton("Previous page"),
      next = dialog.addButton("Next page");
    prev.enabled = page > 0;
    next.enabled = (page + 1) * 2 < ids.length;
    prev.clicked.connect(
      guarded(() => {
        if (readDraft) readDraft();
        page--;
        selected = -1;
        render();
      }),
    );
    next.clicked.connect(
      guarded(() => {
        if (readDraft) readDraft();
        page++;
        selected = -1;
        render();
      }),
    );
    if (pageIds.length) {
      if (!pageIds.includes(selected)) selected = pageIds[0];
      const choice = dialog.addComboBox(
        "Edit tile",
        pageIds.map(
          (id) =>
            `${id} — ${entryFor(id) ? /** @type {import('../core/analysis-catalog.mjs').Entry} */ (entryFor(id)).state : "manual / awaiting analysis"}`,
        ),
      );
      choice.currentIndex = pageIds.indexOf(selected);
      choice.currentIndexChanged.connect(
        guarded(() => {
          if (readDraft) readDraft();
          selected = pageIds[choice.currentIndex];
          render();
        }),
      );
      const entry = entryFor(selected),
        facts = review.snapshot.tiles.find((t) => t.tileId === selected);
      const info = dialog.addTextEdit("");
      info.readOnly = true;
      info.styleSheet = "max-height: 125px;";
      info.plainText = JSON.stringify(
        {
          facts,
          accepted: entry && entry.accepted ? entry.accepted.values : null,
          proposed: entry && entry.proposed ? entry.proposed.values : null,
          state: entry ? entry.state : "Not analyzed",
        },
        null,
        2,
      );
      if (entry) {
        const value = valuesFor(entry);
        const name = dialog.addTextInput("Name", value.suggestedName || "");
        const description = dialog.addTextInput(
          "Description",
          value.description || "",
        );
        const tags = dialog.addTextInput(
          "Tags (comma separated)",
          value.tags.join(", "),
        );
        const category = dialog.addTextInput("Category", value.category);
        const role = dialog.addComboBox("Placement role", Array.from(ROLES));
        role.currentIndex = ROLES.indexOf(value.placementRole);
        if (facts) {
          name.enabled = facts.manual.name === undefined;
          description.enabled = facts.manual.description === undefined;
          tags.enabled = facts.manual.tags === undefined;
          if (facts.manual.name !== undefined) name.text = facts.manual.name;
          if (facts.manual.description !== undefined)
            description.text = facts.manual.description;
          if (facts.manual.tags !== undefined) tags.text = facts.manual.tags;
        }
        readDraft = () => {
          const base = entry.proposed || annotationFor(entry);
          const edited = suggestion({
            tileId: entry.tileId,
            suggestedName: name.text.trim() || null,
            description: description.text.trim() || null,
            tags: normalizeTags(tags.text),
            category: category.text.trim(),
            placementRole: ROLES[role.currentIndex],
            uncertaintyReason: base.values.uncertaintyReason,
          });
          const fields = Object.assign({}, base.provenance.fields);
          for (const field of FIELDS)
            if (
              JSON.stringify(
                edited[/** @type {keyof typeof edited} */ (field)],
              ) !==
              JSON.stringify(
                base.values[/** @type {keyof typeof edited} */ (field)],
              )
            )
              fields[field] = "user-edited";
          entry.proposed = Object.assign({}, base, {
            values: edited,
            provenance: Object.assign({}, base.provenance, { fields }),
          });
          drafts.set(entry.tileId, edited);
        };
        dialog.addButton("Keep edits pending").clicked.connect(
          guarded(() => {
            if (readDraft) readDraft();
          }),
        );
        dialog
          .addButton("Accept selected")
          .clicked.connect(guarded(() => accept([selected])));
        dialog.addButton("Reject selected").clicked.connect(
          guarded(() => {
            entry.state = "rejected";
            render();
          }),
        );
      }
    }
    dialog
      .addButton("Accept group")
      .clicked.connect(guarded(() => accept(idsForGroup())));
    dialog.addButton("Save Accepted").clicked.connect(
      guarded(() => {
        if (readDraft) readDraft();
        handlers.save(review.sidecar, review.revision);
      }),
    );
    const retry = dialog.addButton("Retry failed / analyze remaining");
    retry.enabled = review.needsIds.length > 0;
    retry.clicked.connect(
      guarded(() => {
        if (readDraft) readDraft();
        handlers.retry();
      }),
    );
    dialog
      .addButton("Close without saving")
      .clicked.connect(guarded(() => handlers.close()));
  }
  dialog.rejected.connect(() => {
    if (!closed) handlers.close();
  });
  render();
  return {
    show() {
      dialog.show();
    },
    close() {
      if (!closed) {
        closed = true;
        dialog.reject();
      }
    },
    /** @param {boolean} value */ setBusy(value) {
      busy = value;
      dialog.enabled = !value;
    },
    /** @param {string} revision */ saved(revision) {
      review.revision = revision;
    },
    /** Exposed for native widget fixture; no map edits. */ dialog,
  };
}
