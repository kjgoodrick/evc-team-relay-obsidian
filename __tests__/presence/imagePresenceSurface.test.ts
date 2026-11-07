/** @jest-environment jsdom */
import type { FileView } from "obsidian";
import type { ImageAssets, RenderedImageEvidence } from "../../src/collaboration/ImageAssets";
import { ImagePresenceSurface } from "../../src/collaboration/presence/ImagePresenceSurface";
import type { ImageLocation } from "../../src/collaboration/presence/LocationProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const location: ImageLocation = { kind: "image", share_id: id(1), entry_id: id(2), generation: id(3), content_sha256: "a".repeat(64) };
const asset = { kind: "managed" as const, entry_id: id(2), sha256: location.content_sha256 };
const settle = () => new Promise(resolve => window.setTimeout(resolve, 0));
function fixture() {
	const root = document.body.appendChild(document.createElement("div"));
	const image = root.appendChild(document.createElement("img")); image.src = "app://local/Picture.png";
	Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
	image.scrollIntoView = jest.fn();
	const view = { contentEl: root, file: { path: "Picture.png", stat: { mtime: 1, size: 100 } }, app: { vault: { getResourcePath: () => image.src } } } as unknown as FileView;
	const evidence: RenderedImageEvidence = { asset, valid: () => true };
	const verify = jest.fn(async () => evidence), read = jest.fn(async () => location), changed = jest.fn(), interacted = jest.fn();
	const options = { current: () => true, connected: () => true, supported: () => true, read, changed, interacted };
	const surface = new ImagePresenceSurface(view, { describeFile: () => asset, verifyRenderedFile: verify } as unknown as ImageAssets, options);
	return { root, image, view, read, verify, changed, interacted, options, surface, evidence, close: () => { surface.close(); root.remove(); } };
}

test("waits for a loaded unambiguous native image and withdraws when a duplicate appears", async () => {
	const f = fixture();
	try {
		Object.defineProperty(f.image, "complete", { value: false }); f.surface.refresh(); await settle();
		expect(f.read).not.toHaveBeenCalled(); expect(f.surface.location).toBeUndefined();
		Object.defineProperty(f.image, "complete", { value: true }); f.image.dispatchEvent(new Event("load")); await settle();
		expect(f.surface.location).toEqual(location); expect(f.read).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 10; i++) f.surface.refresh(); expect(f.verify).toHaveBeenCalledTimes(1);
		const duplicate = f.image.cloneNode() as HTMLImageElement; f.root.append(duplicate); await settle();
		expect(f.surface.location).toBeUndefined(); expect(f.surface.reveal(() => true)).toBe(false);
		duplicate.remove(); await settle(); expect(f.surface.location).toEqual(location);
	} finally { f.close(); }
});

test("late verification cannot restore presence after the native image is replaced", async () => {
	const f = fixture(); let finish!: (value: RenderedImageEvidence) => void;
	try {
		f.verify.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); f.surface.refresh(); await settle();
		f.image.remove(); await settle(); finish(f.evidence); await settle();
		expect(f.surface.location).toBeUndefined(); expect(f.surface.state).toBe("waiting");
		f.root.append(f.image); await settle(); expect(f.surface.location).toEqual(location);
	} finally { f.close(); }
});

test.each(["synchronous", "asynchronous"])("%s verification failures stay unavailable until retry", async mode => {
	const f = fixture();
	try {
		if (mode === "synchronous") f.verify.mockImplementationOnce(() => { throw new Error("Unavailable"); });
		else f.read.mockRejectedValueOnce(new Error("Unavailable"));
		f.surface.refresh(); await settle(); expect(f.surface.state).toBe("unavailable");
		for (let i = 0; i < 10; i++) f.surface.refresh(); await settle(); expect(f.read).toHaveBeenCalledTimes(1);
		f.surface.retry(); await settle(); expect(f.surface.location).toEqual(location);
	} finally { f.close(); }
});

test("unsupported presence does not read assets and unload fences delayed work and interaction", async () => {
	const f = fixture(); let finish!: (value: ImageLocation) => void;
	try {
		f.options.supported = () => false; f.surface.refresh(); await settle(); expect(f.verify).not.toHaveBeenCalled();
		f.options.supported = () => true; f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.surface.refresh(); await settle(); f.surface.close(); f.changed.mockClear(); finish(location); await settle();
		f.image.dispatchEvent(new Event("load")); f.root.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); await settle();
		expect(f.surface.location).toBeUndefined(); expect(f.changed).not.toHaveBeenCalled(); expect(f.interacted).not.toHaveBeenCalled();
	} finally { f.close(); }
});
