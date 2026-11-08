/** @jest-environment jsdom */
import * as Y from "yjs";
import type { App } from "obsidian";
import type { VaultShare } from "../../src/VaultShare";
import type { ManagedRestoreText } from "../../src/client/ManagedRestoreText";
import type { ManagedRestoreInspection } from "../../src/client/ManagedIndexTransport";
import { ManagedRestoreTextModal } from "../../src/ui/ManagedRestoreTextModal";

jest.mock("obsidian", () => {
	class Modal {
		private element = document.createElement("div");
		contentEl = Object.assign(this.element, {
			empty: () => this.element.replaceChildren(), addClass: (...names: string[]) => this.element.classList.add(...names),
		});
		constructor(public app: App) {}
	}
	class Setting {
		constructor(private el: HTMLElement) {}
		setName(text: string) { this.el.createEl("strong", { text }); return this; }
		addButton(configure: (button: unknown) => void) {
			const button = this.el.createEl("button");
			const api = { setButtonText(text: string) { button.textContent = text; return api; }, setDisabled(value: boolean) { button.disabled = value; return api; }, onClick(handler: () => void) { button.onclick = handler; return api; } };
			configure(api); return this;
		}
	}
	return { Modal, Setting };
});

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); jest.restoreAllMocks(); });
function fixture() {
	jest.spyOn(document, "hidden", "get").mockReturnValue(false);
	const doc = new Y.Doc(), listeners = new Set<() => void>(), check = jest.fn();
	const value: ManagedRestoreText = { entryId: "one", serverPath: "Server.md", serverText: "server words",
		local: [{ label: "Local editing history", text: "local words" }, { label: "Local unsaved buffer", text: "unsaved words" }], capturedAt: "2026-11-08T00:00:00Z", check };
	const read = jest.fn<Promise<ManagedRestoreText>, [ManagedRestoreInspection, string, AbortSignal?]>().mockResolvedValue(value);
	const share = { crdtDoc: doc, inspectManagedRestoreText: read,
		authSession: { on: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } } as unknown as VaultShare;
	const inspection = {} as ManagedRestoreInspection;
	const modal = new ManagedRestoreTextModal({} as App, share, inspection, "one");
	cleanup.push(() => { modal.onClose(); doc.destroy(); });
	const click = (label: string) => {
		const button = [...modal.contentEl.querySelectorAll("button")].find(button => button.textContent === label);
		expect(button).toBeDefined(); button!.click();
	};
	return { modal, read, doc, value, check, inspection, click, listeners, accountChanged: () => listeners.forEach(listener => listener()) };
}

test("source review offers distinct local snapshots, semantic differences and no mutation action", async () => {
	const s = fixture(); s.modal.onOpen(); await flush();
	expect(s.read).toHaveBeenCalledWith(s.inspection, "one", expect.any(AbortSignal));
	expect(s.modal.contentEl.querySelector("del")?.textContent).toBe("local");
	expect(s.modal.contentEl.querySelector("ins")?.textContent).toBe("server");
	expect([...s.modal.contentEl.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Refresh text", "Selected", "Compare this text"]);
	s.click("Compare this text"); expect(s.modal.contentEl.querySelector("del")?.textContent).toBe("unsaved");
	expect(s.read).toHaveBeenCalledTimes(1); expect(s.check).toHaveBeenCalled();
});

test("source text is inert even when it contains HTML and images", async () => {
	const s = fixture(); s.value.serverText = '<img src="https://example.invalid/tracker" onerror="alert(1)"><script>secret</script>';
	s.value.local = []; s.modal.onOpen(); await flush();
	expect(s.modal.contentEl.querySelector("img, script")).toBeNull();
	expect(s.modal.contentEl.querySelector("pre")?.textContent).toBe(s.value.serverText);
	expect(s.modal.contentEl.textContent).toContain("No text for this entry");
});

test("large originals use bounded pages instead of an expensive difference view", async () => {
	const s = fixture(); s.value.serverText = "s".repeat(33_000); s.value.local[0].text = "l".repeat(33_000);
	s.modal.onOpen(); await flush();
	expect(s.modal.contentEl.textContent).toContain("without highlighting");
	expect(s.modal.contentEl.querySelector(".evc-restore-text-diff")).toBeNull();
	expect([...s.modal.contentEl.querySelectorAll("pre")].map(el => el.textContent?.length)).toEqual([16_000, 16_000]);
	s.click("Next text page"); expect(s.modal.contentEl.textContent).toContain("Text page 2 of 3");
	s.click("Next text page"); expect([...s.modal.contentEl.querySelectorAll("pre")].map(el => el.textContent?.length)).toEqual([1_000, 1_000]);
	s.click("Compare this text"); expect(s.modal.contentEl.textContent).toContain("Text page 1 of 3");
});

test("identical text does not imply histories can be merged", async () => {
	const s = fixture(); s.value.serverText = s.value.local[0].text; s.modal.onOpen(); await flush();
	expect(s.modal.contentEl.textContent).toContain("does not establish that their editing histories are interchangeable");
});

test("close aborts the source request, detaches observers and ignores its late completion", async () => {
	const s = fixture(); let finish!: (value: ManagedRestoreText) => void;
	s.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	s.modal.onOpen(); const signal = s.read.mock.calls[0][2]!;
	s.modal.onClose(); expect(signal.aborted).toBe(true); expect(s.listeners.size).toBe(0);
	finish(s.value); await flush(); expect(s.modal.contentEl.childElementCount).toBe(0);
	s.doc.getMap("filemeta_v0").set("later", true); expect(s.modal.contentEl.childElementCount).toBe(0);
});

test.each(["account", "inventory", "review", "hidden"])("a pending source comparison is cancelled on %s changes", async change => {
	const s = fixture(); let finish!: (value: ManagedRestoreText) => void;
	s.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); s.modal.onOpen();
	if (change === "account") s.accountChanged();
	if (change === "inventory") s.doc.getMap("filemeta_v0").set("changed", true);
	if (change === "review") s.doc.getMap("managed_base_v1").set("changed", true);
	if (change === "hidden") { jest.spyOn(document, "hidden", "get").mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); }
	expect(s.read.mock.calls[0][2]!.aborted).toBe(true);
	finish(s.value); await flush(); expect(s.modal.contentEl.textContent).not.toContain("server words");
	expect(s.modal.contentEl.querySelector('[role="alert"]')).not.toBeNull();
});

test("completed text is withdrawn on context changes and later clicks recheck validity", async () => {
	const s = fixture(); s.modal.onOpen(); await flush(); s.accountChanged();
	expect(s.modal.contentEl.textContent).not.toContain("server words");
	s.click("Refresh text"); await flush(); expect(s.read).toHaveBeenCalledTimes(2);
	s.check.mockImplementation(() => { throw new Error("Changed server"); }); s.click("Compare this text");
	expect(s.modal.contentEl.textContent).not.toContain("server words");
});

test("a failed comparison can retry, but a hidden document cannot start a request", async () => {
	const s = fixture(); s.read.mockRejectedValueOnce(new Error("Read denied")); s.modal.onOpen(); await flush();
	expect(s.modal.contentEl.textContent).toContain("Read denied"); s.click("Refresh text"); await flush();
	expect(s.modal.contentEl.textContent).toContain("server words");
	jest.spyOn(document, "hidden", "get").mockReturnValue(true); s.click("Refresh text");
	expect(s.read).toHaveBeenCalledTimes(2); expect(s.modal.contentEl.textContent).not.toContain("server words");
});

test("reopening cannot adopt a pending result from the previous modal lifetime", async () => {
	const s = fixture(); let finish!: (value: ManagedRestoreText) => void;
	s.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); s.modal.onOpen(); s.modal.onClose(); s.modal.onOpen();
	await flush(); finish({ ...s.value, serverText: "stale result" }); await flush();
	expect(s.modal.contentEl.textContent).not.toContain("stale result"); expect(s.modal.contentEl.textContent).toContain("server words");
});
