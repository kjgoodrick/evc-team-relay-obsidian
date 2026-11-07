import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import { DiscussionFailure } from "../DiscussionFailure";
import { parseAnchor, parseTimelineAxis, type BaseAnchor, type BaseTimelineMarkerTarget } from "../DiscussionProtocol";
import { parseDiscussionScope } from "../DiscussionScope";
import { timelineMarkerAnchor, type TimelineMarkerCatalog, type TimelineViewMarker } from "../TimelineMarkerProtocol";
import { parseTimelineRange, timelineRangeLabel } from "../TimelineRange";

/** A read-only comparison of immutable discussion coordinates and an explicitly
 * checked catalog. Refresh never moves the discussion or edits shared metadata. */
export class TimelineMarkerComparisonModal extends Modal {
	private captured: BaseAnchor;
	private target: BaseTimelineMarkerTarget;
	private status!: HTMLElement;
	private content!: HTMLElement;
	private refreshButton!: HTMLButtonElement;
	private stop?: () => void;
	private closed = false;
	private busy = false;
	private serial = 0;
	constructor(app: App, private session: DiscussionSession, private scopeId: string,
		private threadId: string, private anchorRevision: number, anchor: BaseAnchor,
		private live: () => boolean, private reveal: (anchor: BaseAnchor, current: () => boolean) => Promise<void>) {
		super(app);
		const saved = parseAnchor(JSON.parse(JSON.stringify(anchor)));
		if (saved.type !== "base" || saved.target.type !== "timeline_marker") throw new Error("Expected a saved marker target.");
		this.captured = saved; this.target = saved.target;
	}
	private current(): boolean {
		const scope = parseDiscussionScope(this.scopeId);
		return !this.closed && this.live() && scope?.viewId === this.captured.view_id &&
			this.session.permission(this.scopeId)?.read === true &&
			!["closed", "authentication_required", "unavailable"].includes(this.session.status) &&
			this.session.knownDocumentGeneration(this.scopeId) === this.captured.generation;
	}
	validate(): void { if (!this.closed && !this.current()) this.close(); }
	onOpen(): void {
		this.setTitle("Compare marker positions");
		this.contentEl.addClass("relay-marker-comparison");
		this.contentEl.createEl("p", { text: "This discussion keeps the marker position captured when its target was saved. Navigation below does not move the discussion." });
		this.refreshButton = this.contentEl.createEl("button", { text: "Refresh comparison" });
		this.refreshButton.onclick = () => { void this.refresh(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.content = this.contentEl.createDiv({ cls: "relay-marker-comparison-columns" });
		this.stop = this.session.onChange(() => this.validate());
		if (!this.current()) { this.close(); return; }
		void this.refresh();
	}
	private details(parent: HTMLElement, title: string, target: BaseTimelineMarkerTarget): void {
		parent.createEl("h3", { text: title });
		parent.createEl("p", { text: "Marker revision " + target.marker_revision });
		parent.createEl("p", { text: target.content.label });
		parent.createEl("p", { text: timelineRangeLabel(target.content.range, target.content.kind) });
		if (target.content.kind === "range") parent.createEl("p", { text: (target.content.range.start_inclusive ? "Includes" : "Excludes") +
			" the start; " + (target.content.range.end_inclusive ? "includes" : "excludes") + " the end." });
		parent.createEl("p", { text: "Color: " + target.content.color });
		const axis = target.axis;
		parent.createEl("p", { text: "Axis: " + axis.start_property.source + "." + axis.start_property.name +
			(axis.end_property ? " → " + axis.end_property.source + "." + axis.end_property.name : "") +
			(axis.time_zone ? " · " + axis.time_zone : "") });
	}
	private navigation(parent: HTMLElement, label: string, anchor: BaseAnchor): void {
		const button = parent.createEl("button", { text: label });
		const serial = this.serial;
		const current = () => this.current() && serial === this.serial && button.isConnected;
		button.onclick = () => {
			if (!current()) return;
			button.disabled = true;
			void this.reveal(anchor, current).catch(() => { if (current()) this.status.setText("This position could not be shown. Refresh or open its original saved view."); })
				.finally(() => { if (current()) button.disabled = false; });
		};
	}
	private render(catalog: TimelineMarkerCatalog, fresh: boolean): void {
		this.content.empty();
		const original = this.content.createEl("section", { attr: { "aria-label": "Captured marker position" } });
		this.details(original, "Captured by this discussion", this.target);
		this.navigation(original, "Show captured position", this.captured);
		const latest = this.content.createEl("section", { attr: { "aria-label": "Checked marker position" } });
		latest.createEl("p", { text: fresh ? "Checked with the server now. Refresh to check for later changes." : "Last saved catalog. Reconnect and refresh to check for changes." });
		const marker = catalog.markers.find(item => item.id === this.target.marker_id);
		if (!marker) {
			latest.createEl("p", { text: fresh ? "This marker is no longer listed in this saved view." : "This marker is absent from the saved catalog. Its current status is unknown." });
			return;
		}
		this.details(latest, "Latest checked marker", marker.target);
		latest.createEl("p", { text: this.differences(marker) });
		if (!marker.active) latest.createEl("p", { text: "This marker is archived. Its captured discussion remains available." });
		else if (!marker.placement.active) latest.createEl("p", { text: "This marker is detached from this saved view." });
		else this.navigation(latest, "Show checked position", timelineMarkerAnchor(catalog, marker));
	}
	private differences(marker: TimelineViewMarker): string {
		const changes: string[] = [], before = this.target, after = marker.target;
		if (before.content.label !== after.content.label) changes.push("label");
		if (before.content.color !== after.content.color) changes.push("color");
		if (before.content.kind !== after.content.kind) changes.push("shape");
		if (JSON.stringify(parseTimelineRange(before.content.range)) !== JSON.stringify(parseTimelineRange(after.content.range))) changes.push("position");
		if (before.axis_definition_id !== after.axis_definition_id || before.axis_definition_revision !== after.axis_definition_revision || JSON.stringify(parseTimelineAxis(before.axis)) !== JSON.stringify(parseTimelineAxis(after.axis))) changes.push("axis");
		return changes.length ? "Changed: " + changes.join(", ") + ". The discussion keeps its captured target." :
			before.marker_revision === after.marker_revision ? "Matches the captured marker revision." : "The marker revision changed; this view's content and axis match the captured target.";
	}
	private async refresh(): Promise<void> {
		if (this.busy || !this.current()) return;
		const serial = ++this.serial; this.busy = true; this.refreshButton.disabled = true;
		this.content.empty(); this.status.setText("Checking the discussion and marker…");
		try {
			let discussion, savedDiscussion = false;
			try { discussion = await this.session.linkedThread(this.scopeId, this.threadId); }
			catch (error) {
				if (!(error instanceof DiscussionFailure) || error.action !== "retry") throw error;
				if (!this.current() || serial !== this.serial) return;
				const thread = await this.session.cachedThread(this.scopeId, this.threadId);
				discussion = thread ? { thread } : undefined; savedDiscussion = true;
			}
			if (!this.current() || serial !== this.serial) return;
			if (!discussion?.thread.anchor || discussion.thread.anchor_revision !== this.anchorRevision ||
				JSON.stringify(discussion.thread.anchor) !== JSON.stringify(this.captured)) {
				this.status.setText("The discussion target changed or is unavailable. Close this comparison and reopen it from the discussion."); return;
			}
			const catalog = await this.session.readTimelineMarkers(this.scopeId);
			if (!this.current() || serial !== this.serial) return;
			if (catalog.entry_id !== parseDiscussionScope(this.scopeId)?.entryId || catalog.definition_id !== this.captured.definition_id || catalog.generation !== this.captured.generation ||
				catalog.view_id !== this.captured.view_id || catalog.registry_revision < Math.max(this.captured.registry_revision, this.session.baseRegistryRevision(this.scopeId))) {
				throw new Error("The saved-view catalog changed.");
			}
			const latestThread = await this.session.cachedThread(this.scopeId, this.threadId);
			if (!this.current() || serial !== this.serial) return;
			if (!latestThread?.anchor || latestThread.anchor_revision !== this.anchorRevision || JSON.stringify(latestThread.anchor) !== JSON.stringify(this.captured)) {
				throw new Error("The discussion target changed.");
			}
			this.render(catalog, this.session.verifiedTargetCatalog(catalog));
			this.status.setText(savedDiscussion ? "Comparison loaded from the saved discussion. Reconnect and refresh to check for later changes." : "Comparison loaded. The discussion target is unchanged.");
		} catch {
			if (this.current() && serial === this.serial) { this.content.empty(); this.status.setText("The comparison could not be verified. Check access or reconnect, then refresh."); }
		} finally {
			this.busy = false;
			if (this.current()) this.refreshButton.disabled = false;
		}
	}
	onClose(): void { this.closed = true; this.serial++; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
