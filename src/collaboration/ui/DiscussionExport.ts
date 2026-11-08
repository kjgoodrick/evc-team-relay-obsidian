import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";
import type { LocalWorkIO } from "../LocalWorkRecovery";
import { commentArchiveIO } from "./CommentArchiveIO";

export class DiscussionExportModal extends Modal {
	private live = true;
	private busy = false;
	private stop?: () => void;
	private pictures?: HTMLInputElement;
	private save?: HTMLButtonElement;
	private status?: HTMLElement;
	constructor(app: App, private session: DiscussionSession, private scopeId: string, private label: string,
		private context: () => boolean, private io?: LocalWorkIO) { super(app); }
	private current = () => this.live && this.context() && this.session.status !== "closed";
	validate(): void { if (!this.current()) this.close(); else this.controls(); }
	onOpen(): void {
		this.setTitle("Export discussions");
		this.contentEl.createEl("p", { text: "Scope: " + this.label });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Bases is an Obsidian feature name.
		this.contentEl.createEl("p", { text: "Save posted comments, replies, reactions and edit/target history for this note, image or saved Bases view. Removed content, other views, note files and unsent drafts are excluded." });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Team Relay is the product name.
		this.contentEl.createEl("p", { text: "The archive is an unencrypted local copy in the Relay recovery folder, excluded from Team Relay sync. Other backup tools may copy it. Later removals or access changes do not erase exported files. Import is not available in this preview." });
		const label = this.contentEl.createEl("label");
		this.pictures = label.createEl("input", { attr: { type: "checkbox" } }); this.pictures.checked = true;
		label.createSpan({ text: " Include comment picture files (up to 100 MiB)" });
		this.contentEl.createEl("p", { text: "Includes sanitized comment pictures. Images embedded in notes and external image links remain references. Turn this off to save picture metadata without downloading files." });
		this.save = this.contentEl.createEl("button", { text: "Save discussion archive", attr: { type: "button" } });
		this.save.onclick = () => { void this.export(); };
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const close = this.contentEl.createEl("button", { text: "Close", attr: { type: "button" } }); close.onclick = () => this.close();
		this.stop = this.session.onChange(() => this.validate()); this.controls();
	}
	private controls(): void {
		if (this.save) this.save.disabled = this.busy || !this.session.canExport || !this.session.permission(this.scopeId)?.read;
		if (this.pictures) this.pictures.disabled = this.busy;
	}
	private async export(): Promise<void> {
		if (!this.current() || this.busy || !this.session.canExport || !this.session.permission(this.scopeId)?.read) return;
		this.busy = true; this.controls();
		try {
			const path = await this.session.saveDiscussionExport(this.scopeId, this.io ?? commentArchiveIO(this.app), this.current, this.pictures?.checked === true,
				text => { if (this.current()) this.status?.setText(text); });
			if (this.current()) this.status?.setText(`Discussion archive verified and saved to ${path}.`);
		} catch (error) {
			if (this.current()) this.status?.setText(`Export did not finish. Any partial folder is incomplete. ${error instanceof Error ? error.message : "Reconnect and retry."}`);
		} finally { this.busy = false; if (this.current()) this.controls(); }
	}
	onClose(): void { this.live = false; this.stop?.(); this.stop = undefined; this.contentEl.empty(); }
}
