/** Selects the embedded surface the user actually interacted with. Clicking
 * elsewhere in its note returns presence to that note; sidebar controls retain
 * the selection. No selection is inferred from renderer order. */
export class EmbeddedBaseFocus<T extends { contentEl: HTMLElement }> {
	private entries: { parent: T; view: T; current: () => boolean }[] = [];
	private selected?: { parent: T; view: T; current: () => boolean };
	private documents = new Map<Document, () => void>();
	constructor(private changed: () => void) {}
	set(entries: { parent: T; view: T; current: () => boolean }[]): void {
		this.entries = entries;
		if (this.selected && !entries.some(entry => entry.view === this.selected?.view)) this.selected = undefined;
		const docs = new Set(entries.map(entry => entry.parent.contentEl.ownerDocument));
		for (const [doc, stop] of this.documents) if (!docs.has(doc)) { stop(); this.documents.delete(doc); }
		for (const doc of docs) if (!this.documents.has(doc)) {
			const interacted = (event: Event) => {
				const target = event.target as Node | null; if (!target?.nodeType) return;
				const next = this.entries.find(entry => entry.current() && entry.view.contentEl.contains(target));
				if (!next && !this.selected?.parent.contentEl.contains(target)) return;
				if (this.selected?.view === next?.view) return;
				this.selected = next; this.changed();
			};
			for (const event of ["pointerdown", "focusin"]) doc.addEventListener(event, interacted, true);
			this.documents.set(doc, () => { for (const event of ["pointerdown", "focusin"]) doc.removeEventListener(event, interacted, true); });
		}
	}
	active(parent: T | null | undefined): T | undefined {
		if (this.selected && (this.selected.parent !== parent || !this.selected.current())) this.selected = undefined;
		return this.selected?.view;
	}
	close(): void { for (const stop of this.documents.values()) stop(); this.documents.clear(); this.entries = []; this.selected = undefined; }
}
