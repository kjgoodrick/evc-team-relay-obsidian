import { App, Modal, Setting } from "obsidian";
import type { VaultShare } from "../VaultShare";
import { BaseSyncHost, baseSyncMessage, type BaseSyncRow } from "./BaseSyncHost";
import { baseText } from "./NativeBaseFile";
import type { BaseConflictReview } from "./BaseSyncRunner";
import type { BaseRetirementReview } from "./BaseRetirement";
import type { BaseRestoreReview } from "./BaseRestoration";

export class BaseSyncModal extends Modal {
	private busy = false;
	private closed = false;
	private serial = 0;
	private context = 0;
	private error = "";
	private rows: BaseSyncRow[] = [];
	private checked?: { entryId: string; operationId: string; status: "accepted" | "withdrawn" | "unknown" };
	private reviewed?: { row: BaseSyncRow; review: BaseConflictReview };
	private removal?: { row: BaseSyncRow; review: BaseRetirementReview };
	private restoration?: { row: BaseSyncRow; review: BaseRestoreReview; key: string; path: string };
	private unsubscribe?: () => void;
	constructor(app: App, private host: BaseSyncHost, private folder: VaultShare) { super(app); }
	onOpen(): void {
		this.closed = false; this.contentEl.addClass("evc-bases-sync");
		this.unsubscribe = this.host.onChange(reset => {
			if (reset) { this.context++; this.serial++; this.checked = undefined; this.reviewed = undefined; this.removal = undefined; this.restoration = undefined; this.rows = []; this.render(); }
			if (!this.busy || reset) void this.refresh();
		}); void this.refresh();
	}
	onClose(): void { this.closed = true; this.context++; this.serial++; this.unsubscribe?.(); this.contentEl.empty(); }
	private async refresh(): Promise<void> {
		const serial = ++this.serial;
		try { const rows = await this.host.rows(this.folder); if (this.closed || serial !== this.serial) return; this.rows = rows; }
		catch (error) { if (!this.closed && serial === this.serial) { this.error = baseSyncMessage(error); this.rows = []; this.reviewed = undefined; this.removal = undefined; this.restoration = undefined; } }
		if (!this.closed && serial === this.serial) this.render();
	}
	private render(): void {
		if (this.closed) return;
		this.contentEl.empty(); this.contentEl.createEl("h2", { text: "Bases sync" });
		this.contentEl.createEl("p", { text: "Conflicting edits stay on this device until you choose a copy. Recovery copies are retained after each choice and can be exported." });
		if (this.error) this.contentEl.createEl("p", { text: this.error, cls: "mod-warning", attr: { role: "alert" } });
		new Setting(this.contentEl).setName("Refresh status").addButton(button => button.setButtonText("Refresh").setDisabled(this.busy).onClick(() => { this.reviewed = undefined; this.removal = undefined; this.restoration = undefined; return this.act(async () => {}); }));
		if (!this.rows.length) this.contentEl.createEl("p", { text: "No Bases files are tracked yet. Enable Bases sync in the shared folder’s settings." });
		for (const row of this.rows) {
			this.contentEl.createEl("h3", { text: row.path }); this.contentEl.createEl("p", { text: row.message });
			const controls = new Setting(this.contentEl).setName("Sync and recovery");
			if (row.record.retirement) {
				if (row.record.retirement.move?.state !== "complete") controls.addButton(button => button.setButtonText("Review removal").setDisabled(this.busy).onClick(() => this.act(async () => {
					const context = this.context, review = await this.host.reviewRemoval(this.folder, row.entryId);
					if (context === this.context) { this.reviewed = undefined; this.restoration = undefined; this.removal = { row, review }; }
				})));
				if (row.record.restore?.state === "prepared") {
					controls.addButton(button => button.setButtonText("Check restoration").setDisabled(this.busy).onClick(() => this.act(() => this.host.resumeRestore(this.folder, row.entryId))));
					controls.addButton(button => button.setButtonText("Stop restoration").setDisabled(this.busy).onClick(() => this.act(() => this.host.cancelRestore(this.folder, row.entryId, row.record.revision))));
				} else controls.addButton(button => button.setButtonText("Restore as new file").setDisabled(this.busy).onClick(() => this.act(async () => {
					const context = this.context, review = await this.host.reviewRestore(this.folder, row.entryId);
					if (context !== this.context) return;
					this.reviewed = undefined; this.removal = undefined;
					this.restoration = { row, review, key: review.copies[0]?.key ?? "", path: row.path.replace(/\.[^/.]+$/, "") + " (restored).base" };
				})));
			} else if (row.file) {
				controls.addButton(button => button.setButtonText("Retry sync").setDisabled(this.busy).onClick(() => this.act(() => this.host.retry(this.folder, row.file!))));
				if (row.record.pending) {
					const operationId = row.record.pending.operationId;
					controls.addButton(button => button.setButtonText("Check saved result").setDisabled(this.busy).onClick(() => this.act(async () => {
						const context = this.context, receipt = await this.host.checkStatus(this.folder, row.file!);
						if (context === this.context && !this.closed) this.checked = { entryId: row.entryId, operationId, status: receipt.status };
					})));
					controls.addButton(button => button.setButtonText("Check delivery / withdraw").setDisabled(this.busy || !this.folder.canWriteManagedPath(row.path)).onClick(() => this.act(() => this.host.withdraw(this.folder, row.file!))));
				}
				if (row.record.conflict || row.record.reviewRequired) controls.addButton(button => button.setButtonText("Review copies").setDisabled(this.busy).onClick(() => this.act(async () => {
					const context = this.context, review = await this.host.review(this.folder, row.file!);
					if (context === this.context) { this.removal = undefined; this.restoration = undefined; this.reviewed = { row, review }; }
				})));
			}
			controls.addButton(button => button.setButtonText("Export recovery copies").setDisabled(this.busy).onClick(() => this.act(async () => { await this.host.export(this.folder, row.entryId); })));
			if (this.checked?.entryId === row.entryId && row.record.pending?.operationId === this.checked.operationId) {
				const message = this.checked.status === "accepted" ? "The server has an acceptance receipt for this exact saved request." :
					this.checked.status === "withdrawn" ? "The server has a withdrawal receipt for this exact saved request." :
					"No matching receipt is available. The request may have succeeded before a restore; this does not prove it was never saved.";
				this.contentEl.createEl("p", { text: message + " This check did not change the file or resend or withdraw the request. The pending request and local copies remain retained for recovery.", attr: { role: "status", "aria-live": "polite" } });
			}
			if (this.reviewed?.row.entryId === row.entryId) this.renderReview(row, this.reviewed.review);
			if (this.removal?.row.entryId === row.entryId) this.renderRemoval(row, this.removal.review);
			if (this.restoration?.row.entryId === row.entryId) this.renderRestore(this.restoration);
		}
	}
	private renderRestore(restore: NonNullable<BaseSyncModal["restoration"]>): void {
		this.contentEl.createEl("p", { text: "Choose a retained copy and a new .base path relative to this shared folder. The destination folder must already exist. Originals stay retained; the new file synchronizes separately and does not inherit the removed file’s discussions." });
		const select = this.contentEl.createEl("select", { attr: { "aria-label": "Copy to restore" } });
		for (const copy of restore.review.copies) select.createEl("option", { text: copy.label, attr: { value: copy.key } });
		select.value = restore.key; select.disabled = this.busy;
		select.onchange = () => { restore.key = select.value; this.render(); };
		const selected = restore.review.copies.find(copy => copy.key === restore.key);
		if (selected) this.preview(selected.label, restore.row.path, selected.bytes);
		else this.contentEl.createEl("p", { text: "No retained copy is available here. Export recovery history to inspect older copies." });
		const input = this.contentEl.createEl("input", { attr: { type: "text", "aria-label": "New Bases path", placeholder: "Folder/Restored.base" } });
		input.value = restore.path; input.disabled = this.busy; input.oninput = () => { restore.path = input.value; };
		new Setting(this.contentEl).setName("Create the reviewed copy")
			.addButton(button => button.setButtonText("Create restored file").setDisabled(this.busy || !selected).onClick(() => this.act(async () => {
				await this.host.restore(this.folder, restore.row.entryId, restore.review, restore.key, restore.path); this.restoration = undefined;
			})));
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
		this.busy = true; this.error = ""; this.checked = undefined; this.render();
		try { await action(); } catch (error) { this.error = baseSyncMessage(error); this.reviewed = undefined; this.removal = undefined; this.restoration = undefined; }
		finally { this.busy = false; await this.refresh(); }
	}
}
