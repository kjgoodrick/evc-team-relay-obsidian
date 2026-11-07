import * as Y from "yjs";
import { parseEmbeddedImage, parseEmbeddedPeers } from "../../src/collaboration/presence/EmbeddedImageProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const target = { user_id: id(1), session_id: "a".repeat(32), instance_id: id(2) };
const make = () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![one](one.png)");
	return { version: 1, occurrence: { anchor: Y.createRelativePositionFromTypeIndex(text, 0), head: Y.createRelativePositionFromTypeIndex(text, text.length, -1) },
		source_sha256: "b".repeat(64), asset: { kind: "managed", entry_id: id(3), generation: id(4), sha256: "c".repeat(64) },
		basis: { width: 640, height: 480, orientation: "display" }, state: { pointer: { x: 0.5, y: 1 }, viewport: null } };
};
test("copies and freezes Yjs intervals, authenticated identities, asset evidence and geometry", () => {
	const input = make(), result = parseEmbeddedPeers([{ target, embed: input }]);
	input.occurrence.anchor.item!.clock = 99; input.state.pointer.x = 0;
	expect(result[0].embed.occurrence.anchor.item!.clock).toBe(0);
	expect(result[0].embed.state.pointer!.x).toBe(0.5);
	for (const value of [result, result[0], result[0].target, result[0].embed, result[0].embed.asset, result[0].embed.basis, result[0].embed.occurrence, result[0].embed.occurrence.anchor.item]) expect(Object.isFrozen(value)).toBe(true);
});
test.each([
	{ version: true }, { source_sha256: "bad" }, { source: "private" },
	{ occurrence: { anchor: { tname: "contents", item: { client: true, clock: 0 } }, head: { tname: "contents" } } },
	{ occurrence: { anchor: { tname: "other" }, head: { tname: "contents" } } },
	{ basis: { width: 1000001, height: 1, orientation: "display" } },
	{ basis: { width: 1.5, height: 1, orientation: "display" } },
	{ state: { pointer: { x: 2, y: 0 }, viewport: null } },
	{ asset: { kind: "external", url_sha256: "d".repeat(64), version_evidence: "verified" } },
	{ asset: { kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown", url: "https://private.invalid" } },
])("rejects malformed or revealing embed fields: %j", patch => expect(() => parseEmbeddedImage({ ...make(), ...patch })).toThrow());
test("external version evidence remains explicitly unknown without transmitting its URL", () => {
	expect(parseEmbeddedImage({ ...make(), asset: { kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown" } }).asset).toEqual({ kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown" });
});
test("rejects duplicate, spoofed or unbounded participants", () => {
	const peer = { target, embed: make() };
	for (const input of [[peer, peer], Array.from({ length: 128 }, (_, i) => ({ ...peer, target: { ...target, instance_id: id(i) } })), [{ ...peer, name: "spoof" }], [{ ...peer, target: { ...target, session_id: "secret-session" } }]]) expect(() => parseEmbeddedPeers(input)).toThrow();
});
