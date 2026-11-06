import { App, Modal, Setting } from "obsidian";
import type { VaultShare } from "../VaultShare";
import { BaseSyncHost, baseSyncMessage, type BaseSyncRow } from "./BaseSyncHost";
import { baseText } from "./NativeBaseFile";
import type { BaseConflictReview } from "./BaseSyncRunner";
import type { BaseRetirementReview } from "./BaseRetirement";

export class BaseSyncModal extends Modal {
	private busy = false;
	private closed = false;
	private serial = 0;
	private error = "";
	private rows: BaseSyncRow[] = [];
	private reviewed?: { row: BaseSyncRow; review: BaseConflictReview };
	private removal?: { row: BaseSyncRow; review: BaseRetirementReview };
	private unsubscribe?: () => void;
	constructor(app: App, private host: BaseSyncHost, private folder: VaultShare) { super(app); }
	onOpen(): void {
		this.closed = false; this.contentEl.addClass("evc-bases-sync");
		this.unsubscribe = this.host.onChange(reset => {
			if (reset) { this.serial++; this.reviewed = undefined; this.removal = undefined; this.rows = []; this.render(); }
			if (!this.busy || reset) void this.refresh();
		}); void this.refresh();
	}
	onClose(): void { this.closed = true; this.serial++; this.unsubscribe?.(); this.contentEl.empty(); }
	private async refresh(): Promise<void> {
		const serial = ++this.serial;
		try { const rows = await this.host.rows(this.folder); if (this.closed || serial !== this.serial) return; this.rows = rows; }
		catch (error) { if (!this.closed && serial === this.serial) { this.error = baseSyncMessage(error); this.rows = []; this.reviewed = undefined; this.removal = undefined; } }
		if (!this.closed && serial === this.serial) this.render();
	}
	private render(): void {
		if (this.closed) return;
		this.contentEl.empty(); this.contentEl.createEl("h2", { text: "Bases sync" });
		this.contentEl.createEl("p", { text: "Conflicting edits stay on this device until you choose a copy. Recovery copies are retained after each choice and can be exported." });
		if (this.error) this.contentEl.createEl("p", { text: this.error, cls: "mod-warning", attr: { role: "alert" } });
		new Setting(this.contentEl).setName("Refresh status").addButton(button => button.setButtonText("Refresh").setDisabled(this.busy).onClick(() => { this.reviewed = undefined; this.removal = undefined; return this.act(async () => {}); }));
		if (!this.rows.length) this.contentEl.createEl("p", { text: "No Bases files are tracked yet. Enable Bases sync in the shared folder’s settings." });
		for (const row of this.rows) {
			this.contentEl.createEl("h3", { text: row.path }); this.contentEl.createEl("p", { text: row.message });
			const controls = new Setting(this.contentEl).setName("Sync and recovery");
			if (row.record.retirement) {
				if (row.record.retirement.move?.state !== "complete") controls.addButton(button => button.setButtonText("Review removal").setDisabled(this.busy).onClick(() => this.act(async () => {
					this.reviewed = undefined; this.removal = { row, review: await this.host.reviewRemoval(this.folder, row.entryId) };
				})));
			} else if (row.file) {
				controls.addButton(button => button.setButtonText("Retry sync").setDisabled(this.busy).onClick(() => this.act(() => this.host.retry(this.folder, row.file!))));
				if (row.record.pending) controls.addButton(button => button.setButtonText("Check delivery / withdraw").setDisabled(this.busy).onClick(() => this.act(() => this.host.withdraw(this.folder, row.file!))));
				if (row.record.conflict || row.record.reviewRequired) controls.addButton(button => button.setButtonText("Review copies").setDisabled(this.busy).onClick(() => this.act(async () => {
					this.reviewed = { row, review: await this.host.review(this.folder, row.file!) };
				})));
			}
			controls.addButton(button => button.setButtonText("Export recovery copies").setDisabled(this.busy).onClick(() => this.act(async () => { await this.host.export(this.folder, row.entryId); })));
			if (this.reviewed?.row.entryId === row.entryId) this.renderReview(row, this.reviewed.review);
			if (this.removal?.row.entryId === row.entryId) this.renderRemoval(row, this.removal.review);
		}
	}
	private renderRemoval(row: BaseSyncRow, review: BaseRetirementReview): void {
		this.contentEl.createEl("p", { text: "The server removed this file identity. Moving the local file into recovery keeps its contents and stops it occupying the shared path. Retained sync requests and earlier copies stay available for export." });
		this.preview("Current local file", row.path, review.local.bytes);
		this.preview("Saved when removal was observed", row.path, review.record.retirement!.local);
		new Setting(this.contentEl).setName("Retain outside sync")
			.addButton(button => button.setButtonText(review.local.bytes === null ? "Check recovery move" : "Move to local recovery")
				.setDisabled(this.busy || review.local.bytes === null && !review.record.retirement?.move)
				.onClick(() => this.act(async () => { await this.host.moveRemoved(this.folder, row.entryId, review); this.removal = undefined; })));
	}
	private preview(label: string, path: string, bytes: ArrayBuffer | null): void {
		this.contentEl.createEl("h4", { text: label });
		let value = "This copy is missing.";
		if (bytes !== null) { try { value = baseText(bytes); } catch { value = "This copy cannot be shown as text. Export it before repairing the encoding."; } }
		const area = this.contentEl.createEl("textarea", { attr: { "aria-label": `${label}: ${path}`, readonly: "", rows: "8" } });
		area.value = value;
	}
	private renderReview(row: BaseSyncRow, review: BaseConflictReview): void {
		this.preview("This device", row.path, review.local.bytes); this.preview("Server", row.path, review.remote.bytes);
		new Setting(this.contentEl).setName("Choose a copy").setDesc("Both reviewed copies are saved locally before applying your choice. If either copy changes, review it again.")
			.addButton(button => button.setButtonText("Use this device").setDisabled(this.busy || review.local.bytes === null || !this.folder.canWriteManagedPath(row.path)).onClick(() => this.choose(row, review, "local")))
			.addButton(button => button.setButtonText("Use server").setDisabled(this.busy || review.remote.bytes === null).onClick(() => this.choose(row, review, "server")));
	}
	private choose(row: BaseSyncRow, review: BaseConflictReview, choice: "local" | "server"): Promise<void> {
		return this.act(async () => { await this.host.resolve(this.folder, row.file!, review, choice); this.reviewed = undefined; });
	}
	private async act(action: () => Promise<void>): Promise<void> {
		if (this.busy || this.closed) return;
		this.busy = true; this.error = ""; this.render();
		try { await action(); } catch (error) { this.error = baseSyncMessage(error); this.reviewed = undefined; this.removal = undefined; }
		finally { this.busy = false; await this.refresh(); }
	}
}
