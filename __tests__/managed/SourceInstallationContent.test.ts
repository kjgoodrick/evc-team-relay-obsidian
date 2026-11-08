import * as Y from "yjs";
import { ItemKind } from "../../src/ItemKinds";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../../src/conflictCopyPath";
import type { SourceInstallationPlan } from "../../src/SourceInstallationPlan";
import type { ManagedManifest } from "../../src/client/ManagedIndexTransport";
import { buildInstallationInventory, installationSourceBytes, validateInstallationInventory } from "../../src/SourceInstallationContent";
import { CanvasDocument } from "../../src/CanvasDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const artifact = { bytes: 0, sha256: "a".repeat(64) };
function plan(): SourceInstallationPlan {
	return { format: "team-relay-source-installation", version: 1, id: id(1), reviewId: id(2), source: {
		hostAppId: "fixture", serverId: "server", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", id(3))), restoreGeneration: id(4),
	}, archive: { path: RECOVERY_FOLDER + "/archive", manifestSha256: "b".repeat(64) }, originalRoot: "Team", destinationRoot: "Restored", mode: "new-folder",
		inventory: artifact, entries: [{ path: "Note.md", record: { id: id(5), type: ItemKind.Document, version: 0 }, file: artifact, source: artifact }] };
}
function snapshot(p: SourceInstallationPlan): ManagedManifest {
	return { records: Object.fromEntries(p.entries.map(entry => [entry.path, entry.record])), permissions: { "Note.md": "read" }, activity: { [id(5)]: "2026-11-08T00:00:00Z" },
		owner: false, restore_guard: true, restore_generation: p.source.restoreGeneration };
}
function update(change: (doc: Y.Doc) => void, previous?: Uint8Array): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	try { if (previous) Y.applyUpdate(doc, previous); change(doc); return Y.encodeStateAsUpdate(doc); }
	finally { doc.destroy(); }
}

test("fresh inventory agrees with all native records, flat note IDs, activity and the selected generation", () => {
	const p = plan(), input = snapshot(p), bytes = buildInstallationInventory(p, input);
	expect(() => validateInstallationInventory(p, bytes)).not.toThrow();
	const before = new Uint8Array(bytes); validateInstallationInventory(p, bytes); expect(bytes).toEqual(before);
	const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
	try {
		expect(doc.getMap("filemeta_v0").toJSON()).toEqual(input.records);
		expect(doc.getMap("docs").toJSON()).toEqual({ "Note.md": id(5) });
		expect(doc.getMap("managed_base_v1").toJSON()).toEqual({ snapshot: input });
	} finally { doc.destroy(); }
});

test("a newly built inventory excludes old optional catalogs and deletion receipts", () => {
	const p = plan(), input = { ...snapshot(p), deleted: { "Old.md": [id(99)] }, base_content: { protocol_version: 1, enabled: true, recovery: true, versions: {} } };
	const bytes = buildInstallationInventory(p, input); expect(() => validateInstallationInventory(p, bytes)).not.toThrow();
	const doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
	try { expect(doc.getMap("managed_base_v1").get("snapshot")).not.toHaveProperty("deleted"); expect(doc.getMap("managed_base_v1").get("snapshot")).not.toHaveProperty("base_content"); }
	finally { doc.destroy(); }
});

test("empty visibility still requires object-shaped record and permission maps", () => {
	const p = plan(); p.entries = [];
	const input = { records: [], permissions: {}, activity: {}, owner: false, restore_guard: true, restore_generation: p.source.restoreGeneration };
	expect(() => buildInstallationInventory(p, input as unknown as ManagedManifest)).toThrow();
});

test.each([
	["old generation", (s: any) => { s.restore_generation = id(99); }],
	["missing generation", (s: any) => { delete s.restore_generation; }],
	["unsupported guard", (s: any) => { s.restore_guard = false; }],
	["invisible record", (s: any) => { s.records = {}; }],
	["extra record", (s: any) => { s.records["Extra.md"] = s.records["Note.md"]; }],
	["missing permission", (s: any) => { s.permissions = {}; }],
	["denied permission", (s: any) => { s.permissions["Note.md"] = "none"; }],
	["unknown permission", (s: any) => { s.permissions["Note.md"] = "admin"; }],
	["unknown activity", (s: any) => { s.activity[id(99)] = "later"; }],
])("a manifest with %s cannot seed the selected cache", (_label, change) => {
	const p = plan(), input = snapshot(p); change(input); expect(() => buildInstallationInventory(p, input)).toThrow();
});

test.each([
	["retained conflict", (d: Y.Doc) => d.getMap("managed_conflicts_v1").set("conflict", {})],
	["pending restore", (d: Y.Doc) => d.getMap("managed_base_v1").set("restoreReview", {})],
	["extra root", (d: Y.Doc) => d.getMap("unknown").set("data", "retained")],
	["unsent rename", (d: Y.Doc) => { const records = d.getMap("filemeta_v0"); records.set("Moved.md", records.get("Note.md")); records.delete("Note.md"); }],
	["flat mismatch", (d: Y.Doc) => d.getMap("docs").set("Note.md", id(99))],
	["activity mismatch", (d: Y.Doc) => d.getMap("docactivity_v0").set(id(5), "different")],
	["snapshot mismatch", (d: Y.Doc) => { const base = d.getMap<ManagedManifest>("managed_base_v1"); base.set("snapshot", { ...base.get("snapshot")!, restore_generation: id(99) }); }],
])("a staged inventory with %s is refused", (_label, change) => {
	const p = plan(), bytes = update(change, buildInstallationInventory(p, snapshot(p)));
	expect(() => validateInstallationInventory(p, bytes)).toThrow();
});

test("Markdown source projects exact UTF-8 including emoji, line endings and literal markup", () => {
	const text = "# Note\r\n😀 <img src=x>\n", bytes = update(doc => doc.getText("contents").insert(0, text));
	expect(new Uint8Array(installationSourceBytes("markdown", bytes))).toEqual(new TextEncoder().encode(text));
	expect(installationSourceBytes("markdown", new Uint8Array([0, 0])).byteLength).toBe(0);
});

test("Canvas verification shares the live save projection and does not mutate source bytes", () => {
	const bytes = update(doc => {
		doc.getMap("nodes").set("text", { id: "text", type: "text", text: "seed", x: 1, y: 2, width: 3, height: 4 });
		doc.getText("text").insert(0, "live text");
		doc.getMap("nodes").set("link", { id: "link", type: "link", url: "https://example.test" });
		doc.getMap("edges").set("edge", { id: "edge", fromNode: "text", toNode: "link" });
	});
	const before = new Uint8Array(bytes), doc = new Y.Doc(); Y.applyUpdate(doc, bytes);
	try { expect(new TextDecoder().decode(installationSourceBytes("canvas", bytes))).toBe(JSON.stringify(CanvasDocument.exportData(doc), null, 2)); }
	finally { doc.destroy(); }
	expect(bytes).toEqual(before);
});

test("Canvas installation preserves a cleared card instead of reviving its legacy metadata text", () => {
	const bytes = update(doc => {
		doc.getMap("nodes").set("card", { id: "card", type: "text", text: "older text", x: 1, y: 2, width: 3, height: 4 });
		const text = doc.getText("card"); text.insert(0, "newer text"); text.delete(0, text.length);
	});
	const before = new Uint8Array(bytes);
	const projected = JSON.parse(new TextDecoder().decode(installationSourceBytes("canvas", bytes)));
	expect(projected.nodes[0].text).toBe(""); expect(bytes).toEqual(before);
});

test.each(["insertion", "deletion"])("an unresolved %s dependency cannot project apparently complete text", kind => {
	const doc = new Y.Doc({ gc: false });
	try {
		doc.getText("contents").insert(0, "Base"); const vector = Y.encodeStateVector(doc);
		if (kind === "insertion") doc.getText("contents").insert(4, " later"); else doc.getText("contents").delete(0, 4);
		const delta = Y.encodeStateAsUpdate(doc, vector);
		expect(() => installationSourceBytes("markdown", delta)).toThrow("incomplete changes");
		expect(() => validateInstallationInventory(plan(), delta)).toThrow("incomplete changes");
	} finally { doc.destroy(); }
});

test.each(["empty", "malformed", "oversized"])("%s history cannot seed native content", kind => {
	const bytes = kind === "empty" ? new Uint8Array() : kind === "malformed" ? new Uint8Array([255, 255]) : new Uint8Array(16 * 1024 * 1024 + 1);
	expect(() => installationSourceBytes("markdown", bytes)).toThrow();
});
