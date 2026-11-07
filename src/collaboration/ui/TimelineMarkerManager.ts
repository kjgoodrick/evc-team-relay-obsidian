import { Modal, type App } from "obsidian";
import { v4 as uuid } from "uuid";
import type { BaseCommentContext } from "../BaseCommentContext";
import { parseAnchor } from "../DiscussionProtocol";
import { readNativeTimelineAxis, sameTimelineAxis, timelineAxisMatches } from "../NativeTimelineRanges";
import { parseTimelineMarkerContent, type TimelineMarkerContent } from "../TimelineMarkerContent";
import type { TimelineMarkerManagementState } from "../TimelineMarkerManagement";
import { parseTimelineMarkerCommand, type TimelineMarkerCommand, type TimelineMarkerDetail } from "../TimelineMarkerManagementProtocol";
import type { TimelineMarkerCatalog, TimelineMarkerPlacement } from "../TimelineMarkerProtocol";
import type { TimelineAxisContext } from "../TimelineRangeProtocol";
import { timelineRangeLabel, type TimelineRange } from "../TimelineRange";
import { TimelineRangeWorkflow } from "./TimelineRangeWorkflow";

type Draft = { id: string; label: string; color: string; kind: "point" | "range"; range?: TimelineRange; placements: TimelineMarkerPlacement[] };

/** Editors manage shared metadata explicitly. Unconfirmed commands remain in
 * the session's durable slot even when this modal closes or permissions change. */
export class TimelineMarkerManager extends Modal {
	private closed = false;
	private transitioning = false;
	private serial = 0;
	private busy = false;
	private loading = false;
	private recoveryRead?: Promise<void>;
	private recoveryAgain = false;
	private recoveryError = false;
	private dirty = false;
	private catalog?: TimelineMarkerCatalog;
	private proof?: TimelineAxisContext;
	private detail?: TimelineMarkerDetail;
	private draft?: Draft;
	private recovery?: TimelineMarkerManagementState;
	private recoveryJson = "";
	private position?: TimelineRangeWorkflow;
	private select!: HTMLSelectElement;
	private form!: HTMLElement;
	private recoveryEl!: HTMLElement;
	private status!: HTMLElement;
	private refreshButton!: HTMLButtonElement;
	private newButton!: HTMLButtonElement;
	private fields: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [];
	private saveButton?: HTMLButtonElement;
	private archiveButton?: HTMLButtonElement;
	private archiveConfirmation?: HTMLInputElement;
	private positionButton?: HTMLButtonElement;
	private validation?: HTMLElement;
	private retryButton?: HTMLButtonElement;
	private acknowledgeButton?: HTMLButtonElement;
	private acknowledgeConfirmation?: HTMLInputElement;
	constructor(app: App, private context: BaseCommentContext, private active: () => boolean, private closedCallback: () => void) { super(app); }
	private current = () => !this.closed && this.active() && this.context.current() && this.context.session.permission(this.context.entryId)?.read === true;
	private canEdit = () => this.current() && this.context.session.online && this.context.session.permission(this.context.entryId)?.edit === true;
	private canSave = () => this.canEdit() && this.context.session.canAnchorBase("timeline_marker");
	private axisCurrent(): boolean {
		const native = this.context.surface.rangeContext(); return !!native && !!this.proof && timelineAxisMatches(this.context, this.proof, native);
	}
	onOpen(): void {
		if (!this.current()) { this.close(); return; }
		this.setTitle("Manage shared markers · " + this.context.binding.name); this.contentEl.classList.add("relay-timeline-marker-dialog");
		this.contentEl.createEl("p", { text: "Marker edits affect every selected view of this base. Existing discussions keep their original label and position. Changes require an online editor." });
		this.recoveryEl = this.contentEl.createDiv(); this.recoveryJson = "";
		const label = this.contentEl.createEl("label", { text: "Shared marker" });
		this.select = label.createEl("select", { attr: { "aria-label": "Shared marker" } });
		this.select.onchange = () => { if (!this.dirty && !this.busy && !this.recovery) void this.load(this.select.value); };
		this.refreshButton = this.button(this.contentEl, "Refresh marker list", () => { void this.refresh(); });
		this.newButton = this.button(this.contentEl, "New shared marker", () => this.newDraft());
		this.form = this.contentEl.createDiv(); this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.button(this.contentEl, "Close", () => this.close());
		this.renderChoices(); this.renderForm(); this.renderRecovery(); this.updateControls();
		if (!this.catalog && !this.draft) void this.refresh(); else this.validate();
	}
	private button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { text, attr: { type: "button" } }); button.onclick = action; return button;
	}
	private checkRecovery(): Promise<void> {
		if (!this.current()) return Promise.resolve();
		if (this.recoveryRead) { this.recoveryAgain = true; return this.recoveryRead; }
		const read = (async () => {
			do {
				this.recoveryAgain = false;
				try {
					const state = await this.context.session.markerManagement.state(this.context.entryId);
					if (!this.current()) return;
					this.recovery = state; this.recoveryError = false;
					if (!this.position) this.renderRecovery();
				} catch (error) { this.recoveryError = true; if (this.current() && !this.position) this.status.textContent = this.error(error); }
			} while (this.current() && this.recoveryAgain);
		})().finally(() => { if (this.recoveryRead === read) this.recoveryRead = undefined; if (this.current() && !this.position) this.updateControls(); });
		this.recoveryRead = read; return read;
	}
	private renderRecovery(): void {
		const state = this.recovery, json = JSON.stringify(state ?? null); if (this.recoveryJson === json) return;
		this.recoveryJson = json; this.recoveryEl.replaceChildren(); this.retryButton = undefined; this.acknowledgeButton = undefined; this.acknowledgeConfirmation = undefined;
		if (!state) return;
		const box = this.recoveryEl.createEl("section", { cls: "relay-timeline-marker-recovery", attr: { "aria-label": "Marker save result" } });
		box.createEl("h3", { text: state.status === "pending" ? "Marker save not confirmed" : state.status === "accepted" ? "Marker save confirmed" : "Marker save needs review" });
		const operation = state.request.command;
		box.createEl("p", { text: operation.type === "marker.put" ? operation.content.label + " · " + timelineRangeLabel(operation.content.range) : "Archive marker in every view" });
		box.createEl("p", { text: state.status === "pending" ? "The original request is saved on this device. Retry it after reconnecting. Starting another save could duplicate an already accepted change, so this result must be recovered first." :
			state.status === "accepted" ? "This request was accepted. The marker may have changed again since then. Acknowledge to load its current state." :
			state.error === "base_generation_changed" ? "The base was restored or replaced. This request cannot apply to its current generation; it may have succeeded in the earlier one. Review the saved request before reloading." :
			"The saved request conflicts with the current revisions or another operation. Review its values before discarding this attempted edit and loading the current marker." });
		if (state.status !== "accepted" && state.error) box.createEl("p", { text: "Result: " + state.error });
		const details = box.createEl("details"); details.createEl("summary", { text: "Saved request and result — select to copy" });
		const copy = details.createEl("textarea", { attr: { "aria-label": "Saved marker request and result", rows: "8", readonly: "" } }); copy.value = JSON.stringify(state, null, 2);
		if (state.status === "pending") this.retryButton = this.button(box, "Retry original save", () => { void this.recover(false); });
		else {
			if (state.status === "rejected") {
				const label = box.createEl("label", { text: "I have reviewed this result. Reload the current marker and discard this attempted edit." });
				this.acknowledgeConfirmation = label.createEl("input", { attr: { type: "checkbox" } }); this.acknowledgeConfirmation.onchange = () => this.updateControls();
			}
			this.acknowledgeButton = this.button(box, state.status === "accepted" ? "Load current marker" : "Acknowledge and reload", () => { void this.recover(true); });
		}
	}
	private renderChoices(): void {
		this.select.replaceChildren(); this.select.createEl("option", { text: "Choose a marker…", attr: { value: "" } });
		for (const marker of this.catalog?.markers ?? []) this.select.createEl("option", { text: marker.content.label + (marker.active ? marker.placement.active ? "" : " · detached from this view" : " · archived") + " · " + marker.id.slice(-8), attr: { value: marker.id } });
		this.select.value = this.detail?.marker.id ?? "";
	}
	private async refresh(selectedId = this.detail?.marker.id): Promise<void> {
		if (!this.current() || this.busy || this.loading || this.dirty) return;
		const serial = ++this.serial; this.loading = true; this.updateControls(); this.status.textContent = "Loading markers…";
		try {
			await this.checkRecovery(); if (!this.current() || serial !== this.serial) return;
			if (this.recoveryError) return;
			if (!this.context.session.online) throw new Error("Reconnect to load marker metadata. Saved requests remain available here.");
			const catalog = await this.context.session.transport.timelineMarkers(this.context.entryId, this.context.binding.viewId);
			if (!this.current() || serial !== this.serial) return;
			const snapshot = this.context.binding.snapshot;
			if (catalog.definition_id !== snapshot.definition_id || catalog.generation !== snapshot.generation || catalog.registry_revision !== snapshot.revision) throw new Error("The saved view changed. Finish synchronization and reopen marker management.");
			this.catalog = catalog; this.proof = undefined;
			let proof: TimelineAxisContext | undefined;
			try { proof = await readNativeTimelineAxis(this.context); } catch { /* Archiving and recovery do not require a projectable axis. */ }
			if (!this.current() || serial !== this.serial) return;
			this.proof = proof;
			this.detail = undefined; this.draft = undefined; this.renderChoices(); this.renderForm();
			this.status.textContent = this.proof ? "Select a marker or create a new one." : "The saved axis is unavailable. Existing markers can still be reviewed or archived.";
		} catch (error) { if (this.current() && serial === this.serial) this.status.textContent = this.error(error); }
		finally { this.loading = false; if (this.current()) this.updateControls(); }
		if (this.current() && !this.recoveryError && selectedId && this.catalog?.markers.some(marker => marker.id === selectedId)) await this.load(selectedId);
	}
	private async load(markerId: string): Promise<void> {
		if (!this.current() || !markerId || !this.catalog || this.busy || this.loading || this.dirty) return;
		if (!this.context.session.online) { this.status.textContent = "Reconnect to load current marker details."; return; }
		const serial = ++this.serial, catalog = this.catalog; this.loading = true; this.updateControls();
		try {
			const detail = await this.context.session.transport.timelineMarker(this.context.entryId, markerId);
			if (!this.current() || serial !== this.serial) return;
			if (detail.definition_id !== catalog.definition_id || detail.generation !== catalog.generation || detail.registry_revision !== catalog.registry_revision || detail.catalog_revision !== catalog.catalog_revision) throw new Error("Markers changed while loading. Refresh the list before editing.");
			this.detail = detail; this.resetDraft(); this.select.value = markerId; this.status.textContent = "Loaded current marker details. Review every selected view before saving.";
		} catch (error) { if (this.current() && serial === this.serial) { this.detail = undefined; this.draft = undefined; this.renderForm(); this.status.textContent = this.error(error); } }
		finally { this.loading = false; if (this.current()) this.updateControls(); }
	}
	private currentPlacement(): TimelineMarkerPlacement | undefined {
		return this.proof && this.axisCurrent() ? { view_id: this.context.binding.viewId, active: true, axis_definition_id: this.proof.axis.id, axis_definition_revision: this.proof.axis.revision, axis: this.proof.axis.axis } : undefined;
	}
	private newDraft(): void {
		if (!this.canSave() || !this.axisCurrent() || this.dirty || this.busy || this.loading || this.recovery) return;
		this.detail = undefined; this.draft = { id: uuid(), label: "", color: "#7c3aed", kind: "point", placements: [this.currentPlacement()!] };
		this.select.value = ""; this.renderForm(); this.updateControls(); this.form.querySelector("input")?.focus();
	}
	private resetDraft(): void {
		const marker = this.detail?.marker; this.dirty = false;
		this.draft = marker ? { id: marker.id, ...marker.content, placements: marker.placements.filter(placement => placement.active).map(placement => ({ ...placement })) } : undefined;
		if (marker && !marker.active && this.draft && this.currentPlacement()) this.draft.placements = [this.currentPlacement()!];
		this.renderForm(); this.updateControls();
	}
	private renderForm(): void {
		this.form.replaceChildren(); this.fields = []; this.saveButton = undefined; this.archiveButton = undefined; this.positionButton = undefined; this.validation = undefined;
		const draft = this.draft; if (!draft) return;
		const changed = () => { this.dirty = true; this.updateControls(); };
		const input = (label: string, value: string, type = "text") => {
			const field = this.form.createEl("label", { text: label }).createEl("input", { attr: { "aria-label": label, type } }); field.value = value; this.fields.push(field); return field;
		};
		const label = input("Marker label", draft.label); label.maxLength = 512; label.oninput = () => { draft.label = label.value; changed(); };
		const color = input("Marker color", draft.color, "color"); color.oninput = () => { draft.color = color.value; changed(); };
		const kind = this.form.createEl("label", { text: "Marker shape" }).createEl("select", { attr: { "aria-label": "Marker shape" } });
		kind.createEl("option", { text: "Point / milestone", attr: { value: "point" } }); kind.createEl("option", { text: "Range", attr: { value: "range" } }); kind.value = draft.kind; this.fields.push(kind);
		kind.onchange = () => { draft.kind = kind.value as Draft["kind"]; changed(); };
		this.form.createEl("p", { text: draft.range ? timelineRangeLabel(draft.range) : "Choose a position before saving." });
		this.positionButton = this.button(this.form, "Choose marker position", () => this.choosePosition());
		const placements = this.form.createEl("fieldset"); placements.createEl("legend", { text: "Place in saved views" });
		const choices = new Map((this.detail?.marker.placements ?? draft.placements).map(placement => [placement.view_id, placement]));
		for (const placement of draft.placements) choices.set(placement.view_id, placement);
		const current = this.currentPlacement(); if (current && !choices.has(current.view_id)) choices.set(current.view_id, current);
		for (const placement of choices.values()) {
			const views = this.context.binding.snapshot.views ?? [];
			const label = views.find(view => view.id === placement.view_id)?.name ?? (placement.view_id === this.context.binding.viewId ? this.context.binding.name : "Saved view " + placement.view_id.slice(-8));
			const name = label + (views.filter(view => view.name === label).length > 1 ? " · " + placement.view_id.slice(-8) : "");
			const checked = placements.createEl("label", { text: name + " · " + placement.axis.start_property.name + (placement.axis.time_zone ? " · " + placement.axis.time_zone : "") }).createEl("input", { attr: { type: "checkbox", "aria-label": "Place in " + name } });
			checked.checked = draft.placements.some(item => item.view_id === placement.view_id); this.fields.push(checked);
			checked.onchange = () => { draft.placements = draft.placements.filter(item => item.view_id !== placement.view_id); if (checked.checked) draft.placements.push({ ...placement, active: true }); changed(); };
		}
		if (current && draft.placements.some(item => item.view_id === current.view_id && (item.axis_definition_id !== current.axis_definition_id || item.axis_definition_revision !== current.axis_definition_revision || !sameTimelineAxis(item.axis, current.axis)))) {
			this.form.createEl("p", { text: "This marker uses an older axis in this view. Review its coordinates before switching to the current property: " + current.axis.start_property.name + "." });
			this.fields.push(this.button(this.form, "Use current axis in this view", () => { draft.placements = draft.placements.filter(item => item.view_id !== current.view_id).concat(current); this.dirty = true; this.renderForm(); this.updateControls(); }));
		}
		if (this.detail?.marker.active === false) this.form.createEl("p", { text: "Restoring activates the selected views only. Review the position and placements before saving." });
		this.validation = this.form.createEl("p", { attr: { "aria-live": "polite" } });
		this.saveButton = this.button(this.form, this.detail?.marker.active === false ? "Restore marker" : "Save marker", () => { void this.save(false); });
		this.fields.push(this.button(this.form, "Discard form changes", () => { this.resetDraft(); this.status.textContent = "Unsent form changes discarded."; }));
		if (this.detail?.marker.active) {
			this.archiveConfirmation = this.form.createEl("label", { text: "Archive this marker in every view. Existing discussions stay available." }).createEl("input", { attr: { type: "checkbox" } });
			this.fields.push(this.archiveConfirmation); this.archiveConfirmation.onchange = () => this.updateControls();
			this.archiveButton = this.button(this.form, "Archive marker", () => { void this.save(true); });
		}
	}
	private request(archive: boolean, operationId = "00000000-0000-4000-8000-000000000000"): TimelineMarkerCommand {
		const catalog = this.catalog, draft = this.draft; if (!catalog || !draft) throw new Error("Load a marker or start a new one first.");
		let command: TimelineMarkerCommand["command"];
		if (archive) {
			if (!this.detail?.marker.active || !this.archiveConfirmation?.checked) throw new Error("Confirm archiving in every view first.");
			command = { type: "marker.archive", marker_id: draft.id, expected_marker_revision: this.detail.marker.revision };
		} else {
			const content: TimelineMarkerContent = parseTimelineMarkerContent({ kind: draft.kind, label: draft.label, color: draft.color, range: draft.range });
			if (!this.axisCurrent()) throw new Error("Refresh the saved axis before changing a marker position.");
			for (const placement of draft.placements) {
				const current = this.currentPlacement();
				if (current && placement.view_id === current.view_id && (placement.axis_definition_id !== current.axis_definition_id || placement.axis_definition_revision !== current.axis_definition_revision || !sameTimelineAxis(placement.axis, current.axis))) throw new Error("Review and choose the current axis in this view before saving.");
				parseAnchor({ version: 1, type: "base", definition_id: catalog.definition_id, generation: catalog.generation, registry_revision: catalog.registry_revision, view_id: placement.view_id,
					target: { type: "timeline_marker", marker_id: draft.id, marker_revision: (this.detail?.marker.revision ?? 0) + 1, axis_definition_id: placement.axis_definition_id, axis_definition_revision: placement.axis_definition_revision, axis: placement.axis, content } });
			}
			command = { type: "marker.put", marker_id: draft.id, expected_marker_revision: this.detail?.marker.revision ?? 0, content,
				placements: draft.placements.map(({ view_id, axis_definition_id, axis_definition_revision }) => ({ view_id, axis_definition_id, axis_definition_revision })) };
		}
		return parseTimelineMarkerCommand({ operation_id: operationId, definition_id: catalog.definition_id, generation: catalog.generation, registry_revision: catalog.registry_revision, expected_catalog_revision: catalog.catalog_revision, command });
	}
	private choosePosition(): void {
		if (!this.current() || !this.draft || this.positionButton?.disabled) return;
		const draft = this.draft;
		const workflow = new TimelineRangeWorkflow(this.app, this.context, this.current, async (proof, range, current) => {
			if (!current() || !this.current() || proof.registry_revision !== this.catalog?.registry_revision || proof.generation !== this.catalog.generation) return false;
			draft.range = range; this.dirty = true; return true;
		}, { draft: draft.range, point: draft.kind === "point", closed: () => { if (this.position !== workflow) return; this.position = undefined; if (this.current()) this.open(); else this.close(); } });
		this.position = workflow; this.transitioning = true; super.close(); this.transitioning = false; void workflow.open();
	}
	private async save(archive: boolean): Promise<void> {
		if (!this.current() || !this.canSave() || this.busy || this.loading || this.recovery || this.recoveryError || archive && this.dirty) return;
		this.busy = true; this.updateControls();
		try {
			if (!archive) { const proof = await readNativeTimelineAxis(this.context); if (!this.current()) return; if (proof.registry_revision !== this.catalog?.registry_revision) throw new Error("The saved view changed. Review the latest marker metadata before saving."); }
			if (!this.canSave()) return;
			const request = this.request(archive, uuid()); await this.context.session.markerManagement.save(this.context.entryId, request);
		} catch (error) { if (this.current()) this.status.textContent = this.error(error); }
		finally { this.busy = false; await this.checkRecovery(); if (this.current()) this.updateControls(); }
	}
	private async recover(acknowledge: boolean): Promise<void> {
		const state = this.recovery;
		if (!this.current() || !state || this.busy || this.loading || (acknowledge ? state.status === "pending" || state.status === "rejected" && !this.acknowledgeConfirmation?.checked : !this.canEdit() || state.status !== "pending")) return;
		this.busy = true; this.updateControls(); let cleared = false;
		try {
			if (acknowledge) cleared = await this.context.session.markerManagement.acknowledge(this.context.entryId, state.request.operation_id);
			else await this.context.session.markerManagement.retry(this.context.entryId);
		} catch (error) { if (this.current()) this.status.textContent = this.error(error); }
		finally { this.busy = false; await this.checkRecovery(); if (this.current()) this.updateControls(); }
		if (cleared && this.current()) { this.dirty = false; this.detail = undefined; this.draft = undefined; await this.refresh(state.request.command.marker_id); }
	}
	private error(error: unknown): string { return error instanceof Error ? error.message : "The marker operation could not be completed. Saved requests and values are retained."; }
	private updateControls(): void {
		if (this.closed || this.position || !this.select) return;
		const blocked = this.busy || this.loading || !!this.recovery || this.recoveryError;
		this.select.disabled = blocked || this.dirty || !this.context.session.online;
		this.refreshButton.disabled = this.busy || this.loading || this.dirty;
		this.newButton.disabled = blocked || this.dirty || !this.canSave() || !this.axisCurrent();
		for (const field of this.fields) field.disabled = blocked || !this.canSave();
		if (this.positionButton) this.positionButton.disabled = blocked || !this.canSave() || !this.axisCurrent();
		if (this.saveButton) {
			try { this.request(false); this.saveButton.disabled = blocked || !this.canSave(); if (this.validation) this.validation.textContent = "Ready to save the selected position and views."; }
			catch (error) {
				this.saveButton.disabled = true;
				if (this.validation) this.validation.textContent = !this.draft?.label.trim() ? "Enter a marker label." : !this.draft.range ? "Choose a marker position." :
					!this.draft.placements.length ? "Select at least one saved view." : this.draft.kind === "point" && (JSON.stringify(this.draft.range.start) !== JSON.stringify(this.draft.range.end) || !this.draft.range.start_inclusive || !this.draft.range.end_inclusive) ?
					"Choose a single position for this point marker." : "Check the label, position and compatibility with every selected view. " + this.error(error);
			}
		}
		if (this.archiveButton) this.archiveButton.disabled = blocked || !this.canSave() || !this.archiveConfirmation?.checked || this.dirty;
		if (this.retryButton) this.retryButton.disabled = this.busy || this.loading || !this.canEdit();
		if (this.acknowledgeButton) this.acknowledgeButton.disabled = this.busy || this.loading || this.recovery?.status === "rejected" && !this.acknowledgeConfirmation?.checked;
	}
	validate(): void {
		if (!this.current()) { this.close(); return; }
		this.position?.validate(); this.updateControls(); void this.checkRecovery();
	}
	close(): void {
		if (this.closed) return; this.closed = true; this.serial++;
		const position = this.position; this.position = undefined; position?.close(); super.close(); this.finish();
	}
	private finish(): void { this.catalog = undefined; this.proof = undefined; this.detail = undefined; this.draft = undefined; this.recovery = undefined; this.fields = []; this.contentEl.empty(); this.closedCallback(); }
	onClose(): void { if (this.transitioning) { this.contentEl.empty(); return; } if (!this.closed) { this.closed = true; this.serial++; this.finish(); } }
}
