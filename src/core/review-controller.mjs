import { validateEditPlan } from "./edit-validation.mjs";

/** @typedef {import('./edit-protocol.mjs').EditPlan} Plan */
/** @typedef {{x:number,y:number,tile:Tile}} Placement */
/** Freeze only plain protocol data, never native tile resources. @param {object} value */
function freeze(value) {
  for (const entry of Object.values(value)) if (entry && typeof entry === "object") freeze(entry);
  Object.freeze(value);
}

export class ReviewController {
  /** @param {string} id @param {unknown} plan @param {import('./edit-protocol.mjs').SelectionContext} context
   * @param {{validate:(plan:Plan)=>Placement[],canShow:()=>boolean,render:(placements:Placement[])=>void,
   * hide:()=>void,apply:(plan:Plan,placements:Placement[])=>number}} adapters */
  constructor(id, plan, context, adapters) {
    this.id = id;
    this.plan = validateEditPlan(plan, context);
    if (!this.plan.edits.length) throw new Error("No changes were proposed.");
    freeze(this.plan);
    this.adapters = adapters;
    this.placements = adapters.validate(this.plan).map(p => Object.freeze({ x: p.x, y: p.y, tile: p.tile }));
    Object.freeze(this.placements);
    /** @type {'reviewing'|'stale'|'applying'|'applied'|'discarded'|'failed'} */ this.state = "reviewing";
    this.previewVisible = false;
    this.message = "";
  }
  hide() { this.previewVisible = false; this.adapters.hide(); }
  validate() {
    const resolved = this.adapters.validate(this.plan);
    if (resolved.length !== this.placements.length || resolved.some((p, i) => p.x !== this.placements[i].x || p.y !== this.placements[i].y || p.tile !== this.placements[i].tile)) {
      throw new Error("A tile resource changed since review began. Regenerate the plan.");
    }
  }
  refresh() {
    if (this.state !== "reviewing") return;
    try {
      this.validate();
      if (!this.adapters.canShow()) { this.hide(); return; }
      this.adapters.render(this.placements);
      this.previewVisible = true;
    } catch (error) {
      this.state = "stale";
      this.message = error instanceof Error ? error.message : "The preview is unavailable. No generated edits were applied.";
      this.hide();
    }
  }
  /** @param {string} id */
  apply(id) {
    if (id !== this.id || this.state !== "reviewing" || !this.previewVisible) return 0;
    try {
      if (!this.adapters.canShow()) { this.hide(); return 0; }
      this.validate();
    } catch (error) {
      this.state = "stale"; this.message = error instanceof Error ? error.message : "The plan is stale."; this.hide(); return 0;
    }
    this.state = "applying";
    this.previewVisible = false;
    try {
      const count = this.adapters.apply(this.plan, this.placements);
      this.state = "applied";
      return count;
    } catch (error) {
      this.state = "failed";
      this.message = "Application failed. The map may have changed; inspect it before continuing. No automatic Undo or retry was attempted.";
      return 0;
    } finally { this.hide(); }
  }
  /** @param {string} id */
  discard(id) {
    if (id !== this.id || this.state === "applying" || this.state === "applied" || this.state === "discarded") return;
    this.state = "discarded"; this.hide();
  }
}
