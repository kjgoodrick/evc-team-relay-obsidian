import { Modal, type App } from "obsidian";

export type BaseDiscussionChoice = { id: string; name: string; type: string; state: "active" | "unmatched" | "archived" };
export type BaseDiscussionChoices = { choices: BaseDiscussionChoice[]; message?: string; next?: string };

/** Explicit saved-view choice is also the fallback for layouts without an adapter. */
export class BaseDiscussionPicker extends Modal {
	private closed = false;
	private generation = 0;
	private select?: HTMLSelectElement;
	private status?: HTMLElement;
	private accept?: HTMLButtonElement;
	private choices = new Map<string, BaseDiscussionChoice>();
	private next = new Map<string, string | undefined>();
	private pageButtons: HTMLButtonElement[] = [];
	private unsubscribe?: () => void;
	constructor(app: App, private load: (state?: "unmatched" | "archived", after?: string) => Promise<BaseDiscussionChoices>,
		private choose: (choice: BaseDiscussionChoice) => Promise<void>, private current: () => boolean,
		private subscribe: (listener: () => void) => () => void) { super(app); }
	onOpen(): void {
		this.setTitle("Choose a discussion view");
		this.contentEl.createEl("p", { text: "Comments stay with the saved view chosen here. Switching the Bases layout does not move them to another view." });
		this.select = this.contentEl.createEl("select", { attr: { "aria-label": "Saved discussion view" } });
		this.select.createEl("option", { text: "Choose a saved view…", attr: { value: "" } });
		this.select.onchange = () => { if (this.accept) this.accept.disabled = !this.choices.has(this.select!.value); };
		this.status = this.contentEl.createDiv({ attr: { role: "status" } });
		for (const state of ["unmatched", "archived"] as const) {
			const more = this.contentEl.createEl("button", { text: state === "archived" ? "Load archived views" : "Load more unassociated views" });
			more.disabled = true; this.pageButtons.push(more);
			more.onclick = () => { void this.more(state, more); };
		}
		this.accept = this.contentEl.createEl("button", { text: "Open discussions", cls: "mod-cta" });
		this.accept.disabled = true;
		this.accept.onclick = () => {
			const choice = this.choices.get(this.select!.value); if (!choice || !this.current()) return;
			this.accept!.disabled = true;
			void this.choose(choice).then(() => this.close()).catch(() => { if (!this.closed) { this.status!.setText("This view could not be selected. Refresh the shared file and try again."); this.accept!.disabled = false; } });
		};
		this.unsubscribe = this.subscribe(() => { if (!this.current()) this.close(); });
		void this.more();
	}
	private async more(state?: "unmatched" | "archived", button?: HTMLButtonElement): Promise<void> {
		const generation = this.generation;
		if (button) button.disabled = true;
		try {
			const page = await this.load(state, state ? this.next.get(state) : undefined);
			if (this.closed || generation !== this.generation || !this.current()) return;
			for (const choice of page.choices) {
				if (this.choices.has(choice.id)) continue;
				this.choices.set(choice.id, choice);
				this.select!.createEl("option", { text: `${choice.name} · ${choice.type}${choice.state === "active" ? "" : " · " + (choice.state === "unmatched" ? "unassociated" : "archived")}`, attr: { value: choice.id } });
			}
			this.status!.setText(page.message ?? (this.choices.size ? "Choose the view whose discussion you want to open." : "No associated saved views are available. Review this file’s saved-view associations first."));
			if (!state) this.pageButtons.forEach(control => { control.disabled = false; });
			if (state) this.next.set(state, page.next);
			if (button) { button.disabled = !page.next; if (page.next) button.setText("Load more " + (state === "unmatched" ? "unassociated" : "archived") + " views"); }
		} catch {
			if (!this.closed) { this.status!.setText("Saved views could not be loaded. Check synchronization and access, then reopen this chooser."); if (button) button.disabled = false; }
		}
	}
	onClose(): void { this.closed = true; this.generation++; this.unsubscribe?.(); this.contentEl.empty(); }
}
