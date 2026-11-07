/** @jest-environment jsdom */
import * as Y from "yjs";
import { TextEncoder } from "node:util";
Object.assign(window, { TextEncoder });
import type { MarkdownView } from "obsidian";
import type { ImageAssets, RenderedImageEvidence } from "../../src/collaboration/ImageAssets";
import { EmbeddedImageSurface } from "../../src/collaboration/presence/EmbeddedImageSurface";
import { EmbeddedImageAnchors } from "../../src/collaboration/presence/EmbeddedImageAnchors";
import type { EmbeddedImage, EmbeddedPeer } from "../../src/collaboration/presence/EmbeddedImageProtocol";
import type { ImageOccurrence } from "../../src/collaboration/anchors/images";
import type { PresencePeer } from "../../src/collaboration/presence/PresencePeers";

jest.mock("../../src/contentDigest", () => ({ sha256Hex: async (bytes: ArrayBuffer) => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- The hoisted mock needs a local crypto dependency.
	return require("node:crypto").createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
} }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asset = { kind: "managed" as const, entry_id: id(1), sha256: "a".repeat(64) };
const location = { kind: "image" as const, share_id: id(2), entry_id: id(1), generation: id(3), content_sha256: asset.sha256 };
const peer: PresencePeer = { key: "member", clientId: 7, userId: id(4), sessionId: "b".repeat(32), instanceId: id(5), name: "<Member>", surface: "reading" };
const target = { user_id: peer.userId, session_id: peer.sessionId, instance_id: peer.instanceId! };
const state = { pointer: { x: 0.5, y: 0.5 }, viewport: { x: 0, y: 0, width: 1, height: 1 } };
function box(element: HTMLElement, width = 400, height = 400, top = 0) {
	Object.defineProperties(element, { offsetWidth: { configurable: true, value: width }, offsetHeight: { configurable: true, value: height }, clientWidth: { configurable: true, value: width }, clientHeight: { configurable: true, value: height } });
	element.getBoundingClientRect = () => ({ left: 0, top, right: width, bottom: top + height, width, height, x: 0, y: top, toJSON: () => ({}) });
}
function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![[Picture.png]]\n\n![[Picture.png]]");
	const root = document.body.appendChild(document.createElement("div")); box(root);
	const images = [0, 200].map(top => {
		const image = root.appendChild(document.createElement("img")); image.src = "app://local/Picture.png"; box(image, 200, 100, top);
		Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 800, configurable: true }, naturalHeight: { value: 400, configurable: true } });
		image.scrollIntoView = jest.fn(); return image;
	});
	const view = { contentEl: root, file: { path: "Note.md" } } as unknown as MarkdownView;
	const evidence: RenderedImageEvidence = { asset, valid: () => true };
	const assets = { describe: jest.fn((): ReturnType<ImageAssets["describe"]> => asset), verifyRendered: jest.fn(async () => evidence) };
	const options = { current: () => true, publishing: () => true,
		targets: jest.fn((occurrences: ImageOccurrence[]) => images.map((image, index) => ({ image, occurrence: occurrences[index] })).filter(item => !!item.occurrence && item.image.isConnected)),
		read: jest.fn(async () => location), publish: jest.fn(), changed: jest.fn() };
	const surface = new EmbeddedImageSurface(view, text, assets as unknown as ImageAssets, options);
	const anchors = new EmbeddedImageAnchors(text);
	const embed = async (index = 1): Promise<EmbeddedImage> => (await anchors.capture(anchors.images[index], { kind: "managed", entry_id: asset.entry_id, generation: location.generation, sha256: asset.sha256 }, { width: 800, height: 400, orientation: "display" }, state))!;
	const point = (index = 1, x = 100) => images[index].dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: index * 200 + 50 }));
	const layers = () => root.querySelectorAll<HTMLElement>(".relay-image-presence").forEach(element => box(element));
	return { doc, text, root, images, view, evidence, assets, options, surface, anchors, embed, point, layers,
		close: () => { surface.close(); anchors.close(); doc.destroy(); root.remove(); } };
}
const settle = () => jest.advanceTimersByTimeAsync(300);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("captures the exact repeated image, verifies its bytes/version once and clears on departure", async () => {
	const f = fixture();
	try {
		f.point(); await settle();
		const sent = f.options.publish.mock.calls.map(call => call[0] as EmbeddedImage | null).filter(Boolean).at(-1)!;
		expect(sent.asset).toEqual({ kind: "managed", entry_id: asset.entry_id, generation: location.generation, sha256: asset.sha256 });
		expect(await f.anchors.resolve(sent)).toEqual(f.anchors.images[1]); expect(sent.state.pointer).toEqual({ x: 0.5, y: 0.5 });
		for (let x = 0; x <= 100; x++) f.point(1, x); await settle();
		expect(f.assets.verifyRendered).toHaveBeenCalledTimes(1); expect(f.options.read).toHaveBeenCalledTimes(1);
		f.root.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })); expect(f.options.publish).toHaveBeenLastCalledWith(null);
		await settle(); expect(f.root.querySelectorAll(".relay-image-presence")).toHaveLength(0);
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("joins remote identity exactly, renders only the matching image and observes while hidden", async () => {
	const f = fixture();
	try {
		f.options.publishing = () => false; const embed = await f.embed();
		f.surface.setPeers([{ target: { ...target, instance_id: id(9) }, embed }], [peer]); await settle();
		expect(f.options.read).not.toHaveBeenCalled(); expect(f.surface.position(peer)).toBeUndefined();
		f.surface.setPeers([{ target, embed }], [peer]); await settle(); f.layers();
		f.surface.setPeers([{ target, embed: { ...embed, state: { ...state, pointer: { x: 0.25, y: 0.5 } } } }], [peer]); await settle();
		const marker = f.root.querySelector<HTMLElement>(".relay-image-presence-pointer")!;
		expect(marker).not.toBeNull(); expect(marker.textContent).toBe("<Member>"); expect(marker.style.top).toBe("250px"); expect(marker.style.left).toBe("50px");
		expect(f.surface.position(peer)).toMatchObject({ from: f.anchors.images[1].from, to: f.anchors.images[1].to });
		expect(f.surface.reveal(peer, false, () => true)).toBe(true);
		f.point(); await settle(); expect(f.options.publish.mock.calls.every(call => call[0] === null)).toBe(true);
		f.surface.setPeers([], [peer]); await settle(); expect(f.surface.position(peer)).toBeUndefined(); expect(f.root.querySelector(".relay-image-presence-pointer")).toBeNull();
	} finally { f.close(); }
});

test.each(["basis", "asset", "generation", "source"])("does not overlay coordinates on mismatched %s", async change => {
	const f = fixture();
	try {
		const original = await f.embed();
		const embed = change === "basis" ? { ...original, basis: { ...original.basis, width: 900 } } :
			change === "asset" ? { ...original, asset: { ...original.asset, sha256: "e".repeat(64) } } :
			change === "generation" ? { ...original, asset: { ...original.asset, generation: id(8) } } : { ...original, source_sha256: "e".repeat(64) };
		f.surface.setPeers([{ target, embed } as EmbeddedPeer], [peer]); await settle(); f.layers(); await settle();
		expect(f.root.querySelector(".relay-image-presence-pointer")).toBeNull(); expect(f.surface.reveal(peer, false, () => true)).toBe(false);
		if (change !== "basis") expect(f.surface.position(peer)).toBeUndefined();
	} finally { f.close(); }
});

test("pending verification cannot restore publication after a note change, access loss or unload", async () => {
	const f = fixture(); let finish!: (value: typeof f.evidence) => void;
	try {
		f.assets.verifyRendered.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.point(); await jest.advanceTimersByTimeAsync(110); expect(finish).toBeDefined();
		f.options.current = () => false; f.surface.refresh(); f.surface.close(); finish(f.evidence); await settle();
		expect(f.root.querySelector(".relay-image-presence")).toBeNull(); expect(f.options.publish.mock.calls.every(call => call[0] === null)).toBe(true);
	} finally { f.close(); }
});

test("source changes withdraw local motion and remap a remote relative occurrence without guessing", async () => {
	const f = fixture();
	try {
		const embed = await f.embed(); f.surface.setPeers([{ target, embed }], [peer]); f.point(); await settle();
		f.text.insert(0, "Introduction\n\n"); expect(f.options.publish).toHaveBeenLastCalledWith(null); expect(f.surface.position(peer)).toBeUndefined();
		await settle(); expect(f.surface.position(peer)).toMatchObject({ from: f.anchors.images[1].from });
		const selected = f.anchors.images[1]; f.text.delete(selected.from, selected.to - selected.from); await settle();
		expect(f.surface.position(peer)).toBeUndefined(); expect(f.root.querySelector(".relay-image-presence-pointer")).toBeNull();
	} finally { f.close(); }
});

test("unavailable image checks stay bounded until explicit retry and navigation waits cancel on close", async () => {
	const f = fixture();
	try {
		f.assets.verifyRendered.mockRejectedValueOnce(new Error("Unavailable")); f.point(); await settle();
		for (let i = 0; i < 10; i++) { f.point(); await settle(); }
		expect(f.assets.verifyRendered).toHaveBeenCalledTimes(1);
		f.surface.retry(); f.point(); await settle(); expect(f.assets.verifyRendered).toHaveBeenCalledTimes(2);
		const embed = await f.embed(); f.options.targets.mockReturnValue([]); f.surface.setPeers([{ target, embed }], [peer]); await settle();
		const waiting = f.surface.revealAfterLayout(peer, false, () => true); f.surface.close(); expect(await waiting).toBe(false);
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});


test("external images publish only URL hashes and touch release clears their pointer", async () => {
    const f = fixture(), url = "https://example.com/diagram.png";
    try {
        const external = { kind: "external" as const, url, version_evidence: "unknown" as const };
        f.assets.describe.mockReturnValue(external); f.evidence.asset = external;
        f.text.delete(0, f.text.length); f.text.insert(0, `![image](${url})\n\n![image](${url})`);
        f.images.forEach(image => { image.src = url; }); await settle();
        f.images[1].dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 250 }), { pointerType: "touch" })); await settle();
        const embed = f.options.publish.mock.calls.map(call => call[0] as EmbeddedImage | null).filter(Boolean).at(-1)!;
        expect(embed.asset).toMatchObject({ kind: "external", version_evidence: "unknown", url_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(JSON.stringify(embed)).not.toContain(url); expect(f.options.read).not.toHaveBeenCalled();
        expect(await f.anchors.resolve(embed)).toEqual(f.anchors.images[1]);
        f.images[1].dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerType: "touch" })); expect(f.options.publish).toHaveBeenLastCalledWith(null);
    } finally { f.close(); }
});

test("other collaboration overlays do not invalidate image source or restart byte checks", async () => {
    const f = fixture();
    try {
        f.point(); await settle(); f.options.publish.mockClear();
        const layer = f.root.appendChild(document.createElement("div")); layer.className = "relay-reading-presence";
        layer.appendChild(document.createElement("span")).textContent = "Member";
        layer.appendChild(document.createElement("img")).dispatchEvent(new Event("load")); await settle();
        layer.replaceChildren(document.createElement("span")); await settle(); layer.remove(); await settle();
        expect(f.assets.verifyRendered).toHaveBeenCalledTimes(1);
        expect(f.options.publish).not.toHaveBeenCalledWith(null);
        expect(f.root.querySelectorAll(".relay-image-presence")).toHaveLength(1);
    } finally { f.close(); }
});


test("failed metadata is not polled by movement and becomes retryable after a source change", async () => {
    const f = fixture();
    try {
        f.options.read.mockRejectedValueOnce(new Error("Offline"));
        f.surface.setPeers([{ target, embed: await f.embed() }], [peer]); await settle();
        for (let i = 0; i < 10; i++) { f.surface.refresh(); await settle(); }
        expect(f.options.read).toHaveBeenCalledTimes(1); expect(f.surface.unavailable).toBe(true);
        f.text.insert(0, "Introduction\n\n"); await settle();
        expect(f.options.read).toHaveBeenCalledTimes(2); expect(f.surface.position(peer)).toMatchObject({ from: f.anchors.images[1].from });
        expect(f.surface.unavailable).toBe(false);
    } finally { f.close(); }
});
