import * as Y from "yjs";
import { toBase64 } from "lib0/buffer";
import { captureTextAnchor, containsSnapshot, resolveTextAnchor } from "../../src/collaboration/anchors/text";

function setup(source = "alpha beta gamma") {
	const doc = new Y.Doc(), text = doc.getText("contents");
	text.insert(0, source);
	const capture = (from: number, to: number) => captureTextAnchor(text, "note", "generation", from, to);
	const resolve = (anchor: ReturnType<typeof capture>) => resolveTextAnchor(text, "note", "generation", anchor);
	return { doc, text, capture, resolve };
}

test("edge insertions stay outside the range; interior changes stay inside", () => {
	const { doc, text, capture, resolve } = setup();
	const anchor = capture(10, 6);
	text.insert(10, "after"); text.insert(6, "before"); text.insert(13, "inside");
	expect(resolve(anchor)).toEqual({ status: "attached", from: 12, to: 22 });
	doc.destroy();
});

test.each(["delete", "cut-paste", "replace"])("%s preserves discussion but does not guess a new target", action => {
	const { doc, text, capture, resolve } = setup();
	const anchor = capture(6, 10);
	if (action === "replace") { text.delete(0, text.length); text.insert(0, "alpha beta gamma"); }
	else { text.delete(6, 4); if (action === "cut-paste") text.insert(text.length, " beta"); }
	expect(resolve(anchor)).toEqual({ status: "unanchored" });
	doc.destroy();
});

test("delete-only causal dependency cannot be proved by a state vector", () => {
	const { doc, text, capture } = setup();
	const peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	text.delete(0, 6);
	const anchor = capture(0, 4);
	expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(peer));
	expect(containsSnapshot(Y.snapshot(peer), Y.snapshot(doc))).toBe(false);
	expect(resolveTextAnchor(peer.getText("contents"), "note", "generation", anchor)).toEqual({ status: "waiting_for_sync" });
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	expect(resolveTextAnchor(peer.getText("contents"), "note", "generation", anchor)).toEqual({ status: "attached", from: 0, to: 4 });
	doc.destroy(); peer.destroy();
});

test("full update restore preserves UTF-16 positions and generation rejects plain-text recreation", () => {
	const { doc, capture } = setup("🙂 café e\u0301 العربية");
	const anchor = capture(3, 7), restored = new Y.Doc();
	Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
	expect(resolveTextAnchor(restored.getText("contents"), "note", "generation", anchor)).toEqual({ status: "attached", from: 3, to: 7 });
	expect(resolveTextAnchor(restored.getText("contents"), "note", "new-generation", anchor)).toEqual({ status: "generation_mismatch" });
	doc.destroy(); restored.destroy();
});

test("rejects wrong shared type, malformed encodings and invalid selections", () => {
	const { doc, text, capture, resolve } = setup();
	const anchor = capture(6, 10), other = doc.getText("secret"); other.insert(0, "other");
	const foreign = toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(other, 1)));
	expect(resolve({ ...anchor, start: foreign })).toEqual({ status: "invalid" });
	expect(resolve({ ...anchor, dependency: "!bad" })).toEqual({ status: "invalid" });
	expect(resolve({ ...anchor, start: "a".repeat(2000) })).toEqual({ status: "invalid" });
	expect(() => capture(-1, 0)).toThrow();
	expect(() => capture(0, text.length + 1)).toThrow();
	doc.destroy();
});

test("insertion dependencies wait, and a point anchor stays a point", () => {
	const { doc, text, capture } = setup(); const peer = new Y.Doc();
	Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
	text.insert(0, "new "); const anchor = capture(0, 3);
	expect(resolveTextAnchor(peer.getText("contents"), "note", "generation", anchor)).toEqual({ status: "waiting_for_sync" });
	const point = capture(4, 4); text.insert(4, "insert");
	expect(resolveTextAnchor(text, "note", "generation", point)).toEqual({ status: "attached", from: 10, to: 10 });
	doc.destroy(); peer.destroy();
});
