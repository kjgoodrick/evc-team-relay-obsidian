/** @jest-environment jsdom */
import type { FileView } from "obsidian";
import { ImageFileOverlay } from "../../src/collaboration/ImageFileOverlays";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { ImageAssets } from "../../src/collaboration/ImageAssets";
jest.mock("obsidian", () => ({ Component: class {}, FileView: class {}, MarkdownView: class {} }));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
beforeEach(() => {
	jest.useFakeTimers();
	jest.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [rect(0, 0, 1000, 800)] as unknown as DOMRectList);
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) { return this.tagName === "IMG" ? rect(50, 100, 200, 125) : rect(0, 0, 1000, 800); });
	for (const property of ["clientWidth", "offsetWidth", "clientHeight", "offsetHeight"] as const) jest.spyOn(HTMLElement.prototype, property, "get").mockImplementation(function(this: HTMLElement) {
		return property.endsWith("Width") ? this.tagName === "IMG" ? 200 : 1000 : this.tagName === "IMG" ? 125 : 800;
	});
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function settle() { for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(80); }
function fixture() {
	const contentEl = document.createElement("div"); document.body.append(contentEl);
	const image = contentEl.createEl("img", { attr: { src: "app://local/chart.png?1" } });
	Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
	const asset = { kind: "managed" as const, entry_id: id(1), sha256: "a".repeat(64) };
	const anchor = { version: 1, type: "image_file", generation: id(2), asset: { ...asset }, basis: { width: 800, height: 500, orientation: "display" }, geometry: { type: "pin", x: 0.25, y: 0.75 } };
	let read = true, comment = true, current = true;
	const listeners = new Set<() => void>(), stop = jest.fn(), file = { path: "Team/chart.png" };
	const session = { canAnchorImageFiles: true, permission: () => ({ read, comment }), displayName: () => "Reviewer",
		watch: jest.fn((_: string, fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); stop(); }; }),
		anchorThreads: jest.fn().mockResolvedValue([{ id: id(3), author_id: id(4), activity_sequence: 1, state: "open", anchor }]) };
	const context = { file, session, entryId: id(1), generation: id(2), current: () => read && current };
	const host = { targetFor: () => ({ kind: "image", session, entryId: id(1) }), imageFileContext: () => { if (!context.current()) throw Error(); return context; }, openThread: jest.fn() };
	const assets = { describeFile: jest.fn(() => asset), verifyRenderedFile: jest.fn(async (_: unknown, __: unknown, valid: () => boolean) => ({ asset, valid })) };
	const view = { file, contentEl, app: { vault: { getResourcePath: () => "app://local/chart.png?1" } } } as unknown as FileView;
	const open = jest.fn(), overlay = new ImageFileOverlay(host as unknown as DiscussionHost, view, assets as unknown as ImageAssets, open);
	return { contentEl, image, asset, anchor, context, host, session, assets, file, open, overlay, stop,
		revoke() { read = false; overlay.invalidate(); }, reader() { comment = false; listeners.forEach(fn => fn()); },
		close() { current = false; overlay.close(); contentEl.remove(); } };
}

test("bootstraps image permissions, draws exact-file geometry and opens its discussion without a note", async () => {
	const f = fixture();
	try {
		await settle(); expect(f.session.watch).toHaveBeenCalledWith(id(1), expect.any(Function), "image");
		const pin = f.contentEl.querySelector<HTMLButtonElement>(".relay-rendered-image-mark")!;
		expect(pin.style.left).toBe("50px"); expect(pin.style.top).toBe("93.75px");
		pin.click(); expect(f.host.openThread).toHaveBeenCalledWith(f.file, f.session, id(1), id(3));
		f.contentEl.querySelector<HTMLButtonElement>(".relay-rendered-image-controls button")!.click(); expect(f.open).toHaveBeenCalledWith(f.file, {
			image: f.image, root: f.contentEl, current: expect.any(Function),
		});
		expect(f.open.mock.calls[0][1].current()).toBe(true);
		document.dispatchEvent(new Event("scroll")); await settle();
		expect(f.assets.verifyRenderedFile).toHaveBeenCalledTimes(1); expect(f.session.anchorThreads).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
	expect(f.stop).toHaveBeenCalledTimes(1);
});

test("read-only users can open markers; access loss immediately hides them", async () => {
	const f = fixture();
	try {
		await settle(); f.reader(); await settle();
		expect(f.contentEl.textContent).not.toContain("Comment on image");
		const pin = f.contentEl.querySelector<HTMLButtonElement>(".relay-rendered-image-mark")!; pin.click(); expect(f.host.openThread).toHaveBeenCalledTimes(1);
		f.revoke(); expect(f.contentEl.querySelector<HTMLElement>(".relay-rendered-image")!.hidden).toBe(true);
		pin.click(); expect(f.host.openThread).toHaveBeenCalledTimes(1);
		await settle(); expect(f.contentEl.querySelector(".relay-rendered-image-mark")).toBeNull();
	} finally { f.close(); }
});

test("replacement versions keep the thread available but suppress old coordinates, and ambiguous renders are not guessed", async () => {
	const f = fixture();
	try {
		await settle(); f.asset.sha256 = "b".repeat(64); f.overlay.invalidate(); await settle();
		expect(f.contentEl.querySelector(".relay-rendered-image-mark")).toBeNull(); expect(f.contentEl.textContent).toContain("Image changed");
		f.contentEl.append(f.image.cloneNode(true)); f.overlay.invalidate(); await settle();
		expect(f.contentEl.querySelector<HTMLElement>(".relay-rendered-image")!.hidden).toBe(true);
	} finally { f.close(); }
});

test("verification finishing after close cannot recreate controls", async () => {
	const f = fixture(); let finish!: (value: { asset: typeof f.asset; valid: () => boolean }) => void;
	f.assets.verifyRenderedFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	await settle(); f.close(); finish({ asset: f.asset, valid: () => true }); await settle();
	expect(f.contentEl.children.length).toBe(1); expect(f.contentEl.querySelector(".relay-rendered-images")).toBeNull();
});
