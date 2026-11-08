import { compareRestoreInventory } from "../../src/client/managedRestoreInspection";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
const note = (id: string): ItemRecord => ({ id, type: ItemKind.Document, version: 0 });

test("inventory comparison distinguishes retained, visible, moved, same and changed metadata entries", () => {
	const local = { "Keep.md": note("same"), "Local.md": note("moved"), "Only.md": note("local"), "Changed.md": note("metadata") };
	const remote = { "Keep.md": note("same"), "Server.md": note("moved"), "Added.md": note("remote"), "Changed.md": { ...note("metadata"), hash: "changed" } };
	const rows = compareRestoreInventory(local, remote);
	expect(Object.fromEntries(rows.map(row => [row.id, row.status]))).toEqual({ same: "same", moved: "moved", local: "local-only", remote: "server-only", metadata: "metadata-changed" });
	expect(rows.find(row => row.id === "moved")).toMatchObject({ localPaths: ["Local.md"], serverPaths: ["Server.md"], occupiedPath: false });
});

test("replaced paths retain both identities instead of pretending their contents match", () => {
	const rows = compareRestoreInventory({ "Note.md": note("before") }, { "Note.md": note("after") });
	expect(rows).toHaveLength(2); expect(rows.every(row => row.occupiedPath)).toBe(true);
	expect(rows.map(row => row.status).sort()).toEqual(["local-only", "server-only"]);
});

test("duplicate identities and kind changes are explicitly ambiguous", () => {
	const rows = compareRestoreInventory({ "First.md": note("duplicate"), "Second.md": note("duplicate"), "Kind.md": note("kind") },
		{ "First.md": note("duplicate"), "Kind.md": { id: "kind", type: ItemKind.Canvas, version: 0 } });
	expect(rows.every(row => row.status === "ambiguous")).toBe(true);
});

test("prototype-looking paths are compared as ordinary own entries", () => {
	const local = JSON.parse('{"__proto__":{"id":"own","type":"markdown","version":0},"constructor":{"id":"other","type":"markdown","version":0}}');
	expect(compareRestoreInventory(local, {}).every(row => row.status === "local-only" && !row.occupiedPath)).toBe(true);
});
