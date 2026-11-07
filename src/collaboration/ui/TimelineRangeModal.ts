import { Modal, type App } from "obsidian";
import { parseTimelineRange, timelineRangeLabel, type HistoricalPoint, type TimelineRange } from "../TimelineRange";
import type { NativeTimelineContext } from "../../bases/NativeBasesSurface";

type Draft = Record<string, unknown>;
export type TimelineRangeFormState = Record<string, string | boolean>;
type Options = {
	viewName: string; context: NativeTimelineContext; draft?: Draft; issue?: string; state?: TimelineRangeFormState;
	lanes?: { id: string; label: string }[];
	current(): boolean; save(range: TimelineRange, lane: string): Promise<boolean>;
	pick(draft: Draft, precision: HistoricalPoint["precision"], state: TimelineRangeFormState): void; closed(): void;
};
const kinds: Record<TimelineRange["kind"], string> = { calendar: "Whole dates", instant: "Exact times", historical: "Historical dates", ordinal: "Sequence values" };
const object = (value: unknown): value is Draft => !!value && typeof value === "object" && !Array.isArray(value);

/** Explicit semantic confirmation. This form never modifies a task or view. */
export class TimelineRangeModal extends Modal {
	private controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
	private kind!: HTMLSelectElement;
	private lane!: HTMLSelectElement;
	private fields!: HTMLElement;
	private status!: HTMLElement;
	private accept!: HTMLButtonElement;
	private pickButton!: HTMLButtonElement;
	private saving = false;
	private closed = false;
	private picking = false;
	constructor(app: App, private options: Options) { super(app); }
	onOpen(): void {
		this.setTitle("Comment on a timeline range"); this.contentEl.classList.add("relay-timeline-range-dialog");
		this.contentEl.createEl("p", { text: "Discussion view: " + this.options.viewName + ". Choose the entire view or a supported lane. Commenting does not change task dates." });
		this.kind = this.select(this.contentEl, "kind", "Range type", this.options.context.kinds.map(value => [value, kinds[value]]));
		this.kind.value = this.options.context.kinds.includes(this.options.draft?.kind as TimelineRange["kind"]) ? String(this.options.draft!.kind) : this.options.context.kinds[0];
		this.lane = this.select(this.contentEl, "lane", "Range scope", [["", "Entire saved view"], ...(this.options.lanes ?? []).map(lane => [lane.id, lane.label])]);
		this.fields = this.contentEl.createDiv();
		this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
		this.pickButton = this.contentEl.createEl("button", { text: "Select endpoints on timeline", attr: { type: "button" } });
		this.accept = this.contentEl.createEl("button", { text: "Write comment", cls: "mod-cta", attr: { type: "button" } });
		this.contentEl.createEl("button", { text: "Cancel", attr: { type: "button" } }).onclick = () => this.close();
		this.kind.onchange = () => { this.render(); this.validate(); };
		this.accept.onclick = () => { void this.save(); };
		this.pickButton.onclick = () => {
			if (this.saving || !this.options.current()) { this.validate(); return; }
			const draft = this.draft(), precision = this.value("start-precision") as HistoricalPoint["precision"] || "day";
			const state = Object.fromEntries([...this.controls].map(([key, field]) => [key, field instanceof this.contentEl.ownerDocument.defaultView!.HTMLInputElement && field.type === "checkbox" ? field.checked : field.value]));
			this.picking = true; this.close(); this.options.pick(draft, precision, state);
		};
		this.render(this.options.draft);
		for (const [key, value] of Object.entries(this.options.state ?? {})) {
			const field = this.controls.get(key); if (!field) continue;
			if (typeof value === "boolean" && field.tagName === "INPUT") (field as HTMLInputElement).checked = value;
			else if (typeof value === "string") {
				if (key === "lane" && value && !Array.from(this.lane.options).some(option => option.value === value)) {
					const option = this.contentEl.ownerDocument.createElement("option"); option.value = value; option.textContent = "Selected lane is unavailable"; option.disabled = true; this.lane.append(option);
				}
				field.value = value;
			}
		}
		if (this.kind.value === "historical") { this.updatePrecision("start"); this.updatePrecision("end"); }
		this.validate();
		if (this.options.issue) this.status.textContent = this.options.issue + " Review the endpoints before continuing.";
	}
	private label(parent: HTMLElement, key: string, text: string, control: HTMLInputElement | HTMLSelectElement) {
		const label = parent.createEl("label", { text }); label.append(control); control.setAttribute("aria-label", text);
		control.dataset.field = key; this.controls.set(key, control); control.oninput = () => this.validate(); return control;
	}
	private input(parent: HTMLElement, key: string, text: string, value: unknown = "", type = "text"): HTMLInputElement {
		const input = parent.ownerDocument.createElement("input"); input.type = type; input.maxLength = 128; input.value = String(value ?? "");
		this.label(parent, key, text, input); return input;
	}
	private select(parent: HTMLElement, key: string, text: string, choices: readonly (readonly string[])[]): HTMLSelectElement {
		const select = parent.ownerDocument.createElement("select");
		for (const [value, label] of choices) { const option = parent.ownerDocument.createElement("option"); option.value = value; option.textContent = label; select.append(option); }
		this.label(parent, key, text, select); return select;
	}
	private render(seed?: Draft): void {
		this.fields.replaceChildren(); this.controls.clear(); this.controls.set("kind", this.kind); this.controls.set("lane", this.lane);
		const kind = this.kind.value;
		for (const endpoint of ["start", "end"] as const) {
			const name = endpoint === "start" ? "Start" : "End", section = this.fields.createEl("fieldset"); section.createEl("legend", { text: name });
			if (kind === "historical") {
				const point = object(seed?.[endpoint]) ? seed![endpoint] as Draft : {};
				const precision = this.select(section, endpoint + "-precision", name + " precision", [["year", "Year"], ["month", "Month"], ["day", "Day"]]);
				precision.value = ["year", "month", "day"].includes(String(point.precision)) ? String(point.precision) : "year";
				const year = typeof point.year === "number" ? point.year : new Date().getUTCFullYear();
				const era = this.select(section, endpoint + "-era", name + " era", [["ce", "CE"], ["bce", "BCE"]]); era.value = year <= 0 ? "bce" : "ce";
				this.input(section, endpoint + "-year", name + " year", year <= 0 ? 1 - year : year);
				this.input(section, endpoint + "-month", name + " month", point.month ?? 1);
				this.input(section, endpoint + "-day", name + " day", point.day ?? 1);
				precision.onchange = () => { this.updatePrecision(endpoint); this.validate(); }; this.updatePrecision(endpoint);
			} else this.input(section, endpoint, name + (kind === "calendar" ? " date" : kind === "instant" ? " time with UTC offset" : " value"), seed?.[endpoint]);
			const inclusive = this.input(section, endpoint + "-inclusive", "Include " + endpoint + (kind === "calendar" || kind === "historical" ? " period" : " point"), "", "checkbox");
			inclusive.checked = seed?.[endpoint + "_inclusive"] !== false;
		}
		if (kind === "calendar" || kind === "instant") this.fields.createEl("p", { text: "Timezone: " + this.options.context.effectiveTimeZone + ". " +
			(kind === "calendar" ? "Use YYYY-MM-DD. Included endpoints cover the whole day." : "Use YYYY-MM-DDTHH:mm:ss with Z or an explicit offset such as -06:00. Repeated daylight-saving times require an explicit offset.") });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- CE/BCE and Gregorian are standard date terms.
		if (kind === "historical") this.fields.createEl("p", { text: "Use positive years with CE or BCE. Included endpoints cover the entire selected year, month, or day. Month and day use the Gregorian calendar." });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Sequence is the renderer's proper name.
		if (kind === "ordinal") this.fields.createEl("p", { text: "Use original Sequence property values, including decimals. Visual positions in a compact view do not replace these values." });
	}
	private updatePrecision(endpoint: string): void {
		const precision = this.value(endpoint + "-precision");
		for (const field of ["month", "day"]) this.controls.get(endpoint + "-" + field)!.parentElement!.hidden = precision === "year" || field === "day" && precision === "month";
	}
	private value(key: string): string { return this.controls.get(key)?.value ?? ""; }
	draft(): Draft {
		const kind = this.kind.value, point = (endpoint: string) => {
			if (kind !== "historical") return this.value(endpoint).trim();
			const number = (field: string) => /^[0-9]+$/.test(this.value(endpoint + "-" + field).trim()) ? Number(this.value(endpoint + "-" + field)) : NaN;
			const year = number("year"), precision = this.value(endpoint + "-precision");
			return { precision, year: year > 0 ? this.value(endpoint + "-era") === "bce" ? 1 - year : year : NaN,
				...(precision !== "year" ? { month: number("month") } : {}), ...(precision === "day" ? { day: number("day") } : {}) };
		};
		return { version: 1, kind, start: point("start"), end: point("end"),
			start_inclusive: (this.controls.get("start-inclusive") as HTMLInputElement).checked,
			end_inclusive: (this.controls.get("end-inclusive") as HTMLInputElement).checked,
			...(kind === "calendar" || kind === "instant" ? { time_zone: this.options.context.effectiveTimeZone } :
				kind === "ordinal" ? { unit: "property-value" } : { calendar: "proleptic-gregorian", year_numbering: "astronomical" }) };
	}
	validate(): void {
		if (this.closed || !this.accept) return;
		const current = this.options.current(); this.pickButton.disabled = this.saving || !current;
		for (const control of this.controls.values()) control.disabled = this.saving;
		if (!current) { this.accept.disabled = true; this.status.textContent = "This view or your access changed. Your entered values remain here; close and reselect the target when ready."; return; }
		try { const range = parseTimelineRange(this.draft()); this.accept.disabled = this.saving; this.status.textContent = timelineRangeLabel(range); }
		catch { this.accept.disabled = true; this.status.textContent = "Enter valid, ordered endpoints. Check dates, precision, time offsets, and which endpoints are included."; }
	}
	private async save(): Promise<void> {
		if (this.closed || this.saving || !this.options.current()) { this.validate(); return; }
		let range: TimelineRange; try { range = parseTimelineRange(this.draft()); } catch { this.validate(); return; }
		this.saving = true; this.validate();
		try { if (await this.options.save(range, this.lane.value)) { this.close(); return; } if (!this.closed) this.status.textContent = "The target could not be saved. Your values are retained; check synchronization and access, then try again."; }
		catch (error) { if (!this.closed) this.status.textContent = error instanceof Error ? error.message : "The target could not be saved. Your values are retained."; }
		finally { this.saving = false; if (!this.closed) { const message = this.status.textContent; this.validate(); if (this.options.current()) this.status.textContent = message; } }
	}
	onClose(): void { this.closed = true; this.contentEl.empty(); if (!this.picking) this.options.closed(); }
}
