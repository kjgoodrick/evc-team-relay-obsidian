/** @jest-environment jsdom */
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import * as Y from "yjs";
import type { Plugin, TFile } from "obsidian";
import { ImageComments } from "../../src/collaboration/ImageComments";
import { ImageAssets } from "../../src/collaboration/ImageAssets";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { parseAnchor, protocolJson, type ImageAnchor } from "../../src/collaboration/DiscussionProtocol";
import { markdownImages, resolveImageOccurrence, type ImageOccurrence } from "../../src/collaboration/anchors/images";
import * as imageAnchors from "../../src/collaboration/anchors/images";
import type { ImageCommentContext, CapturedCommentSelection } from "../../src/collaboration/CommentEditor";
import type { ImagePlacementSurface } from "../../src/collaboration/ui/RenderedImagePlacement";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { ShareRegistry } from "../../src/VaultShare";
import type { ImageAsset } from "../../src/collaboration/anchors/imageGeometry";

Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
let mockOpen: (context: ImageCommentContext, image: ImageOccurrence, surface?: ImagePlacementSurface) => void;
jest.mock("../../src/collaboration/RenderedImageComments", () => ({ RenderedImageComments: class {
	constructor(_: unknown, __: unknown, ___: unknown, open: typeof mockOpen) { mockOpen = open; }
} }));
jest.mock("../../src/collaboration/ImageFileOverlays", () => ({ ImageFileOverlays: class {} }));
jest.mock("obsidian", () => ({
	Component: class { addChild(child: unknown) { return child; } register() {} registerEvent() {} },
	MarkdownView: class {}, Menu: class {}, Notice: class {},
	Modal: class {
		contentEl = document.createElement("div"); titleEl = document.createElement("h2"); onOpen() {} onClose() {}
		open() { document.body.append(this.titleEl, this.contentEl); this.onOpen(); } close() { this.onClose(); this.contentEl.remove(); this.titleEl.remove(); }
	},
}));
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; }, addClass(this: HTMLElement, name: string) { this.classList.add(name); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
beforeEach(() => {
	jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D);
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) { return this.tagName === "IMG" ? rect(50, 100, 200, 125) : rect(0, 0, 1000, 800); });
	for (const property of ["clientWidth", "offsetWidth", "clientHeight", "offsetHeight"] as const) jest.spyOn(HTMLElement.prototype, property, "get").mockImplementation(function(this: HTMLElement) {
		return property.endsWith("Width") ? this.tagName === "IMG" ? 200 : 1000 : this.tagName === "IMG" ? 125 : 800;
	});
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); });
async function fixture(kind: "embed" | "file") {
	const factory = new IDBFactory(), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: id(3) };
	let store = await DiscussionStore.open(identity, factory);
	const doc = new Y.Doc(), text = doc.getText("contents"), source = "![[chart.png]]\n\n![[chart.png]]"; text.insert(0, source);
	const root = document.createElement("div"), image = root.createEl("img", { attr: { src: "https://images.test/chart.png" } }); document.body.append(root);
	Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
	const asset: ImageAsset = kind === "file" ? { kind: "managed", entry_id: id(4), sha256: "a".repeat(64) } : { kind: "external", url: "https://images.test/chart.png", version_evidence: "unknown" };
	jest.spyOn(ImageAssets.prototype, "describe").mockImplementation(() => ({ ...asset }));
	jest.spyOn(ImageAssets.prototype, "describeFile").mockImplementation(() => ({ kind: "managed", entry_id: id(4), sha256: "a".repeat(64) }));
	const preview = { asset, url: image.src, valid: () => true, release: jest.fn() };
	const load = jest.spyOn(ImageAssets.prototype, "load").mockResolvedValue(preview), loadFile = jest.spyOn(ImageAssets.prototype, "loadFile").mockResolvedValue(preview);
	let current = true; const listeners = new Set<() => void>(), file = { path: kind === "file" ? "Team/chart.png" : "Team/Note.md" } as TFile;
	const stop = jest.fn(), session = { canAnchorImages: true, canAnchorImageFiles: true, permission: () => ({ read: current, comment: current }),
		watch: jest.fn(() => stop), refresh: jest.fn(async () => {}) };
	const context = { file, session, entryId: id(4), generation: id(5), ...(kind === "embed" ? { text } : {}), current: () => current };
	const saveCommentSelection = jest.fn(async (selection: CapturedCommentSelection) => {
		await store.saveDraft({ id: id(6), scopeId: selection.entryId, revision: 0, body: { text: "", mentions: [] }, target: protocolJson(selection.anchor) }, null); return true;
	});
	const host = { targetFor: () => ({ kind: "image", entryId: id(4), session }), imageFileContext: () => context,
		saveCommentSelection, onChange: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); } };
	const plugin = { app: { vault: { on: jest.fn() }, workspace: { on: jest.fn() } }, addCommand: jest.fn() } as unknown as Plugin;
	const comments = new ImageComments(host as unknown as DiscussionHost, plugin, {} as ShareRegistry); comments.onload();
	const surface = { root, image, current: () => current && source === text.toString() };
	if (kind === "file") await comments.commentFile(file, surface);
	else mockOpen(context as unknown as ImageCommentContext, markdownImages(source)[1], surface);
	return { comments, root, image, context, file, load, loadFile, saveCommentSelection, text, stop,
		button: (label: string) => [...root.querySelectorAll("button")].find(button => button.textContent === label)!,
		revoke: () => { current = false; listeners.forEach(fn => fn()); },
		reopen: async () => { store.close(); store = await DiscussionStore.open(identity, factory); return store.getDraft(id(6)); },
		close: () => { comments.onunload(); store.close(); doc.destroy(); root.remove(); },
	};
}

test.each(["embed", "file"] as const)("%s authoring saves a durable target without refetching pixels or modifying Markdown", async kind => {
	const f = await fixture(kind);
	try {
		f.button("Pin").click(); f.button("Add comment").click(); await f.saveCommentSelection.mock.results[0].value;
		const draft = await f.reopen(), anchor = parseAnchor(draft!.target);
		expect(anchor).toMatchObject({ type: kind === "file" ? "image_file" : "image", basis: { width: 800, height: 500, orientation: "display" }, geometry: { type: "pin", x: 0.5, y: 0.5 } });
		if (kind === "embed") expect(resolveImageOccurrence(f.text, id(4), id(5), anchor as ImageAnchor)).toMatchObject({ status: "attached", image: markdownImages(f.text.toString())[1] });
		expect(f.text.toString()).toBe("![[chart.png]]\n\n![[chart.png]]"); expect(f.load).not.toHaveBeenCalled(); expect(f.loadFile).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["embed", "file"] as const)("%s revocation releases inline pixels and denies the old save control", async kind => {
	const f = await fixture(kind);
	try {
		const button = f.button("Add comment"), canvas = f.root.querySelector("canvas")!; f.revoke(); button.click();
		expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(canvas.width).toBe(0); expect(f.saveCommentSelection).not.toHaveBeenCalled();
		if (kind === "file") expect(f.stop).toHaveBeenCalledTimes(2); // Refresh hold and mounted authoring hold.
	} finally { f.close(); }
});

test("an occurrence remap closes inline authoring; its old button cannot save against a new render", async () => {
	const f = await fixture("embed");
	try {
		const button = f.button("Add comment"); f.text.insert(0, "Moved\n\n"); button.click();
		expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(f.saveCommentSelection).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("larger-preview handoff closes inline placement and retains its target coordinates", async () => {
	const f = await fixture("embed");
	try {
		const images: HTMLImageElement[] = [], create = document.createElement.bind(document);
		jest.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
			const element = create(tag, options); if (tag === "img") { images.push(element as HTMLImageElement); Object.defineProperties(element, { naturalWidth: { value: 800 }, naturalHeight: { value: 500 } }); } return element;
		});
		f.button("Region").click(); f.button("Larger preview / coordinates").click(); await Promise.resolve();
		expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(f.load).toHaveBeenCalledTimes(1);
		images[0].dispatchEvent(new Event("load"));
		expect([...document.querySelectorAll<HTMLInputElement>(".relay-image-comment-fields input")].map(input => input.value)).toEqual(["25", "25", "50", "50"]);
		[...document.querySelectorAll<HTMLButtonElement>(".relay-image-comment button")].find(button => button.textContent === "Add comment")!.click();
		await f.saveCommentSelection.mock.results[0].value;
		expect(parseAnchor((await f.reopen())!.target)).toMatchObject({ geometry: { type: "region", x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
	} finally { f.close(); }
});

test("an unavailable inline canvas falls back to the established placement dialog", async () => {
	jest.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
	const f = await fixture("embed");
	try {
		expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(document.querySelector(".relay-image-comment")).not.toBeNull();
		expect(f.load).toHaveBeenCalledTimes(1); expect(f.saveCommentSelection).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("repainting and keyboard adjustment reuse verified mapping; source resolution runs at confirmation", async () => {
	const resolve = jest.spyOn(imageAnchors, "resolveImageOccurrence"), f = await fixture("embed");
	try {
		const describe = jest.mocked(ImageAssets.prototype.describe), reads = describe.mock.calls.length;
		f.button("Region").click(); const mark = f.root.querySelector<HTMLButtonElement>(".relay-image-placement-mark")!;
		mark.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		document.dispatchEvent(new Event("scroll")); await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)));
		expect(resolve).not.toHaveBeenCalled(); expect(describe).toHaveBeenCalledTimes(reads);
		f.button("Add comment").click(); await f.saveCommentSelection.mock.results[0].value; expect(resolve).toHaveBeenCalled();
	} finally { f.close(); }
});
