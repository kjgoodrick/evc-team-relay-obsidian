import * as Y from "yjs";
import { createHash } from "node:crypto";
import { EmbeddedImageAnchors } from "../../src/collaboration/presence/EmbeddedImageAnchors";
const asset = { kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown" } as const;
const basis = { width: 640, height: 480, orientation: "display" } as const;
const state = { pointer: { x: 0.5, y: 0.5 }, viewport: null };
function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![same](https://example.com/a.png)\n\n![same](https://example.com/a.png)");
	const digest = jest.fn(async (data: ArrayBuffer) => createHash("sha256").update(new Uint8Array(data)).digest("hex"));
	const anchors = new EmbeddedImageAnchors(text, digest);
	return { doc, text, digest, anchors, close: () => { anchors.close(); doc.destroy(); } };
}
test("the second identical image keeps its own relative source identity across remote edits", async () => {
	const f = fixture(), other = new Y.Doc();
	try {
		Y.applyUpdate(other, Y.encodeStateAsUpdate(f.doc));
		const embed = (await f.anchors.capture(f.anchors.images[1], asset, basis, state))!;
		const initial = await f.anchors.resolve(embed); expect(initial).toEqual(f.anchors.images[1]);
		other.getText("contents").insert(0, "# Introduction\n\n"); Y.applyUpdate(f.doc, Y.encodeStateAsUpdate(other));
		const moved = await f.anchors.resolve(embed); expect(moved).toEqual(f.anchors.images[1]); expect(moved!.from).toBeGreaterThan(initial!.from);
		f.text.delete(f.anchors.images[0].from, f.anchors.images[0].to);
		expect(await f.anchors.resolve(embed)).toEqual(f.anchors.images[0]);
	} finally { f.close(); other.destroy(); }
});
test.each(["delete", "replace", "inside", "different_source_hash"])("never reattaches stale image presence after %s", async change => {
	const f = fixture();
	try {
		const occurrence = f.anchors.images[0], embed = (await f.anchors.capture(occurrence, asset, basis, state))!;
		if (change === "different_source_hash") expect(await f.anchors.resolve({ ...embed, source_sha256: "f".repeat(64) })).toBeUndefined();
		else {
			if (change === "inside") f.text.insert(occurrence.from + 4, "new");
			else { f.text.delete(occurrence.from, occurrence.to - occurrence.from); if (change === "replace") f.text.insert(occurrence.from, "![same](https://example.com/other.png)"); }
			expect(await f.anchors.resolve(embed)).toBeUndefined();
		}
	} finally { f.close(); }
});
test("movement reuses parsed source and cached syntax hashes, including repeated images", async () => {
	const f = fixture();
	try {
		const images = f.anchors.images, embed = (await f.anchors.capture(images[0], asset, basis, state))!;
		await f.anchors.capture(images[1], asset, basis, state);
		for (let x = 0; x < 100; x++) await f.anchors.resolve({ ...embed, state: { pointer: { x: x / 100, y: 0 }, viewport: null } });
		expect(f.digest).toHaveBeenCalledTimes(1); expect(f.anchors.images).toBe(images);
	} finally { f.close(); }
});
test("an asynchronous hash cannot create or resolve against a changed or closed source", async () => {
	const f = fixture();
	try {
		let finish!: (hash: string) => void;
		f.digest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const pending = f.anchors.capture(f.anchors.images[0], asset, basis, state);
		f.text.insert(0, "new\n"); finish("c".repeat(64)); expect(await pending).toBeUndefined();
		const first = f.anchors.images[0];
		const embed = await f.anchors.capture(first, asset, basis, state); expect(embed).toBeDefined();
		f.anchors.close(); expect(await f.anchors.resolve(embed!)).toBeUndefined(); expect(f.anchors.images).toEqual([]);
	} finally { f.close(); }
});
test("capture requires an actual parsed image, and resolution requires a forward image interval", async () => {
	const f = fixture();
	try {
		const first = f.anchors.images[0];
		expect(await f.anchors.capture({ ...first, from: 1 }, asset, basis, state)).toBeUndefined();
		const embed = (await f.anchors.capture(first, asset, basis, state))!;
		for (const occurrence of [{ anchor: embed.occurrence.head, head: embed.occurrence.anchor }, { anchor: embed.occurrence.anchor, head: embed.occurrence.anchor }]) expect(await f.anchors.resolve({ ...embed, occurrence })).toBeUndefined();
	} finally { f.close(); }
});
