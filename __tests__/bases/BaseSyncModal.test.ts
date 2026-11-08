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
			element.append(child); return enhance(child);
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
		reviewRemoval: jest.fn(async () => ({ record: row.record, local: review.local })), moveRemoved: jest.fn(async () => {}),
		reviewRestore: jest.fn(async () => ({ record: row.record, copies: [{ key: "removed", label: "Saved original", bytes: bytes("original") }, { key: "baseline", label: "Last synchronized", bytes: bytes("base") }] })),
		restore: jest.fn(async () => {}), resumeRestore: jest.fn(async () => {}), cancelRestore: jest.fn(async () => {}),
		checkStatus: jest.fn(async () => ({ status: "unknown" as const, entry_id: "entry", operation_id: "operation" })),
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

test("removed identities expose local recovery without retrying pending publication", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { pending: {}, retirement: { path: s.row.path, local: bytes("original local copy") } });
		await flush(); expect(s.button("Retry sync")).toBeUndefined(); expect(s.button("Check delivery / withdraw")).toBeUndefined();
		s.button("Review removal").click(); await flush();
		const previews = s.modal.contentEl.querySelectorAll("textarea");
		expect(previews[0].value).toContain("# local"); expect(previews[1].value).toBe("original local copy");
		s.button("Move to local recovery").click(); await flush();
		expect(s.host.moveRemoved).toHaveBeenCalledWith(s.folder, s.row.entryId, { record: s.row.record, local: s.review.local });
		expect(s.host.retry).not.toHaveBeenCalled(); expect(s.host.withdraw).not.toHaveBeenCalled();
	} finally { s.modal.onClose(); }
});

test("restoration lets a user choose and preview exact bytes, then name a new local file", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { retirement: { path: s.row.path, local: bytes("original") } });
		await flush(); s.button("Restore as new file").click(); await flush();
		expect(s.modal.contentEl.querySelector("textarea")?.value).toBe("original");
		const select = s.modal.contentEl.querySelector("select")!; select.value = "baseline"; select.dispatchEvent(new Event("change"));
		expect(s.modal.contentEl.querySelector("textarea")?.value).toBe("base");
		const input = s.modal.contentEl.querySelector("input")!; input.value = "Archive/Copy.base"; input.dispatchEvent(new Event("input"));
		s.button("Create restored file").click(); await flush();
		expect(s.host.restore).toHaveBeenCalledWith(s.folder, s.row.entryId, await s.host.reviewRestore.mock.results[0].value, "baseline", "Archive/Copy.base");
		expect(s.modal.contentEl.querySelector("select")).toBeNull();
	} finally { s.modal.onClose(); }
});

test("pending restoration exposes explicit check and stop controls without creating another file", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { retirement: { path: s.row.path }, restore: { state: "prepared" } });
		await flush(); expect(s.button("Restore as new file")).toBeUndefined();
		s.button("Check restoration").click(); await flush(); expect(s.host.resumeRestore).toHaveBeenCalledWith(s.folder, s.row.entryId);
		s.button("Stop restoration").click(); await flush(); expect(s.host.cancelRestore).toHaveBeenCalledWith(s.folder, s.row.entryId, s.row.record.revision);
		expect(s.host.restore).not.toHaveBeenCalled();
	} finally { s.modal.onClose(); }
});

test("an account reset during a delayed restore review never renders old-account copies", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { retirement: { path: s.row.path } }); await flush();
		let finish!: (value: Awaited<ReturnType<typeof s.host.reviewRestore>>) => void;
		const original = await s.host.reviewRestore(); s.host.reviewRestore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		s.button("Restore as new file").click(); s.changed(true); finish(original); await flush();
		expect(s.modal.contentEl.querySelector("textarea")).toBeNull(); expect(s.modal.contentEl.querySelector("select")).toBeNull();
	} finally { s.modal.onClose(); }
});


test("read-only users can inspect an unknown result without withdrawing, replaying or losing pending work", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { pending: { operationId: "operation" } }); s.folder.canWriteManagedPath.mockReturnValue(false);
		await flush(); expect(s.button("Check saved result").disabled).toBe(false); expect(s.button("Check delivery / withdraw").disabled).toBe(true);
		s.button("Check saved result").click(); await flush();
		expect(s.host.checkStatus).toHaveBeenCalledWith(s.folder, s.row.file);
		expect(s.modal.contentEl.querySelector('[role="status"]')?.textContent).toContain("may have succeeded before a restore");
		expect(s.row.record.pending?.operationId).toBe("operation"); expect(s.host.withdraw).not.toHaveBeenCalled(); expect(s.host.retry).not.toHaveBeenCalled();
		s.changed(true); await flush(); expect(s.modal.contentEl.querySelector('[role="status"]')).toBeNull();
	} finally { s.modal.onClose(); }
});

test("older restore requests expose read-only inspection and export while retry and withdrawal stay disabled", async () => {
	const s = fixture(); try {
		Object.assign(s.row.record, { pending: { operationId: "operation" }, restoreContext: { supported: true, generation: "new-generation" } });
		await flush(); expect(s.modal.contentEl.textContent).toContain("earlier restore generation");
		expect(s.button("Retry sync").disabled).toBe(true); expect(s.button("Check delivery / withdraw").disabled).toBe(true);
		expect(s.button("Check saved result").disabled).toBe(false); expect(s.button("Export recovery copies").disabled).toBe(false);
		s.button("Retry sync").click(); s.button("Check delivery / withdraw").click();
		expect(s.host.retry).not.toHaveBeenCalled(); expect(s.host.withdraw).not.toHaveBeenCalled();
	} finally { s.modal.onClose(); }
});
