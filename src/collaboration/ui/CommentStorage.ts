import { Modal, TFolder, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import type { DiscussionStorageUsage } from "../storage/CachePolicy";
import type { LocalWorkSummary } from "../storage/LocalWorkRecords";
import type { LocalWorkIO } from "../LocalWorkRecovery";

const mib = 1024 * 1024;
const size = (bytes: number) => `${(bytes / mib).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;

/** Account/share-local controls operate offline. Drafts, queued work and their
 * originals have independent ownership and are never disposable cache data. */
export class CommentStorageModal extends Modal {
	private live = true;
	private busy = false;
	private loading = false;
	private refreshAgain = false;
	private generation = 0;
	private dirty = false;
	private stop?: () => void;
	private timer?: number;
	private usage?: DiscussionStorageUsage;
	private summary?: HTMLElement;
	private status?: HTMLElement;
	private limit?: HTMLSelectElement;
	private save?: HTMLButtonElement;
	private clear?: HTMLButtonElement;
	private exportButton?: HTMLButtonElement;
	private releaseButton?: HTMLButtonElement;
	private releaseCheck?: HTMLInputElement;
	private recoverySummary?: HTMLElement;
	private retained?: LocalWorkSummary;
	constructor(app: App, private session: DiscussionSession, private context: () => boolean, private recoveryIO?: LocalWorkIO) { super(app); }
	private current = () => this.live && this.context() && this.session.status !== "closed";
	validate(): void { if (this.live && !this.current()) this.close(); }
	async onOpen(): Promise<void> {
		this.setTitle("Comment storage on this device");
		this.contentEl.createEl("p", { text: "Applies to this shared folder in this vault for the signed-in account. Saved drafts, queued changes and their original pictures are retained separately from downloaded pictures." });
		this.summary = this.contentEl.createDiv();
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const label = this.contentEl.createEl("label", { text: "Downloaded picture limit " });
		this.limit = label.createEl("select", { attr: { "aria-label": "Downloaded picture cache limit" } });
		for (const amount of [0, 25, 50, 100, 250, 500]) this.limit.createEl("option", { text: amount ? `${amount} MiB` : "Do not keep downloaded pictures", attr: { value: String(amount * mib) } });
		this.limit.onchange = () => { this.dirty = true; this.controls(); };
		this.save = this.contentEl.createEl("button", { text: "Save cache limit", attr: { type: "button" } });
		this.save.onclick = () => { if (this.limit) void this.change(() => this.session.setPictureCacheLimit(Number(this.limit!.value)), "Picture cache limit saved."); };
		this.clear = this.contentEl.createEl("button", { text: "Clear downloaded pictures", attr: { type: "button" } });
		this.clear.onclick = () => { void this.change(() => this.session.clearDownloadedPictures(), "Downloaded pictures cleared. Saved work and original pictures are retained.", false); };
		this.contentEl.createEl("p", { text: "Lowering the limit removes the least recently used downloads first. Pictures load again when opened online. Visible pictures may remain in memory until their view closes." });
		this.contentEl.createEl("h3", { text: "Save a recovery copy" });
		this.contentEl.createEl("p", { text: "Save this account's drafts, waiting changes, unconfirmed actions and retained original pictures in the local recovery folder. This is an unencrypted local copy; other sync or backup tools may copy it. Shared discussion history and server-only pictures are not included. Nothing is sent or discarded. Import is not available in this preview." });
		this.recoverySummary = this.contentEl.createDiv();
		this.exportButton = this.contentEl.createEl("button", { text: "Save recovery copy", attr: { type: "button" } });
		this.exportButton.onclick = () => { void this.exportWork(); };
		const release = this.contentEl.createEl("label");
		this.releaseCheck = release.createEl("input", { attr: { type: "checkbox" } });
		release.createSpan({ text: " I no longer need the retained capture. Older versions or pictures kept only for this copy may be released; current drafts and waiting changes stay saved." });
		this.releaseCheck.onchange = () => this.controls();
		this.releaseButton = this.contentEl.createEl("button", { text: "Release retained capture", attr: { type: "button" } });
		this.releaseButton.onclick = () => { void this.releaseWork(); };
		const refresh = this.contentEl.createEl("button", { text: "Refresh storage usage", attr: { type: "button" } });
		refresh.onclick = () => { void this.refresh(); };
		const close = this.contentEl.createEl("button", { text: "Close", attr: { type: "button" } }); close.onclick = () => this.close();
		this.stop = this.session.onChange(() => {
			this.validate();
			if (!this.current() || this.timer !== undefined) return;
			this.timer = this.contentEl.ownerDocument.defaultView!.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
		});
		this.controls(); await this.refresh();
	}
	private controls(): void {
		if (!this.live) return;
		if (this.limit) this.limit.disabled = this.busy || !this.usage;
		if (this.save) this.save.disabled = this.busy || !this.usage || !this.dirty;
		if (this.clear) this.clear.disabled = this.busy || !this.usage?.cachedPictures;
		if (this.exportButton) { this.exportButton.disabled = this.busy || !this.usage; this.exportButton.setText(this.retained ? "Retry retained recovery copy" : "Save recovery copy"); }
		if (this.releaseCheck) this.releaseCheck.disabled = this.busy || !this.retained;
		if (this.releaseButton) this.releaseButton.disabled = this.busy || !this.retained || !this.releaseCheck?.checked;
	}
	private async refresh(): Promise<void> {
		if (!this.current() || this.busy) return;
		if (this.loading) { this.refreshAgain = true; return; }
		this.loading = true; const generation = ++this.generation;
		try {
			const [usage, retained] = await Promise.all([this.session.store.storageUsage(), this.session.store.localWorkSummary()]);
			if (!this.current() || generation !== this.generation) return;
			if (this.retained?.id !== retained?.id && this.releaseCheck) this.releaseCheck.checked = false;
			this.retained = retained;
			this.recoverySummary?.setText(retained ? `Retained capture from ${new Date(retained.createdAt).toLocaleString()}: ${retained.drafts} drafts, ${retained.operations} waiting changes, ${retained.actions} recovery records, ${retained.pictures} original pictures. Retry writes this captured version; later edits stay saved separately.` : "A new copy captures the work currently saved on this device. Interrupted copies remain available to retry after reopening this panel.");
			this.usage = usage;
			this.summary?.empty();
			this.summary?.createEl("p", { text: `Saved drafts: ${usage.drafts} · Waiting changes: ${usage.queued + usage.sending} · Needs review: ${usage.rejected + usage.review}` });
			this.summary?.createEl("p", { text: `Original pictures for saved work: ${usage.savedPictures} · ${size(usage.savedPictureBytes)}` });
			this.summary?.createEl("p", { text: `Downloaded pictures: ${usage.cachedPictures} · ${size(usage.cachedPictureBytes)} of ${size(usage.pictureCacheLimit)}` });
			if (this.limit && !this.dirty) {
				if (!Array.from(this.limit.options).some(option => option.value === String(usage.pictureCacheLimit))) this.limit.createEl("option", { text: size(usage.pictureCacheLimit), attr: { value: String(usage.pictureCacheLimit) } });
				this.limit.value = String(usage.pictureCacheLimit);
			}
		} catch { if (this.current() && generation === this.generation) this.status?.setText("Storage usage could not be read. Reopen this panel to retry."); }
		finally {
			this.loading = false; this.controls();
			if (this.refreshAgain) { this.refreshAgain = false; await this.refresh(); }
		}
	}
	private io(): LocalWorkIO {
		if (this.recoveryIO) return this.recoveryIO;
		const vault = this.app.vault;
		return {
			mkdir: async path => {
				let file = vault.getAbstractFileByPath(path);
				if (!file) { try { file = await vault.createFolder(path); } catch { file = vault.getAbstractFileByPath(path); } }
				if (!(file instanceof TFolder)) throw new Error("The local recovery folder is unavailable.");
			},
			write: async (path, text) => { await vault.create(path, text); },
			writeBinary: async (path, bytes) => { await vault.createBinary(path, bytes); },
			read: path => vault.adapter.read(path), readBinary: path => vault.adapter.readBinary(path),
		};
	}
	private async exportWork(): Promise<void> {
		if (!this.current() || this.busy || !this.usage) return;
		this.busy = true; this.generation++; this.controls();
		try {
			const path = await this.session.saveLocalWorkRecovery(this.io(), this.current, this.retained?.id,
				text => { if (this.current()) this.status?.setText(text); });
			if (this.current()) this.status?.setText(`Recovery copy verified and saved to ${path}. Current saved work is unchanged.`);
		} catch (error) {
			if (this.current()) this.status?.setText(`Recovery copy did not finish. Saved work is retained. ${error instanceof Error ? error.message : "Refresh this panel and retry."}`);
		} finally { this.busy = false; if (this.current()) { await this.refresh(); this.controls(); } }
	}
	private async releaseWork(): Promise<void> {
		if (!this.current() || this.busy || !this.retained || !this.releaseCheck?.checked) return;
		const id = this.retained.id;
		await this.change(() => this.session.releaseLocalWorkRecovery(id),
			"Retained capture released. Current saved work and files already written are unchanged.", false);
	}
	private async change(action: () => Promise<void>, success: string, savedLimit = true): Promise<void> {
		if (!this.current() || this.busy || !this.usage) return;
		this.busy = true; this.generation++; this.controls();
		try {
			await action(); if (!this.current()) return;
			if (savedLimit) this.dirty = false;
			this.status?.setText(success);
		} catch { if (this.current()) this.status?.setText("The storage change could not finish. Your saved work is retained. Refresh usage before retrying."); }
		finally { this.busy = false; if (this.current()) { await this.refresh(); this.controls(); } }
	}
	onClose(): void {
		this.live = false; this.stop?.(); this.stop = undefined;
		if (this.timer !== undefined) this.contentEl.ownerDocument.defaultView!.clearTimeout(this.timer);
		this.timer = undefined; this.contentEl.empty();
	}
}
