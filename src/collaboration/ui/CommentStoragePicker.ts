import { Modal, type App } from "obsidian";
import type { DiscussionSession } from "../DiscussionSession";

export type CommentStorageSource = { session: DiscussionSession; label: string };
const key = (source: CommentStorageSource) => JSON.stringify(source.session.identity);

/** Local saved work is reachable without any surviving/readable note. The host
 * supplies only the currently signed-in account's connected folder sessions. */
export class CommentStoragePicker extends Modal {
	private live = true;
	private select?: HTMLSelectElement;
	private signature = "";
	constructor(app: App, private sources: () => CommentStorageSource[], private choose: (session: DiscussionSession) => void) { super(app); }
	onOpen(): void {
		this.setTitle("Choose comment storage");
		this.contentEl.createEl("p", { text: "Choose a connected shared folder to review local storage and save recovery copies. The original note does not need to be open or available." });
		const label = this.contentEl.createEl("label", { text: "Shared folder " });
		this.select = label.createEl("select", { attr: { "aria-label": "Shared folder for local comment storage" } });
		const open = this.contentEl.createEl("button", { text: "Open storage", attr: { type: "button" } });
		open.onclick = () => {
			if (!this.live) return;
			const chosen = this.sources().find(source => key(source) === this.select?.value);
			if (!chosen) { this.validate(); return; }
			this.close(); this.choose(chosen.session);
		};
		const cancel = this.contentEl.createEl("button", { text: "Cancel", attr: { type: "button" } }); cancel.onclick = () => this.close();
		this.validate();
	}
	validate(): void {
		if (!this.live || !this.select) return;
		const sources = this.sources(); if (!sources.length) { this.close(); return; }
		if (this.select.value && !sources.some(source => key(source) === this.select!.value)) { this.close(); return; }
		const signature = JSON.stringify(sources.map(source => [key(source), source.label])); if (signature === this.signature) return;
		this.signature = signature;
		const selected = this.select.value; this.select.empty();
		for (const source of sources) this.select.createEl("option", { text: source.label, attr: { value: key(source) } });
		if (sources.some(source => key(source) === selected)) this.select.value = selected;
	}
	onClose(): void { this.live = false; this.contentEl.empty(); }
}
