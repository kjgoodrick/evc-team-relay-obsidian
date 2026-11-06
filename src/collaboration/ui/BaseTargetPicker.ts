import { Modal, type App } from "obsidian";
import { v4 as uuid } from "uuid";
import { isBaseProperty, type BaseTargetKind, type BaseRecordType } from "../DiscussionProtocol";
import type { BaseTargetSelection } from "../DiscussionSession";

export type BaseRecordChoice = { id: string; path: string; kind: BaseRecordType };
export type BaseRecordPage = { records: BaseRecordChoice[]; hasMore: boolean };
// Official file properties: https://obsidian.md/help/bases/syntax#File%20properties
const FILE_PROPERTIES = ["backlinks", "ctime", "embeds", "ext", "file", "folder", "links", "mtime", "name", "path", "properties", "size", "tags"];

/** Explicit fallback when the active layout has no contextual target adapter.
 * Record labels aid selection; only managed IDs and typed properties are saved.
 */
export class BaseTargetPicker extends Modal {
	private closed = false;
	private busy = false;
	private unsubscribe?: () => void;
	private kind!: HTMLSelectElement;
	private record!: HTMLSelectElement;
	private query!: HTMLInputElement;
	private recordFields!: HTMLElement;
	private propertyFields!: HTMLElement;
	private propertySource!: HTMLSelectElement;
	private propertyName!: HTMLInputElement;
	private suggestions!: HTMLDataListElement;
	private status!: HTMLElement;
	private accept!: HTMLButtonElement;
	private records = new Map<string, BaseRecordChoice>();
	constructor(app: App, private viewName: string,
		private search: (query: string) => BaseRecordPage,
		private properties: (recordId: string) => string[],
		private choose: (target: BaseTargetSelection) => Promise<boolean>,
		private available: (kind: BaseTargetKind) => boolean,
		private current: () => boolean, private subscribe: (listener: () => void) => () => void) { super(app); }
	onOpen(): void {
		this.setTitle("Choose discussion target");
		this.contentEl.classList.add("relay-base-target-picker");
		this.contentEl.createEl("p", { text: "Discussion view: " + this.viewName });
		this.kind = this.field("Target", this.contentEl.createEl("select"));
		for (const [value, label] of [["view", "Entire saved view"], ["item", "Row or card"], ["cell", "Cell or property on a record"], ["property", "Column or property header"]]) {
			const option = this.kind.createEl("option", { text: label, attr: { value } });
			option.disabled = !this.available(value as BaseTargetKind);
		}
		this.kind.value = Array.from(this.kind.options).find(option => !option.disabled)?.value ?? "";
		this.recordFields = this.contentEl.createDiv();
		this.recordFields.createEl("p", { text: "Choose the shared file represented by the row or card. This list includes files outside the view’s current filters." });
		this.query = this.field("Find shared file", this.recordFields.createEl("input", { attr: { type: "search" } }));
		this.record = this.field("Record", this.recordFields.createEl("select"));
		this.propertyFields = this.contentEl.createDiv();
		this.propertySource = this.field("Property source", this.propertyFields.createEl("select"));
		for (const value of ["note", "file"]) this.propertySource.createEl("option", { text: value === "note" ? "Note property" : "File property", attr: { value } });
		const listId = "relay-base-properties-" + uuid();
		this.propertyName = this.field("Property name", this.propertyFields.createEl("input", { attr: { type: "text", list: listId, maxlength: "512", placeholder: "status" } }));
		this.propertyFields.createEl("p", { text: "Use the property’s original name, without the note. or file. prefix. A renamed column’s display label may differ. Note properties are available only for Markdown records; choose a file property for other records." });
		this.suggestions = this.propertyFields.createEl("datalist", { attr: { id: listId } });
		this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
		this.accept = this.contentEl.createEl("button", { text: "Write comment", cls: "mod-cta" });
		this.kind.onchange = () => this.update();
		this.query.oninput = () => this.loadRecords();
		this.record.onchange = () => this.update();
		this.propertySource.onchange = () => this.update();
		this.propertyName.oninput = () => this.update();
		this.accept.onclick = () => { void this.submit(); };
		this.unsubscribe = this.subscribe(() => { if (!this.current()) this.close(); else this.update(); });
		this.loadRecords(); this.kind.focus();
	}
	private field<T extends HTMLElement>(label: string, element: T): T {
		const row = element.parentElement!.createDiv({ cls: "relay-base-target-field" }); row.append(element);
		const id = "relay-base-target-" + uuid(); element.id = id; element.setAttribute("aria-label", label);
		const heading = element.ownerDocument.createElement("label"); heading.htmlFor = id; heading.textContent = label;
		element.before(heading); return element;
	}
	private loadRecords(): void {
		if (this.closed || !this.current()) return;
		const previous = this.record.value, page = this.search(this.query.value);
		this.records = new Map(page.records.map(record => [record.id, record]));
		this.record.empty(); this.record.createEl("option", { text: "Choose a record…", attr: { value: "" } });
		for (const record of page.records) this.record.createEl("option", { text: record.path, attr: { value: record.id } });
		this.record.value = this.records.has(previous) ? previous : "";
		this.status.setText(page.hasMore ? "Showing the first 50 matching files. Narrow the search to find another record." : "");
		this.update();
	}
	private selectedTarget(): BaseTargetSelection | undefined {
		const type = this.kind.value;
		if (!["view", "item", "cell", "property"].includes(type) || !this.available(type as BaseTargetKind)) return;
		if (type === "view") return { type };
		const recordId = this.records.get(this.record.value)?.id;
		if (type === "item") return recordId ? { type, recordId } : undefined;
		const property = { source: this.propertySource.value, name: this.propertyName.value };
		if (!isBaseProperty(property) || !property.name.trim()) return;
		if (type === "cell" && property.source === "note" && this.records.get(this.record.value)?.kind !== "markdown") return;
		return type === "property" ? { type, property } : recordId ? { type: "cell", recordId, property } : undefined;
	}
	private update(): void {
		if (this.closed) return;
		this.recordFields.hidden = !["item", "cell"].includes(this.kind.value);
		this.propertyFields.hidden = !["cell", "property"].includes(this.kind.value);
		const noteProperties = this.kind.value !== "cell" || this.records.get(this.record.value)?.kind === "markdown";
		this.propertySource.options[0].disabled = !noteProperties;
		this.suggestions.empty();
		const names = this.propertySource.value === "file" ? FILE_PROPERTIES : noteProperties && this.records.has(this.record.value) ? this.properties(this.record.value) : [];
		for (const value of names.slice(0, 100)) this.suggestions.createEl("option", { attr: { value } });
		for (const field of [this.kind, this.query, this.record, this.propertySource, this.propertyName]) field.disabled = this.busy;
		this.accept.disabled = this.busy || !this.current() || !this.selectedTarget();
	}
	private async submit(): Promise<void> {
		const target = this.selectedTarget();
		if (this.closed || this.busy || !this.current() || !target) return;
		this.busy = true; this.update(); this.status.setText("Saving the discussion target…");
		try {
			if (await this.choose(target)) { this.close(); return; }
			if (!this.closed) this.status.setText("The target could not be saved. Check comment access and synchronization, then try again.");
		} catch {
			if (!this.closed) this.status.setText("The target could not be verified. Reconnect with comment access to this view and record, then try again.");
		} finally { this.busy = false; this.update(); }
	}
	onClose(): void { this.closed = true; this.unsubscribe?.(); this.contentEl.empty(); }
}
