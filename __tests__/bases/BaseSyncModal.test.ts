/** @jest-environment jsdom */
import type { App } from "obsidian";
import type { VaultShare } from "../../src/VaultShare";
import type { AttachmentFile } from "../../src/AttachmentFile";
import type { BaseSyncHost, BaseSyncRow } from "../../src/bases/BaseSyncHost";
import { BaseSyncModal } from "../../src/bases/BaseSyncModal";
import type { BaseConflictReview } from "../../src/bases/BaseSyncRunner";
import { TextEncoder, TextDecoder } from "node:util";
Object.assign(globalThis, { TextEncoder, TextDecoder });

jest.mock("../../src/bases/BaseSyncHost", () => ({ baseSyncMessage: (error: Error) => error.message }));
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => {
	const enhance = (element: HTMLElement) => Object.assign(element, {
		empty() { element.replaceChildren(); }, addClass(name: string) { element.classList.add(name); },
		createEl(tag: string, options: { text?: string; attr?: Record<string, string> }) {
			const child = document.createElement(tag); child.textContent = options.text ?? "";
			for (const [name, value] of Object.entries(options.attr ?? {})) child.setAttribute(name, value);
			element.append(child); return child;
		},
	});
	class Setting {
		constructor(private element: HTMLElement) {}
		setName(text: string) { this.element.append(document.createTextNode(text)); return this; }
		setDesc(text: string) { this.element.append(document.createTextNode(text)); return this; }
		addButton(configure: (value: unknown) => void) {
			const button = document.createElement("button"); this.element.append(button);
			const api = { setButtonText(text: string) { button.textContent = text; return api; }, setDisabled(value: boolean) { button.disabled = value; return api; },
				onClick(handler: () => void) { button.onclick = handler; return api; } };
			configure(api); return this;
		}
	}
	return { Modal: class { contentEl = enhance(document.createElement("div")); }, Setting };
});
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
function fixture() {
	const file = {} as AttachmentFile, row = { entryId: "entry", path: "Planning.base", file, message: "Review needed", record: { entryId: "entry", revision: 3, reviewRequired: "withdrawn" } } as BaseSyncRow;
	const review = { record: row.record, local: { bytes: bytes("views: []\n# local"), identity: {} }, remote: { bytes: bytes("views: []\n# server") } } as BaseConflictReview;
	let changed = (_reset: boolean) => {};
	const host = { rows: jest.fn(async () => [row]), review: jest.fn(async () => review), resolve: jest.fn(async () => {}), retry: jest.fn(async () => {}),
		withdraw: jest.fn(async () => {}), export: jest.fn(async () => "export"), onChange: (listener: typeof changed) => { changed = listener; return () => {}; } };
	const folder = { canWriteManagedPath: jest.fn(() => true) };
	const modal = new BaseSyncModal({} as App, host as unknown as BaseSyncHost, folder as unknown as VaultShare);
	modal.onOpen(); const button = (label: string) => [...modal.contentEl.querySelectorAll("button")].find(item => item.textContent === label)!;
	return { modal, host, folder, row, review, button, changed: (reset: boolean) => changed(reset) };
}

test.each(["Use this device", "Use server"])("review displays accessible exact copies and routes %s with the reviewed version", async label => {
	const s = fixture(); try {
		await flush(); s.button("Review copies").click(); await flush();
		const previews = s.modal.contentEl.querySelectorAll("textarea"); expect(previews).toHaveLength(2);
		expect(previews[0].value).toContain("# local"); expect(previews[1].value).toContain("# server"); expect(previews[0].readOnly).toBe(true);
		expect(previews[0].getAttribute("aria-label")).toContain("This device");
		s.button(label).click(); await flush();
		expect(s.host.resolve).toHaveBeenCalledWith(s.folder, s.row.file, s.review, label === "Use server" ? "server" : "local");
	} finally { s.modal.onClose(); }
});

test("a changed review clears stale choices and reports the error; repeated clicks cannot overlap", async () => {
	const s = fixture(); try {
		await flush(); s.button("Review copies").click(); await flush(); let reject!: (error: Error) => void;
		s.host.resolve.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })); s.button("Use server").click();
		expect([...s.modal.contentEl.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
		reject(new Error("Copy changed; review again")); await flush();
		expect(s.modal.contentEl.querySelector('[role="alert"]')?.textContent).toContain("Copy changed"); expect(s.button("Use server")).toBeUndefined();
	} finally { s.modal.onClose(); }
});

test("read-only reviewers can choose the server and account reset immediately removes previous previews", async () => {
	const s = fixture(); try {
		s.folder.canWriteManagedPath.mockReturnValue(false); await flush(); s.button("Review copies").click(); await flush();
		expect(s.button("Use this device").disabled).toBe(true); expect(s.button("Use server").disabled).toBe(false);
		s.host.rows.mockRejectedValueOnce(new Error("Sign in")); s.changed(true);
		expect(s.modal.contentEl.querySelectorAll("textarea")).toHaveLength(0); await flush(); expect(s.modal.contentEl.textContent).toContain("Sign in");
	} finally { s.modal.onClose(); }
});

test("pending delivery is checked only by an explicit action, and closing ignores late UI reads", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { pending: {} }); await flush(); expect(s.host.withdraw).not.toHaveBeenCalled();
		s.button("Check delivery / withdraw").click(); await flush(); expect(s.host.withdraw).toHaveBeenCalledWith(s.folder, s.row.file);
		let finish!: (rows: BaseSyncRow[]) => void; s.host.rows.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		s.changed(false); s.modal.onClose(); finish([s.row]); await flush(); expect(s.modal.contentEl.textContent).toBe("");
	} finally { s.modal.onClose(); }
});
