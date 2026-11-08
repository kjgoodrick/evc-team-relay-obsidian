import { App, Modal, Setting } from "obsidian";
import type { AttachmentFile } from "../AttachmentFile";
import type { VaultShare } from "../VaultShare";
import { baseSyncMessage, type BaseSyncHost } from "./BaseSyncHost";
import type { BaseRegistryRecord } from "./BaseRegistryStore";
import type { BaseSavedView, BaseViewPage } from "./BaseRegistryProtocol";
import { baseRegistryBinding } from "./BaseRegistryProtocol";

export class BaseViewsModal extends Modal {
	private closed = false;
	private busy = false;
	private context = 0;
	private verified = false;
	private record?: BaseRegistryRecord;
	private selections = new Map<number, string>();
	private archive = new Set<string>();
	private unmatched?: BaseViewPage;
	private archived?: BaseViewPage;
	private retained = new Map<string, BaseSavedView>();
	private error = "";
	private receipt = "";
	private unsubscribe?: () => void;
	constructor(app: App, private host: BaseSyncHost, private folder: VaultShare, private file: AttachmentFile) { super(app); }
	onOpen(): void {
		this.closed = false;
		this.unsubscribe = this.host.onChange(reset => {
			if (!reset) return;
			this.context++; this.verified = false; this.record = undefined; this.receipt = ""; this.retained.clear(); this.render();
		});
		void this.act(async context => {
			const cached = await this.host.cachedViews(this.folder, this.file);
			if (context !== this.context) return; this.load(cached, false); this.render();
			const record = await this.host.refreshViews(this.folder, this.file);
			if (context === this.context) this.load(record, true);
		});
	}
	onClose(): void { this.closed = true; this.context++; this.unsubscribe?.(); this.contentEl.empty(); }
	private load(record: BaseRegistryRecord, verified: boolean): void {
		this.record = record; this.verified = verified; this.selections.clear(); this.archive.clear(); this.retained.clear(); this.archived = undefined;
		for (const view of record.snapshot?.views ?? []) this.selections.set(view.slot, view.id ?? "");
		this.unmatched = record.snapshot?.unmatched;
		for (const view of this.unmatched?.views ?? []) this.retained.set(view.id, view);
	}
	private editable(): boolean { return this.verified && !this.record?.pending && this.folder.canWriteManagedPath(this.file.path); }
	private async act(action: (context: number) => Promise<void>): Promise<void> {
		if (this.closed || this.busy) return; this.busy = true; this.error = ""; this.receipt = ""; const context = this.context; this.render();
		try { await action(context); }
		catch (error) {
			if (context !== this.context) return;
			this.error = baseSyncMessage(error, "The server could not confirm this saved-view request. Refresh to inspect current associations, or use Check repair delivery for a pending change."); this.verified = false;
			try { const record = await this.host.cachedViews(this.folder, this.file); if (context === this.context) this.load(record, false); }
			catch { this.record = undefined; this.retained.clear(); }
		} finally { this.busy = false; if (!this.closed) this.render(); }
	}
	private render(): void {
		if (this.closed) return;
		this.contentEl.empty(); this.contentEl.createEl("h2", { text: "Saved-view associations" });
		this.contentEl.createEl("p", { text: this.file.path });
		this.contentEl.createEl("p", { text: "Each saved view has its own discussion history. Choose which earlier view each current view continues. A new identity starts a separate history. These choices do not change the Bases file." });
		if (this.error) this.contentEl.createEl("p", { text: this.error, cls: "mod-warning", attr: { role: "alert" } });
		new Setting(this.contentEl).setName("Inspect synchronized views").addButton(button => button.setButtonText("Refresh views").setDisabled(this.busy).onClick(() => this.act(async context => {
			const record = await this.host.refreshViews(this.folder, this.file); if (context === this.context) this.load(record, true);
		})));
		new Setting(this.contentEl).setName("Retain a local copy").addButton(button => button.setButtonText("Export recovery copies").setDisabled(this.busy).onClick(() => this.act(async () => { await this.host.export(this.folder, this.file.entityGuid); })));
		const snapshot = this.record?.snapshot;
		if (!snapshot) { this.contentEl.createEl("p", { text: this.busy ? "Loading saved views…" : "No saved-view mapping is available. Synchronize the Bases file and refresh." }); return; }
		this.contentEl.createEl("p", { text: this.verified ? `Verified saved-view revision ${snapshot.revision}.` : "Cached associations. Refresh while connected before changing them." });
		const pending = this.record!.pending;
		if (pending) {
			const restored = (pending.restoreGeneration ?? null) !== (baseRegistryBinding(snapshot).restoreGeneration ?? null);
			this.contentEl.createEl("h3", { text: "Association change awaiting confirmation" });
			this.contentEl.createEl("p", { text: restored ? "This saved repair belongs to the share before restoration. Its original choices are retained. Check its saved result or export a recovery copy; it cannot be resent to this restored share." : "Check repair delivery resends the saved request to finish it. Check saved result only inspects its receipt. Refreshing the list does not resend it." });
			if (this.receipt) this.contentEl.createEl("p", { text: this.receipt, attr: { role: "status" } });
			for (const binding of pending.request.bindings) this.contentEl.createEl("p", { text: `${pending.reviewed.views[binding.slot]?.name ?? "Saved view"}: ${binding.view_id ? `continue identity ${binding.view_id}` : "new identity"}` });
			new Setting(this.contentEl).setName("Inspect the saved result").addButton(button => button.setButtonText("Check saved result").setDisabled(this.busy).onClick(() => this.act(async context => {
				const result = await this.host.viewRepairStatus(this.folder, this.file);
				if (context === this.context) this.receipt = result.status === "accepted" ? `The server retains an accepted receipt for saved-view revision ${result.result.revision}. This is historical evidence; the pending choices remain retained for review.` : "No receipt was found. This does not prove the repair never committed before restoration. Its original choices remain retained.";
			})));
			new Setting(this.contentEl).setName("Confirm the saved change").addButton(button => button.setButtonText("Check repair delivery").setDisabled(this.busy || restored || !this.folder.canWriteManagedPath(this.file.path)).onClick(() => this.act(async context => {
				const record = await this.host.checkViewRepair(this.folder, this.file); if (context === this.context) this.load(record, true);
			})));
		}
		this.contentEl.createEl("h3", { text: "Current saved views" });
		const choices = [...snapshot.views.filter(view => view.id).map(view => ({ id: view.id!, name: view.name, type: view.type, state: "current" })), ...this.retained.values()];
		for (const view of snapshot.views) {
			this.contentEl.createEl("h4", { text: `${view.name} (${view.type})` });
			this.contentEl.createEl("p", { text: view.id ? `Current identity: ${view.id}` : "Unmatched saved view. An editor can associate its earlier history or start a new identity." });
			const select = this.contentEl.createEl("select", { attr: { "aria-label": `Association for ${view.name}` } });
			select.createEl("option", { text: "New identity", attr: { value: "" } });
			for (const choice of choices) select.createEl("option", { text: `${choice.name} · ${choice.type} · ${choice.state} · ${choice.id.slice(0, 8)}`, attr: { value: choice.id } });
			select.value = this.selections.get(view.slot) ?? ""; select.disabled = this.busy || !this.editable();
			select.onchange = () => {
				this.selections.set(view.slot, select.value); this.archive.delete(select.value); this.render();
				Array.from(this.contentEl.querySelectorAll("select")).find(element => element.getAttribute("aria-label") === `Association for ${view.name}`)?.focus();
			};
		}
		if (this.retained.size) {
			this.contentEl.createEl("h3", { text: "Retained earlier views" });
			this.contentEl.createEl("p", { text: "Unassigned histories stay retained. Archiving removes a view from the unmatched list; it does not delete its discussions. A known archived identity can be selected above to restore its association." });
			for (const view of this.retained.values()) {
				const label = this.contentEl.createEl("label"), checkbox = label.createEl("input", { attr: { type: "checkbox", "aria-label": `Archive ${view.name} (${view.id})` } });
				label.createEl("span", { text: ` Archive ${view.name} (${view.type}, ${view.state}, ${view.id.slice(0, 8)})` });
				checkbox.checked = this.archive.has(view.id); checkbox.disabled = this.busy || !this.editable() || view.state === "archived" || [...this.selections.values()].includes(view.id);
				checkbox.onchange = () => {
					if (checkbox.checked) this.archive.add(view.id); else this.archive.delete(view.id); this.render();
					Array.from(this.contentEl.querySelectorAll("input")).find(element => element.getAttribute("aria-label") === `Archive ${view.name} (${view.id})`)?.focus();
				};
			}
		}
		const pages = new Setting(this.contentEl).setName("Find earlier view identities");
		if (this.unmatched?.has_more) pages.addButton(button => button.setButtonText("More unmatched views").setDisabled(this.busy || !this.verified).onClick(() => this.page("unmatched")));
		if (!this.archived || this.archived.has_more) pages.addButton(button => button.setButtonText(this.archived ? "More archived views" : "Load archived views").setDisabled(this.busy || !this.verified).onClick(() => this.page("archived")));
		const changed = this.archive.size > 0 || snapshot.views.some(view => !view.id || (this.selections.get(view.slot) || null) !== view.id);
		const assigned = [...this.selections.values()].filter(Boolean), duplicate = new Set(assigned).size !== assigned.length;
		if (duplicate) this.contentEl.createEl("p", { text: "An earlier identity is selected more than once. Choose a different identity or a new identity for each view.", attr: { role: "alert" } });
		new Setting(this.contentEl).setName("Apply associations").setDesc("Each earlier identity can belong to only one current view. Any identities left unassigned stay retained.")
			.addButton(button => button.setButtonText("Save associations").setDisabled(this.busy || !this.editable() || !changed || duplicate).onClick(() => this.act(async context => {
				const record = await this.host.repairViews(this.folder, this.file, snapshot, snapshot.views.map(view => ({ slot: view.slot, view_id: this.selections.get(view.slot) || null })), [...this.archive]);
				if (context === this.context) this.load(record, true);
			})));
	}
	private page(state: "unmatched" | "archived"): Promise<void> {
		return this.act(async context => {
			const snapshot = this.record?.snapshot; if (!snapshot) return;
			const after = (state === "unmatched" ? this.unmatched : this.archived)?.next_after ?? undefined;
			const page = await this.host.savedViewPage(this.folder, this.file, snapshot, state, after);
			if (context !== this.context) return;
			for (const view of page.views) this.retained.set(view.id, view);
			if (state === "unmatched") this.unmatched = page; else this.archived = page;
		});
	}
}
