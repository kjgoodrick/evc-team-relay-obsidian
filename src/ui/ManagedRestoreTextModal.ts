import { App, Modal, Setting } from "obsidian";
import { diffWordsWithSpace } from "diff";
import type { VaultShare } from "../VaultShare";
import type { ManagedRestoreInspection } from "../client/ManagedIndexTransport";
import type { ManagedRestoreText } from "../client/ManagedRestoreText";

const PAGE_CHARS = 16_000;

/** Captured text only: no apply, merge, source write or activation action. */
export class ManagedRestoreTextModal extends Modal {
	private opened = false;
	private serial = 0;
	private abort?: AbortController;
	private detachAuth?: () => void;
	private current?: ManagedRestoreText;
	private busy = false;
	private error = "";
	private selected = 0;
	private page = 0;
	private readonly changed = () => this.invalidate("The account or inventory changed. Close this window and refresh the inventory comparison.");
	private readonly visibility = () => { if (this.contentEl.ownerDocument.hidden) this.invalidate("Source comparison paused while this window is hidden."); };
	constructor(app: App, private share: VaultShare, private inspection: ManagedRestoreInspection, private entryId: string) { super(app); }
	onOpen(): void {
		this.opened = true; this.contentEl.addClass("evc-restore-text");
		this.detachAuth = this.share.authSession?.on(this.changed);
		this.share.crdtDoc.getMap("managed_base_v1").observe(this.changed); this.share.crdtDoc.getMap("filemeta_v0").observe(this.changed);
		this.contentEl.ownerDocument.addEventListener("visibilitychange", this.visibility);
		void this.load();
	}
	onClose(): void {
		this.opened = false; this.serial++; this.abort?.abort(); this.abort = undefined; this.current = undefined; this.busy = false;
		this.detachAuth?.(); this.detachAuth = undefined;
		this.share.crdtDoc.getMap("managed_base_v1").unobserve(this.changed); this.share.crdtDoc.getMap("filemeta_v0").unobserve(this.changed);
		this.contentEl.ownerDocument.removeEventListener("visibilitychange", this.visibility); this.contentEl.empty();
	}
	private invalidate(message: string): void {
		if (!this.opened) return;
		this.serial++; this.abort?.abort(); this.abort = undefined; this.current = undefined; this.busy = false; this.error = message; this.render();
	}
	private async load(): Promise<void> {
		if (!this.opened || this.busy) return;
		if (this.contentEl.ownerDocument.hidden) { this.invalidate("Show this window before refreshing the source comparison."); return; }
		const serial = ++this.serial, abort = new AbortController(); this.abort = abort;
		this.current = undefined; this.busy = true; this.error = ""; this.selected = 0; this.page = 0; this.render();
		try {
			const current = await this.share.inspectManagedRestoreText(this.inspection, this.entryId, abort.signal);
			if (!this.opened || serial !== this.serial) return;
			current.check(); this.current = current;
		} catch (error) { if (this.opened && serial === this.serial) this.error = error instanceof Error ? error.message : String(error); }
		finally { if (this.opened && serial === this.serial) { this.busy = false; this.render(); } }
	}
	private render(): void {
		if (!this.opened) return;
		try { this.current?.check(); }
		catch { this.current = undefined; this.error = "The connection or review changed. Close this window and refresh the inventory comparison."; }
		this.contentEl.empty(); this.contentEl.createEl("h2", { text: "Compare retained and restored text" });
		this.contentEl.createEl("p", { text: "These are captured text versions. Editing histories stay separate, files stay unchanged, and synchronization stays paused. Later edits require a fresh comparison." });
		if (this.error) this.contentEl.createEl("p", { text: this.error, cls: "mod-warning", attr: { role: "alert" } });
		new Setting(this.contentEl).setName("Refresh captured text").addButton(button => button.setButtonText(this.busy ? "Loading text…" : "Refresh text").setDisabled(this.busy).onClick(() => this.load()));
		const current = this.current;
		if (!current) return;
		this.contentEl.createEl("h3", { text: current.serverPath });
		this.contentEl.createEl("p", { text: `Server text read ${new Date(current.capturedAt).toLocaleString()}; retained local text was read before that download.` });
		for (const [index, source] of current.local.entries()) new Setting(this.contentEl).setName(source.label)
			.addButton(button => button.setButtonText(index === this.selected ? "Selected" : "Compare this text").setDisabled(index === this.selected).onClick(() => { this.selected = index; this.page = 0; this.render(); }));
		const local = current.local[this.selected];
		if (!local) this.contentEl.createEl("p", { text: "No text for this entry was found in the retained local inventory. The server snapshot is shown below." });
		else if (local.text === current.serverText) this.contentEl.createEl("p", { text: "The captured texts are identical. This does not establish that their editing histories are interchangeable." });
		else {
			const changes = local.text.length + current.serverText.length <= 48_000
				? diffWordsWithSpace(local.text, current.serverText, { timeout: 20, maxEditLength: 500 }) : undefined;
			if (changes) {
				this.contentEl.createEl("h3", { text: "Changes from local text to server text" });
				this.contentEl.createEl("p", { text: "Underlined text is added on the server; struck-through text occurs only in the local version." });
				const diff = this.contentEl.createEl("pre", { cls: "evc-restore-text-diff" });
				for (const change of changes) diff.createEl(change.added ? "ins" : change.removed ? "del" : "span", { text: change.value, cls: change.added ? "evc-restore-text-added" : change.removed ? "evc-restore-text-removed" : "" });
			} else this.contentEl.createEl("p", { text: "Large or very different texts are shown without highlighting. Both captured texts remain available below." });
		}
		const pages = Math.max(1, Math.ceil(Math.max(local?.text.length ?? 0, current.serverText.length) / PAGE_CHARS));
		this.page = Math.min(this.page, pages - 1);
		if (pages > 1) new Setting(this.contentEl).setName(`Text page ${this.page + 1} of ${pages}`)
			.addButton(button => button.setButtonText("Previous text page").setDisabled(this.page === 0).onClick(() => { this.page--; this.render(); }))
			.addButton(button => button.setButtonText("Next text page").setDisabled(this.page + 1 >= pages).onClick(() => { this.page++; this.render(); }));
		const grid = this.contentEl.createDiv({ cls: "evc-restore-text-grid" });
		for (const source of [...(local ? [local] : []), { label: "Restored server text", text: current.serverText }]) {
			const pane = grid.createDiv(); pane.createEl("h3", { text: source.label });
			pane.createEl("pre", { text: source.text.slice(this.page * PAGE_CHARS, (this.page + 1) * PAGE_CHARS) || "(No text on this page)", attr: { tabindex: "0", "aria-label": source.label } });
		}
	}
}
