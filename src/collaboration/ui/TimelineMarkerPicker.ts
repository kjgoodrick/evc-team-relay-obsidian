import { Modal, type App } from "obsidian";
import type { BaseCommentContext } from "../BaseCommentContext";
import { readNativeTimelineAxis, timelineAxisMatches, timelineTargetMatchesProof } from "../NativeTimelineRanges";
import { parseTimelineMarkerCatalog, timelineMarkerAnchor, type TimelineMarkerCatalog, type TimelineViewMarker } from "../TimelineMarkerProtocol";
import type { TimelineAxisContext } from "../TimelineRangeProtocol";
import { timelineRangeLabel } from "../TimelineRange";

/** Explicit marker selection, separate from local plugin settings. Refresh may
 * retain an exact revision, but must never replace a selected target silently. */
export class TimelineMarkerPicker extends Modal {
	private closed = false;
	private busy = false;
	private loading = false;
	private serial = 0;
	private catalog?: TimelineMarkerCatalog;
	private proof?: TimelineAxisContext;
	private choices = new Map<string, TimelineViewMarker>();
	private select!: HTMLSelectElement;
	private details!: HTMLParagraphElement;
	private status!: HTMLParagraphElement;
	private refreshButton!: HTMLButtonElement;
	private writeButton!: HTMLButtonElement;
	private showButton!: HTMLButtonElement;
	constructor(app: App, private context: BaseCommentContext, private active: () => boolean,
		private actions: { write(catalog: TimelineMarkerCatalog, markerId: string, current: () => boolean): Promise<boolean>;
			show(catalog: TimelineMarkerCatalog, markerId: string, current: () => boolean): Promise<boolean> }, private initialId?: string,
		private closedCallback?: () => void) { super(app); }
	private current = () => !this.closed && this.active() && this.context.current() && this.context.session.permission(this.context.entryId)?.read === true;
	onOpen(): void {
		this.setTitle("Shared markers · " + this.context.binding.name); this.contentEl.classList.add("relay-timeline-marker-dialog");
		this.contentEl.createEl("p", { text: "Choose a shared marker in this saved view. Comments keep the selected label and position even if the marker later changes." });
		const label = this.contentEl.createEl("label", { text: "Marker" });
		this.select = label.createEl("select", { attr: { "aria-label": "Marker" } });
		this.details = this.contentEl.createEl("p"); this.details.setAttribute("aria-live", "polite");
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.refreshButton = this.contentEl.createEl("button", { text: "Refresh markers", attr: { type: "button" } });
		this.showButton = this.contentEl.createEl("button", { text: "Show selected position", attr: { type: "button" } });
		this.writeButton = this.contentEl.createEl("button", { text: "Write comment", cls: "mod-cta", attr: { type: "button" } });
		this.contentEl.createEl("button", { text: "Cancel", attr: { type: "button" } }).onclick = () => this.close();
		this.select.onchange = () => { this.status.textContent = ""; this.validate(); };
		this.refreshButton.onclick = () => { void this.refresh(); };
		this.writeButton.onclick = () => { void this.submit("write"); };
		this.showButton.onclick = () => { void this.submit("show"); };
		this.select.focus(); void this.refresh();
	}
	private selected(): TimelineViewMarker | undefined { return this.choices.get(this.select?.value); }
	private canWrite(): boolean { return this.context.session.canAnchorBase("timeline_marker") && this.context.session.permission(this.context.entryId)?.comment === true; }
	validate(): void {
		if (this.closed || !this.select) return;
		if (!this.current()) { this.close(); return; }
		const marker = this.selected(), native = this.context.surface.rangeContext();
		const verified = !!this.proof && !!native && timelineAxisMatches(this.context, this.proof, native);
		const blocked = this.busy || this.loading;
		this.select.disabled = blocked; this.refreshButton.disabled = blocked;
		this.writeButton.disabled = blocked || !marker || !verified || !this.canWrite();
		this.showButton.disabled = blocked || !marker || !verified;
		this.details.textContent = marker ? marker.content.label + " · " + (marker.content.kind === "point" ? "Point" : "Range") + " · " + timelineRangeLabel(marker.content.range) : "";
		if (!blocked && !verified && this.proof) this.status.textContent = "The timeline axis changed. Refresh markers before continuing.";
		else if (!blocked && !this.canWrite()) this.status.textContent = "You can view marker positions. Comment permission and enabled marker comments are required to write a comment.";
	}
	private async refresh(): Promise<void> {
		if (!this.current() || this.busy || this.loading) return;
		const selected = this.selected(), firstId = this.initialId; this.initialId = undefined;
		const serial = ++this.serial; this.loading = true; this.status.textContent = "Verifying shared markers…"; this.validate();
		try {
			const proof = await readNativeTimelineAxis(this.context);
			if (!this.current() || serial !== this.serial) return;
			const value = await this.context.session.readTimelineMarkers(this.context.entryId);
			if (!this.current() || serial !== this.serial) return;
			const catalog = parseTimelineMarkerCatalog(value, this.context.baseEntryId, this.context.binding.viewId);
			if (catalog.definition_id !== proof.definition_id || catalog.generation !== proof.generation || catalog.registry_revision !== proof.registry_revision) throw new Error("The saved view changed. Refresh markers.");
			this.catalog = catalog; this.proof = proof; this.choices.clear();
			for (const marker of catalog.markers) if (marker.active && marker.placement.active && timelineTargetMatchesProof(timelineMarkerAnchor(catalog, marker), proof)) this.choices.set(marker.id, marker);
			this.select.replaceChildren(); this.select.createEl("option", { text: "Choose a marker…", attr: { value: "" } });
			const labels = new Map<string, number>();
			for (const marker of this.choices.values()) labels.set(marker.content.label, (labels.get(marker.content.label) ?? 0) + 1);
			for (const marker of this.choices.values()) this.select.createEl("option", { text: marker.content.label + " · " + timelineRangeLabel(marker.content.range) +
				(labels.get(marker.content.label)! > 1 ? " · " + marker.id.slice(-8) : ""), attr: { value: marker.id } });
			const retained = selected && this.choices.get(selected.id);
			this.select.value = retained && JSON.stringify(retained.target) === JSON.stringify(selected.target) ? retained.id : !selected && firstId && this.choices.has(firstId) ? firstId : "";
			this.status.textContent = selected && !this.select.value ? "The selected marker changed or is unavailable. Choose a current marker; existing drafts are retained." :
				this.choices.size ? "Positions use the latest verified metadata. Offline choices use the last verified version." : "No active shared markers match this saved view’s axis.";
		} catch (error) {
			if (this.current() && serial === this.serial) {
				this.choices.clear(); this.catalog = undefined; this.proof = undefined; this.select.replaceChildren();
				this.status.textContent = error instanceof Error ? error.message : "Markers could not be verified. Reconnect and refresh.";
			}
		} finally { if (serial === this.serial) { this.loading = false; this.validate(); } }
	}
	private async submit(action: "write" | "show"): Promise<void> {
		this.validate(); const marker = this.selected(), catalog = this.catalog, serial = this.serial;
		if (!this.current() || this.busy || this.loading || !marker || !catalog || (action === "write" ? this.writeButton.disabled : this.showButton.disabled)) return;
		this.busy = true; this.validate(); this.status.textContent = action === "write" ? "Saving the comment target…" : "Opening the selected position…";
		const current = () => this.current() && this.serial === serial;
		try {
			if (await this.actions[action](catalog, marker.id, current)) { if (!this.closed) this.close(); return; }
			if (current()) this.status.textContent = "The selection could not be opened. Check the view and your access, then try again.";
		} catch (error) { if (current()) this.status.textContent = error instanceof Error ? error.message : "The marker changed or could not be verified. Refresh before continuing."; }
		finally { this.busy = false; this.validate(); }
	}
	onClose(): void {
		if (this.closed) return; this.closed = true; this.serial++;
		this.choices.clear(); this.catalog = undefined; this.proof = undefined; this.contentEl.empty(); this.closedCallback?.();
	}
}
