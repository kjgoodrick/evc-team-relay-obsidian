/** @jest-environment jsdom */
import * as Y from "yjs";
import type { MarkdownView } from "obsidian";
import { RenderedImageView } from "../../src/collaboration/RenderedImageComments";
import { captureImageAnchor, markdownImages } from "../../src/collaboration/anchors/images";
import { readingImageTargets } from "../../src/collaboration/anchors/renderedImages";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { ImageAssets } from "../../src/collaboration/ImageAssets";

jest.mock("obsidian", () => ({ Component: class {}, MarkdownView: class {} }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
beforeEach(() => {
	jest.useFakeTimers();
	jest.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [rect(0, 0, 1000, 800)] as unknown as DOMRectList);
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
		return this.tagName === "IMG" ? rect(50, Number(this.dataset.top), 200, 125) : rect(0, 0, 1000, 800);
	});
	for (const property of ["clientWidth", "offsetWidth", "clientHeight", "offsetHeight"] as const) jest.spyOn(HTMLElement.prototype, property, "get").mockImplementation(function(this: HTMLElement) {
		return property.endsWith("Width") ? this.tagName === "IMG" ? 200 : 1000 : this.tagName === "IMG" ? 125 : 800;
	});
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function settle() { for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(80); }
function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![[chart.png|320]]\n\n![[chart.png|180]]");
	const contentEl = document.createElement("div"), rendered = document.createElement("div"); contentEl.append(rendered); document.body.append(contentEl);
	rendered.innerHTML = '<img src="https://images.test/chart.png" data-top="100"><img src="https://images.test/chart.png" data-top="350">';
	const images = Array.from(rendered.querySelectorAll("img"));
	for (const image of images) Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
	const asset = { kind: "external" as const, url: "https://images.test/chart.png", version_evidence: "unknown" as const };
	const anchor = captureImageAnchor(text, id(1), id(2), markdownImages(text.toString())[1], asset, { width: 800, height: 500, orientation: "display" }, { type: "pin", x: 0.25, y: 0.75 });
	let read = true, comment = true, current = true, source = text.toString();
	const stop = jest.fn(), listeners = new Set<() => void>(), file = { path: "Team/Note.md" };
	const session = { canAnchorImages: true, permission: () => ({ read, comment }), documentGeneration: () => id(2),
		watch: jest.fn((_: string, fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); stop(); }; }), displayName: () => "Reviewer",
		anchorThreads: jest.fn().mockResolvedValue([{ id: id(3), author_id: id(4), activity_sequence: 1, state: "open", anchor }]) };
	const context = { file, session, entryId: id(1), text, generation: id(2), current: () => current && read && source === text.toString() };
	const host = { imageContext: () => { if (!context.current()) throw Error(); return context; },
		renderedImages: (_: unknown, occurrences: ReturnType<typeof markdownImages>) => readingImageTargets(rendered, source, 0, source.length, occurrences), openThread: jest.fn() };
	const assets = { describe: jest.fn(() => asset), verifyRendered: jest.fn(async (_: unknown, __: string, image: HTMLImageElement, valid: () => boolean) => ({ asset, valid: () => valid() && image.src === asset.url })) };
	const open = jest.fn(), surface = new RenderedImageView(host as unknown as DiscussionHost, { contentEl } as unknown as MarkdownView, assets as unknown as ImageAssets, open);
	return { surface, text, images, contentEl, session, assets, host, open, file, anchor,
		changePermission(value: boolean) { read = value; surface.invalidate(); }, commentOnly(value: boolean) { comment = value; listeners.forEach(fn => fn()); },
		updateSource() { source = text.toString(); surface.invalidate(false); }, logout() { current = false; surface.invalidate(); },
		close() { surface.close(); doc.destroy(); contentEl.remove(); }, stop };
}

test("draws a saved pin only on the second occurrence, opens its thread and exposes exact-image capture", async () => {
	const f = fixture();
	try {
		await settle();
		const overlays = f.contentEl.querySelectorAll<HTMLElement>(".relay-rendered-image"), pin = f.contentEl.querySelector<HTMLButtonElement>(".relay-rendered-image-mark")!;
		expect(overlays).toHaveLength(2); expect(overlays[0].querySelector(".relay-rendered-image-mark")).toBeNull();
		expect(overlays[1].hidden).toBe(false); expect(pin.style.left).toBe("50px"); expect(pin.style.top).toBe("93.75px");
		pin.click(); expect(f.host.openThread).toHaveBeenCalledWith(f.file, f.session, id(1), id(3));
		overlays[1].querySelector<HTMLButtonElement>(".relay-rendered-image-controls button")!.click();
		expect(f.open.mock.calls[0][1].from).toBe(markdownImages(f.text.toString())[1].from);
		const calls = f.assets.verifyRendered.mock.calls.length; document.dispatchEvent(new Event("scroll")); await settle();
		expect(f.assets.verifyRendered).toHaveBeenCalledTimes(calls); expect(f.session.anchorThreads).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test("clears stale source immediately, remaps after rendering, and removes controls synchronously on revoke", async () => {
	const f = fixture();
	try {
		await settle(); f.text.insert(0, "Intro\n\n"); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull();
		await settle(); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull();
		f.updateSource(); await settle(); expect(f.contentEl.querySelector(".relay-rendered-image-mark")).not.toBeNull();
		f.changePermission(false); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull();
		await settle(); expect(f.stop).toHaveBeenCalled();
	} finally { f.close(); }
});

test("readers retain thread navigation without author controls, and logout removes all overlays", async () => {
	const f = fixture();
	try {
		await settle(); f.commentOnly(false); await settle();
		expect(f.contentEl.querySelector(".relay-rendered-image-controls button")).toBeNull();
		expect(f.contentEl.querySelector(".relay-rendered-image-mark")).not.toBeNull();
		f.logout(); await settle(); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull();
		f.surface.close(); expect(f.contentEl.querySelector(".relay-rendered-images")).toBeNull(); expect(jest.getTimerCount()).toBe(0);
	} finally { f.close(); }
});

test("an asynchronous image verification after logout cannot recreate a removed overlay", async () => {
	const f = fixture(); let finish!: (value: Awaited<ReturnType<typeof f.assets.verifyRendered>>) => void;
	f.assets.verifyRendered.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
	try {
		await settle(); f.logout();
		finish({ asset: { kind: "external", url: "https://images.test/chart.png", version_evidence: "unknown" }, valid: () => true });
		await settle(); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull();
	} finally { f.close(); }
});

test("an image that finishes synchronization later gains overlays without requiring a note edit", async () => {
	const f = fixture(); f.assets.describe.mockImplementation(() => { throw Error("not registered"); });
	try {
		await settle(); expect(f.contentEl.querySelector(".relay-rendered-image")).toBeNull(); expect(f.assets.verifyRendered).not.toHaveBeenCalled();
		f.assets.describe.mockReturnValue(f.anchor.asset as ReturnType<typeof f.assets.describe>); f.surface.invalidate(); await settle();
		expect(f.contentEl.querySelector(".relay-rendered-image-mark")).not.toBeNull();
	} finally { f.close(); }
});
