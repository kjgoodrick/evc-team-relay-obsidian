import { Modal, type App } from "obsidian";

/** Explicit paste entry point also works when the OS selected another vault. */
export class OpenDiscussionLink extends Modal {
	private stopped = false;
	constructor(app: App, private navigate: (link: string, current: () => boolean) => Promise<void>) { super(app); }
	onOpen(): void {
		this.setTitle("Open comment link");
		const input = this.contentEl.createEl("input", { type: "text", attr: { "aria-label": "Comment link", placeholder: "Paste a comment link" } });
		const status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		const open = this.contentEl.createEl("button", { text: "Open discussion" });
		const cancel = this.contentEl.createEl("button", { text: "Cancel" }); cancel.onclick = () => this.close();
		const submit = () => {
			if (open.disabled || this.stopped) return; open.disabled = true; input.disabled = true; status.setText("Opening discussion…");
			void this.navigate(input.value, () => !this.stopped).then(() => { if (!this.stopped) this.close(); }).catch(error => {
				if (!this.stopped) { status.setText(error instanceof Error ? error.message : "The discussion could not be opened."); open.disabled = false; input.disabled = false; }
			});
		};
		open.onclick = submit; input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); submit(); } }; input.focus();
	}
	onClose(): void { this.stopped = true; this.contentEl.empty(); }
}
