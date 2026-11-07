import { Modal, type App } from "obsidian";
import type { BaseCommentContext } from "../BaseCommentContext";
import type { NativeLocalMarker } from "../../bases/TimelineLocalMarkerBridge";
import type { TimelineMarkerDetail, TimelineMarkerInventory } from "../TimelineMarkerManagementProtocol";
import type { Json } from "../storage/DiscussionStore";
import { isId, isRecord } from "../DiscussionProtocol";
import { localMarkerColorLabel, localMarkerMatchKey, promotedMarkerId } from "../LocalTimelineMarkers";
import { timelineRangeLabel } from "../TimelineRange";

/** Local association only; no plugin settings or shared metadata are written by
 * matching. Creating a shared copy still requires the parent's reviewed save. */
export class TimelineLocalMarkerPicker extends Modal {
	private closed = false;
	private serial = 0;
	private busy = false;
	private source?: NativeLocalMarker;
	private expected?: Json;
	private checked?: TimelineMarkerDetail;
	private selected!: HTMLSelectElement;
	private sourceSelect!: HTMLSelectElement;
	private copyButton!: HTMLButtonElement;
	private checkButton!: HTMLButtonElement;
	private confirmButton!: HTMLButtonElement;
	private details!: HTMLElement;
	private status!: HTMLElement;
	private stop?: () => void;
	constructor(app: App, private context: BaseCommentContext, private catalog: TimelineMarkerInventory,
		private live: () => boolean, private copy: (source: NativeLocalMarker, id: string) => boolean,
		private openShared: (id: string) => Promise<void>, private done: () => void) { super(app); }
	private current = () => !this.closed && this.live() && this.context.current() && this.context.session.online &&
		this.context.session.permission(this.context.entryId)?.read === true &&
		this.context.session.knownDocumentGeneration(this.context.entryId) === this.catalog.generation;
	validate(): void { if (!this.current()) this.close(); else this.controls(); }
	onOpen(): void {
		this.setTitle("Local timeline markers");
		this.contentEl.addClass("relay-timeline-marker-dialog");
		this.contentEl.createEl("p", { text: "Create a reviewed shared copy, or explicitly match a local marker to a shared marker from another device. Local settings stay on this device. Later edits to either marker do not change the other." });
		this.sourceSelect = this.contentEl.createEl("label", { text: "Local marker" }).createEl("select", { attr: { "aria-label": "Local marker" } });
		this.sourceSelect.createEl("option", { text: "Choose a local marker…", attr: { value: "" } });
		this.details = this.contentEl.createDiv();
		this.copyButton = this.button("Prepare shared copy", () => {
			const source = this.source;
			if (!this.current() || !source?.current() || this.copyButton.disabled) return;
			if (this.copy(source, promotedMarkerId(this.catalog.definition_id, this.catalog.generation, source.id))) this.close();
			else this.status.setText("The saved axis is unavailable or changed. Reopen marker management before preparing a shared copy.");
		});
		this.selected = this.contentEl.createEl("label", { text: "Shared marker to match" }).createEl("select", { attr: { "aria-label": "Shared marker to match" } });
		this.selected.createEl("option", { text: "Choose an existing shared marker…", attr: { value: "" } });
		for (const marker of this.catalog.markers) this.selected.createEl("option", { text: marker.content.label + (marker.active ? "" : " · archived") + " · " + marker.id.slice(-8), attr: { value: marker.id } });
		this.selected.onchange = () => { this.checked = undefined; this.renderSource(); this.controls(); };
		this.checkButton = this.button("Check shared marker", () => { void this.check(); });
		this.confirmButton = this.button("Confirm local match", () => { void this.confirm(); });
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.button("Close", () => this.close());
		try {
			const sources = this.context.surface.localMarkers();
			for (const source of sources) this.sourceSelect.createEl("option", { text: source.label + (source.enabled ? "" : " · hidden locally") + " · " + source.id.slice(-8), attr: { value: source.id } });
			this.sourceSelect.onchange = () => { void this.choose(sources.find(item => item.id === this.sourceSelect.value)); };
			if (!sources.length) this.status.setText("No local markers are available from this timeline.");
		} catch (error) { this.error(error); }
		this.stop = this.context.session.onChange(() => this.validate()); this.validate();
	}
	private button(text: string, action: () => void): HTMLButtonElement {
		const button = this.contentEl.createEl("button", { text }); button.onclick = action; return button;
	}
	private association(): string | undefined {
		if (this.expected == null) return;
		if (!isRecord(this.expected) || this.expected.version !== 1 || !isId(this.expected.marker_id) ||
			Object.keys(this.expected).some(key => !["version", "marker_id"].includes(key))) throw new Error("The saved local match needs repair.");
		return this.expected.marker_id;
	}
	private async choose(source?: NativeLocalMarker): Promise<void> {
		if (!this.current() || this.busy) return;
		const serial = ++this.serial; this.source = undefined; this.checked = undefined; this.expected = undefined;
		this.selected.value = ""; this.busy = true; this.renderSource(); this.controls();
		try {
			if (!source?.current()) throw new Error("Choose an unchanged local marker. Reopen this picker after editing settings.");
			const expected = await this.context.session.trackLocal(this.context.session.store.preference(localMarkerMatchKey(this.catalog.definition_id, this.catalog.generation, source.id)));
			if (!this.current() || serial !== this.serial || !source.current()) return;
			this.expected = expected; this.source = source;
			const match = this.association() ?? promotedMarkerId(this.catalog.definition_id, this.catalog.generation, source.id);
			if (this.catalog.markers.some(marker => marker.id === match)) this.selected.value = match;
			this.renderSource(); this.status.setText(this.association() && !this.selected.value ? "The saved match is not in this catalog. Check access or explicitly choose another shared marker." : "Review the local values. Checking a shared marker does not save a match.");
		} catch (error) { this.source = undefined; if (this.current()) this.error(error); }
		finally { this.busy = false; if (this.current()) this.controls(); }
	}
	private renderSource(): void {
		this.details.empty(); const source = this.source; if (!source) return;
		this.details.createEl("h3", { text: "Local marker" });
		this.details.createEl("p", { text: source.label });
		this.details.createEl("p", { text: source.date || (source.start ?? "Missing start") + " → " + (source.end ?? "Missing end") });
		this.details.createEl("p", { text: "Local color: " + localMarkerColorLabel(source.color) + (source.enabled ? "" : " · hidden locally") });
		const existing = this.association() ?? (this.catalog.markers.some(marker => marker.id === promotedMarkerId(this.catalog.definition_id, this.catalog.generation, source.id)) ? promotedMarkerId(this.catalog.definition_id, this.catalog.generation, source.id) : undefined);
		if (existing) this.details.createEl("p", { text: "This local marker already has a shared association. Check it below or explicitly match another shared marker; creating another copy is disabled." });
		if (this.checked) {
			this.details.createEl("h3", { text: "Checked shared marker" });
			const marker = this.checked.marker;
			this.details.createEl("p", { text: marker.content.label + " · revision " + marker.revision + (marker.active ? "" : " · archived") });
			this.details.createEl("p", { text: timelineRangeLabel(marker.content.range, marker.content.kind) });
			this.details.createEl("p", { text: "Shared color: " + marker.content.color });
			this.details.createEl("p", { text: "Confirming replaces any local match for this base. It does not move discussions or change either marker's label, dates or color." });
		}
	}
	private validDetail(detail: TimelineMarkerDetail): boolean {
		return detail.entry_id === this.catalog.entry_id && detail.definition_id === this.catalog.definition_id && detail.generation === this.catalog.generation &&
			detail.registry_revision === this.catalog.registry_revision && detail.marker.id === this.selected.value;
	}
	private async check(): Promise<void> {
		if (!this.current() || !this.source?.current() || this.checkButton.disabled) return;
		this.busy = true; this.checked = undefined; this.controls();
		try {
			const detail = await this.context.session.readTimelineMarkerDetail(this.context.entryId, this.selected.value);
			if (!this.current() || !this.source?.current()) return;
			if (!this.validDetail(detail)) throw new Error("The shared marker catalog changed. Reopen marker management.");
			this.checked = detail; this.renderSource(); this.status.setText("Compare both markers, then confirm this local match.");
		} catch (error) { if (this.current()) this.error(error); }
		finally { this.busy = false; if (this.current()) { this.controls(); this.confirmButton.focus(); } }
	}
	private async confirm(): Promise<void> {
		const source = this.source, checked = this.checked;
		if (!this.current() || !source?.current() || !checked || this.confirmButton.disabled) return;
		this.busy = true; this.controls();
		try {
			const detail = await this.context.session.readTimelineMarkerDetail(this.context.entryId, checked.marker.id);
			const current = () => this.current() && source.current() && this.source === source && this.checked === checked;
			if (!current()) return;
			if (!this.validDetail(detail) || JSON.stringify(detail.marker) !== JSON.stringify(checked.marker)) throw new Error("The shared marker changed after review. Check it again before matching.");
			const saved = await this.context.session.trackLocal(this.context.session.store.comparePreference(localMarkerMatchKey(this.catalog.definition_id, this.catalog.generation, source.id),
				this.expected, { version: 1, marker_id: checked.marker.id }, current));
			if (!current()) return;
			if (!saved) throw new Error("Another window changed this local match. Reopen the picker to review it.");
			await this.openShared(checked.marker.id); this.close();
		} catch (error) { if (this.current()) this.error(error); }
		finally { this.busy = false; if (this.current()) this.controls(); }
	}
	private controls(): void {
		if (!this.sourceSelect) return;
		const source = this.source, available = this.current() && !this.busy && source?.current();
		this.sourceSelect.disabled = this.busy;
		this.selected.disabled = !available;
		this.checkButton.disabled = !available || !this.selected.value;
		this.confirmButton.disabled = !available || !this.checked;
		const existing = source && (this.association() || this.catalog.markers.some(marker => marker.id === promotedMarkerId(this.catalog.definition_id, this.catalog.generation, source.id)));
		this.copyButton.disabled = !available || !!existing || !this.context.session.permission(this.context.entryId)?.edit || !this.context.session.canAnchorBase("timeline_marker");
	}
	private error(error: unknown): void { this.status.setText(error instanceof Error ? error.message : "The local marker could not be checked."); }
	onClose(): void { if (this.closed) return; this.closed = true; this.serial++; this.stop?.(); this.stop = undefined; this.contentEl.empty(); this.done(); }
}
