import * as Y from "yjs";
import { captureTextAnchor } from "../../src/collaboration/anchors/text";
import { captureImageAnchor, markdownImages } from "../../src/collaboration/anchors/images";
import { wireTextAnchor, type BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";
import { noteTargetStatuses, imageFileTargetStatus, baseTargetStatus, targetNeedsReview } from "../../src/collaboration/CommentTargetStatus";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entryId = id(1), generation = id(2);
function note(value = "alpha beta gamma") {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, value);
	return { doc, text, evidence: { text, entryId, generation }, capture: (from: number, to: number) => wireTextAnchor(captureTextAnchor(text, entryId, generation, from, to)) };
}
test("local target status distinguishes attached, deleted and rebuilt selections without guessing", () => {
	const f = note(), anchor = f.capture(6, 10);
	try {
		expect(noteTargetStatuses([anchor], f.evidence)[0].state).toBe("attached");
		f.text.delete(6, 4); f.text.insert(f.text.length, " beta");
		expect(noteTargetStatuses([anchor], f.evidence)[0].state).toBe("unanchored");
		expect(noteTargetStatuses([anchor], { ...f.evidence, generation: id(9) })[0].state).toBe("changed");
		expect(noteTargetStatuses([anchor])[0].state).toBe("unknown");
	} finally { f.doc.destroy(); }
});
test("delete-only missing dependencies remain waiting instead of unanchored", () => {
	const f = note(), peer = new Y.Doc(); Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc));
	try {
		f.text.delete(0, 6); const anchor = f.capture(0, 4);
		const before = noteTargetStatuses([anchor], { ...f.evidence, text: peer.getText("contents") })[0];
		expect(before.state).toBe("waiting"); expect(targetNeedsReview(before)).toBe(false);
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(f.doc)); expect(noteTargetStatuses([anchor], { ...f.evidence, text: peer.getText("contents") })[0].state).toBe("attached");
	} finally { f.doc.destroy(); peer.destroy(); }
});
test("image occurrence and recorded asset changes are separate from inaccessible or external content", () => {
	const f = note("![Example](image.png)"), asset = { kind: "managed" as const, entry_id: id(3), sha256: "a".repeat(64) };
	try {
		const anchor = captureImageAnchor(f.text, entryId, generation, markdownImages(f.text.toString())[0], asset, { width: 10, height: 10, orientation: "display" }, { type: "whole" });
		expect(noteTargetStatuses([anchor], { ...f.evidence, asset: () => asset })[0].state).toBe("attached");
		expect(noteTargetStatuses([anchor], { ...f.evidence, asset: () => ({ ...asset, sha256: "b".repeat(64) }) })[0].state).toBe("changed");
		expect(noteTargetStatuses([anchor], { ...f.evidence, asset: () => { throw new Error("Access denied"); } })[0].state).toBe("unknown");
		const external = { kind: "external" as const, url: "https://example.test/image.png", version_evidence: "unknown" as const };
		expect(noteTargetStatuses([{ ...anchor, asset: external }], { ...f.evidence, asset: () => external })[0].state).toBe("unknown");
		f.text.delete(0, f.text.length); expect(noteTargetStatuses([anchor], f.evidence)[0].state).toBe("unanchored");
	} finally { f.doc.destroy(); }
});
test("direct image versions distinguish synchronization, content changes and unavailable evidence", () => {
	const asset = { kind: "managed" as const, entry_id: entryId, sha256: "a".repeat(64) };
	const anchor = { version: 1 as const, type: "image_file" as const, generation, asset, basis: { width: 10, height: 10, orientation: "display" as const }, geometry: { type: "whole" as const } };
	expect(imageFileTargetStatus(anchor).state).toBe("waiting"); expect(imageFileTargetStatus(anchor, generation).state).toBe("unknown");
	expect(imageFileTargetStatus(anchor, generation, asset).state).toBe("attached"); expect(imageFileTargetStatus(anchor, id(9), asset).state).toBe("changed");
});
const base = { version: 1 as const, type: "base" as const, definition_id: id(3), generation, view_id: id(4), registry_revision: 2 };
const catalog: BaseDefinitionCatalog = { protocol_version: 1, entry_id: entryId, definition_id: base.definition_id, generation, view_id: base.view_id, registry_revision: 2, computed_values: false,
	targets: [{ id: id(5), kind: "formula", revision: 2, fingerprint: "a".repeat(64), property: { source: "formula", name: "Score" } }] };
test("missing definitions need fresh proof, while stale catalogs and hidden records do not become unanchored", () => {
	const anchor: BaseAnchor = { ...base, target: { type: "formula", definition_id: id(5), definition_revision: 2, property: { source: "formula", name: "Score" } } };
	expect(baseTargetStatus(anchor, { generation, definitions: catalog, online: true }).state).toBe("attached");
	const missing = { ...catalog, targets: [] };
	expect(baseTargetStatus(anchor, { generation, definitions: missing, online: true }).state).toBe("unanchored");
	expect(baseTargetStatus(anchor, { generation, definitions: missing, online: false }).state).toBe("unknown");
	expect(baseTargetStatus(anchor, { generation, definitions: { ...missing, registry_revision: 1 }, online: true }).state).toBe("waiting");
	const cell: BaseAnchor = { ...base, target: { type: "cell", record_id: id(8), record_generation: id(9), property: { source: "note", name: "Status" } } };
	const hidden = baseTargetStatus(cell, { generation, definitions: catalog, online: true }); expect(hidden.state).toBe("unknown"); expect(targetNeedsReview(hidden)).toBe(false);
});

test("positive local group presence supplements matching definitions but never overrides changed or stale identity", () => {
	const property = { source: "note" as const, name: "Status" };
	const anchor: BaseAnchor = { ...base, target: { type: "group", definition_id: id(5), definition_revision: 2,
		property, value: { type: "text", value: "Ready" }, group_id: id(6), witness_id: id(7) } };
	const definitions: BaseDefinitionCatalog = { ...catalog, targets: [{ ...catalog.targets[0], kind: "group", property }] };
	const evidence = { generation, definitions, online: true, groupPresent: true };
	expect(baseTargetStatus(anchor, evidence).state).toBe("attached");
	expect(baseTargetStatus(anchor, { ...evidence, groupPresent: false }).state).toBe("unknown");
	expect(baseTargetStatus(anchor, { ...evidence, online: false }).message).toContain("local saved view");
	expect(baseTargetStatus(anchor, { ...evidence, generation: id(90) }).state).toBe("changed");
	expect(baseTargetStatus(anchor, { ...evidence, definitions: { ...definitions, registry_revision: 1 } }).state).toBe("waiting");
	expect(baseTargetStatus(anchor, { ...evidence, definitions: { ...definitions, targets: [{ ...definitions.targets[0], revision: 3 }] } }).state).toBe("changed");
	expect(baseTargetStatus(anchor, { ...evidence, definitions: { ...definitions, targets: [] } }).state).toBe("unanchored");
});
