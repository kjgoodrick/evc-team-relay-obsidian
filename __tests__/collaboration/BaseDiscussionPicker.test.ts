/** @jest-environment jsdom */
import type { App } from "obsidian";
import { BaseDiscussionPicker, type BaseDiscussionChoices } from "../../src/collaboration/ui/BaseDiscussionPicker";
import { BaseTargetPicker, type BaseRecordPage } from "../../src/collaboration/ui/BaseTargetPicker";

jest.mock("obsidian", () => ({ Modal: class {
	// The native host retains its prior DOM selection on this own property.
	selection = null;
	contentEl = document.createElement("div"); setTitle() {} close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find(button => button.textContent === text)!;
const change = (el: HTMLSelectElement | HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); };

test("saved-view selection is explicit, defers paging until current associations arrive and uses stable IDs", async () => {
	let finish!: (page: BaseDiscussionChoices) => void;
	const load = jest.fn<Promise<BaseDiscussionChoices>, [state?: "unmatched" | "archived", after?: string]>()
		.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
		.mockResolvedValue({ choices: [{ id: id(2), name: "Old", type: "table", state: "archived" }] });
	const choose = jest.fn().mockResolvedValue(undefined), unsubscribe = jest.fn();
	const modal = new BaseDiscussionPicker({} as App, load, choose, () => true, () => unsubscribe);
	try {
		modal.onOpen();
		expect(button(modal.contentEl, "Load archived views").disabled).toBe(true);
		finish({ choices: [{ id: id(1), name: "Planning", type: "table", state: "active" }] }); await flush();
		expect(button(modal.contentEl, "Open discussions").disabled).toBe(true);
		button(modal.contentEl, "Load archived views").click(); await flush();
		expect(load).toHaveBeenLastCalledWith("archived", undefined);
		change(modal.contentEl.querySelector("select")!, id(2)); button(modal.contentEl, "Open discussions").click(); await flush();
		expect(choose).toHaveBeenCalledWith({ id: id(2), name: "Old", type: "table", state: "archived" });
		expect(modal.contentEl.childElementCount).toBe(0); expect(unsubscribe).toHaveBeenCalled();
	} finally { modal.onClose(); }
});

test("account or file changes close a view chooser and discard late results", async () => {
	let current = true, changed!: () => void, finish!: (page: BaseDiscussionChoices) => void;
	const choose = jest.fn(), modal = new BaseDiscussionPicker({} as App, () => new Promise(resolve => { finish = resolve; }), choose,
		() => current, listener => { changed = listener; return () => {}; });
	modal.onOpen(); current = false; changed();
	finish({ choices: [{ id: id(1), name: "Old account", type: "table", state: "active" }] }); await flush();
	expect(modal.contentEl.childElementCount).toBe(0); expect(choose).not.toHaveBeenCalled();
});

function targets() {
	let current = true, allowed = true, changed!: () => void;
	const choose = jest.fn().mockResolvedValue(true), unsubscribe = jest.fn();
	const search = jest.fn((query: string): BaseRecordPage => ({ records: query === "absent" ? [] : [{ id: id(3), path: "Projects/Plan.md", kind: "markdown" }], hasMore: false }));
	const modal = new BaseTargetPicker({} as App, "Planning", search, () => ["Stage", "Owner"], choose, () => allowed,
		() => current, listener => { changed = listener; return unsubscribe; });
	modal.onOpen();
	const field = (label: string) => modal.contentEl.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
	return { modal, choose, search, field, unsubscribe, changed: () => changed(), setCurrent: (value: boolean) => { current = value; }, setAllowed: (value: boolean) => { allowed = value; } };
}

test("cell and header targets use explicit record identity and the exact typed property, never a display label or row offset", async () => {
	const s = targets();
	try {
		expect(Array.from((s.field("Target") as HTMLSelectElement).options).every(option => !option.disabled)).toBe(true);
		change(s.field("Target"), "cell");
		expect(button(s.modal.contentEl, "Write comment").disabled).toBe(true);
		change(s.field("Record"), id(3)); change(s.field("Property name"), "ステータス");
		expect(button(s.modal.contentEl, "Write comment").disabled).toBe(false);
		expect([...s.modal.contentEl.querySelectorAll("datalist option")].map(option => option.getAttribute("value"))).toEqual(["Stage", "Owner"]);
		button(s.modal.contentEl, "Write comment").click(); await flush();
		expect(s.choose).toHaveBeenCalledWith({ type: "cell", recordId: id(3), property: { source: "note", name: "ステータス" } });
	} finally { s.modal.onClose(); }
	const header = targets();
	try {
		change(header.field("Target"), "property"); change(header.field("Property source"), "file"); change(header.field("Property name"), "name");
		button(header.modal.contentEl, "Write comment").click(); await flush();
		expect(header.choose).toHaveBeenCalledWith({ type: "property", property: { source: "file", name: "name" } });
	} finally { header.modal.onClose(); }
});

test("filtering out a selected record, unsupported capabilities or changed context cannot create a stale target", async () => {
	const s = targets();
	try {
		change(s.field("Target"), "item"); change(s.field("Record"), id(3));
		change(s.field("Find shared file"), "absent");
		expect(s.field("Record").value).toBe(""); expect(button(s.modal.contentEl, "Write comment").disabled).toBe(true);
		change(s.field("Target"), "view"); s.setAllowed(false); s.changed();
		expect(button(s.modal.contentEl, "Write comment").disabled).toBe(true);
		s.setCurrent(false); s.changed();
		expect(s.modal.contentEl.childElementCount).toBe(0); expect(s.choose).not.toHaveBeenCalled();
	} finally { s.modal.onClose(); }
});

test("capture failure keeps the chosen target editable and prevents duplicate simultaneous submissions", async () => {
	const s = targets(); let fail!: (error: Error) => void;
	try {
		s.choose.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
		const send = button(s.modal.contentEl, "Write comment"); send.click(); send.click();
		expect(s.choose).toHaveBeenCalledTimes(1); expect(s.field("Target").disabled).toBe(true);
		fail(new Error("Denied")); await flush();
		expect(s.modal.contentEl.textContent).toContain("could not be verified"); expect(send.disabled).toBe(false);
		expect(s.field("Target").value).toBe("view");
	} finally { s.modal.onClose(); }
});


test("attachment cells require an explicit file property without changing a chosen note property", async () => {
	const s = targets();
	try {
		s.search.mockReturnValue({ records: [{ id: id(4), path: "Assets/chart.png", kind: "image" }], hasMore: false });
		change(s.field("Find shared file"), "chart"); change(s.field("Target"), "cell"); change(s.field("Record"), id(4));
		change(s.field("Property name"), "name");
		expect(s.field("Property source").value).toBe("note");
		expect((s.field("Property source") as HTMLSelectElement).options[0].disabled).toBe(true);
		expect(button(s.modal.contentEl, "Write comment").disabled).toBe(true);
		change(s.field("Property source"), "file");
		expect([...s.modal.contentEl.querySelectorAll("datalist option")].map(option => option.getAttribute("value"))).toContain("size");
		button(s.modal.contentEl, "Write comment").click(); await flush();
		expect(s.choose).toHaveBeenCalledWith({ type: "cell", recordId: id(4), property: { source: "file", name: "name" } });
	} finally { s.modal.onClose(); }
});
