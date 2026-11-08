import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import type { LocalWorkIO } from "../LocalWorkRecovery";
import { commentArchiveIO } from "./CommentArchiveIO";

export class DiscussionExportModal extends Modal {
	private live = true;
	private busy = false;
	private stop?: () => void;
	private pictures?: HTMLInputElement;
	private scopeSelect?: HTMLSelectElement;
	private scopeSummary?: HTMLElement;
	private limitSummary?: HTMLElement;
	private wholeFolder = false;
	private save?: HTMLButtonElement;
	private status?: HTMLElement;
	constructor(app: App, private session: DiscussionSession, private scopeId: string | undefined, private label: string,
		private context: () => boolean, private io?: LocalWorkIO) { super(app); }
	private current = () => this.live && this.context() && this.session.status !== "closed";
	validate(): void { if (!this.current()) this.close(); else this.controls(); }
	onOpen(): void {
		this.setTitle("Export discussions");
		this.wholeFolder = this.scopeId === undefined;
		this.scopeSummary = this.contentEl.createEl("p");
		if (this.scopeId && this.session.canExportCollection) {
			const scopeLabel = this.contentEl.createEl("label", { text: "Export scope " });
			this.scopeSelect = scopeLabel.createEl("select", { attr: { "aria-label": "Export scope" } });
			this.scopeSelect.createEl("option", { text: "Current note or saved view", attr: { value: "current" } });
			this.scopeSelect.createEl("option", { text: "All readable discussions in this shared folder", attr: { value: "folder" } });
			this.scopeSelect.onchange = () => { this.wholeFolder = this.scopeSelect?.value === "folder"; this.controls(); };
		}
		this.contentEl.createEl("p", { text: "Save posted comments, replies, reactions and edit/target history for the selected scope. Removed content, note files and unsent drafts are excluded." });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Team Relay is the product name.
		this.contentEl.createEl("p", { text: "The archive is an unencrypted local copy in the Relay recovery folder, excluded from Team Relay sync. Other backup tools may copy it. Later removals or access changes do not erase exported files. Import is not available in this preview." });
		const label = this.contentEl.createEl("label");
		this.pictures = label.createEl("input", { attr: { type: "checkbox" } }); this.pictures.checked = true;
		label.createSpan({ text: " Include comment picture files" });
		this.contentEl.createEl("p", { text: "Includes sanitized comment pictures. Images embedded in notes and external image links remain references. Turn this off to save picture metadata without downloading files." });
		this.limitSummary = this.contentEl.createEl("p");
		this.contentEl.createEl("p", { text: "A whole-folder export captures its readable scope list first, then each scope separately. Changes during export can appear in later captures; this is not an atomic backup. Unavailable scopes or selected pictures stop completion." });
		this.save = this.contentEl.createEl("button", { text: "Save discussion archive", attr: { type: "button" } });
		this.save.onclick = () => { void this.export(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const close = this.contentEl.createEl("button", { text: "Close", attr: { type: "button" } }); close.onclick = () => this.close();
		this.stop = this.session.onChange(() => this.validate()); this.controls();
	}
	private allowed(): boolean { return this.wholeFolder ? this.session.canExportCollection : !!this.scopeId && this.session.canExport && this.session.permission(this.scopeId)?.read === true; }
	private controls(): void {
		this.scopeSummary?.setText("Scope: " + (this.wholeFolder ? "All readable discussions in this shared folder" : this.label));
		this.limitSummary?.setText(this.wholeFolder ? "Up to 256 discussion scopes, 64 MiB of metadata and 250 MiB of picture files in the collection; each scope has a 100 MiB picture limit." : "Includes only this note, image or saved view. Up to 100 MiB of picture files; other saved views are excluded.");
		if (this.scopeSelect) this.scopeSelect.disabled = this.busy;
		if (this.save) this.save.disabled = this.busy || !this.allowed();
		if (this.pictures) this.pictures.disabled = this.busy;
	}
	private async export(): Promise<void> {
		if (!this.current() || this.busy || !this.allowed()) return;
		this.busy = true; this.controls();
		try {
			const progress = (text: string) => { if (this.current()) this.status?.setText(text); };
			const io = this.io ?? commentArchiveIO(this.app), pictures = this.pictures?.checked === true;
			const path = this.wholeFolder ? await this.session.saveDiscussionCollection(io, this.current, pictures, progress) :
				await this.session.saveDiscussionExport(this.scopeId!, io, this.current, pictures, progress);
			if (this.current()) this.status?.setText(`Discussion archive verified and saved to ${path}.`);
		} catch (error) {
			if (this.current()) this.status?.setText(`Export did not finish. Any partial folder is incomplete. ${error instanceof Error ? error.message : "Reconnect and retry."}`);
		} finally { this.busy = false; if (this.current()) this.controls(); }
	}
	onClose(): void { this.live = false; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
