import "fake-indexeddb/auto";
import * as Y from "yjs";
import type { TFile } from "obsidian";
import { createHash } from "node:crypto";
import { NativeBaseGroupComments, type NativeGroupSources } from "../../src/collaboration/NativeBaseGroupComments";
import { captureBaseGroupValue, revealBaseGroupValue } from "../../src/collaboration/BaseGroupValueBridge";
import type { NativeBaseGroupHandle, NativeBaseGroupTarget } from "../../src/bases/NativeBasesSurface";
import type { NativeBaseGroupValue } from "../../src/bases/NativeBaseGroupValue";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";
import type { BaseGroupCapture } from "../../src/collaboration/BaseGroupProtocol";
import type { PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { retainedBaseGroupSources } from "../../src/collaboration/RetainedBaseGroupSources";
import { LocalDocumentStore } from "../../src/storage/local-document-store";

const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const file = (name: string) => ({ path: "Team/" + name, extension: "md" }) as TFile;
const hash = (path: string) => createHash("sha256").update(path).digest("hex");
function fixture(value: NativeBaseGroupValue = { type: "text", value: "Done" }) {
	const a = file("A.md"), b = file("B.md"), doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "---\nstatus: Done\n---\nBody");
	let current = true, ready = true, members = [b, a];
	const catalog: BaseDefinitionCatalog = { protocol_version: 1, entry_id: id(1), view_id: id(2), definition_id: id(3), generation: id(4), registry_revision: 1,
		computed_values: false, targets: [{ kind: "group", id: id(5), revision: 1, property: { source: "note", name: "status" }, fingerprint: "a".repeat(64) }] };
	const target: NativeBaseGroupTarget = { type: "group", property: { source: "note", name: "status" }, value };
	const handle: NativeBaseGroupHandle = { target, element: {} as HTMLElement, ambiguous: false, current: () => current, members: () => members };
	const records = new Map([[a, { id: id(6), type: "markdown" as const, path: "A.md" }], [b, { id: id(7), type: "markdown" as const, path: "B.md" }]]);
	const session = { canAnchorBase: () => true, permission: () => ({ read: true, comment: true }),
		readBaseContext: jest.fn(async (_scope: string, record: string) => ({ ...catalog, record_id: record, record_generation: id(8) })),
		captureBaseGroupSelection: jest.fn(async (_scope: string, input: BaseGroupCapture): Promise<PendingBaseGroupAnchor> => ({ version: 1,
			type: "base_group_pending", entry_id: id(1), property: target.property, capture: { ...input, operation_id: id(9),
				definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1 } })) };
	const surface = { groupHandles: () => [handle], groupHit: () => [handle], revealGroup: jest.fn(() => "revealed") };
	const context = { session, entryId: baseDiscussionScope(id(1), id(2)), baseEntryId: id(1), binding: { snapshot: { revision: 1 } }, surface, current: () => current };
	const sources: NativeGroupSources = { record: f => records.get(f), file: id => [...records].find(([, record]) => record.id === id)?.[0],
		fileAtPath: path => [a, b].find(f => f.path === path) ?? null, source: () => ready ? { text, current: () => ready } : undefined,
		read: jest.fn(async () => text.toString()), resolve: () => null };
	const groups = new NativeBaseGroupComments(context as unknown as BaseCommentContext, catalog, sources);
	return { a, b, doc, text, handle, target, catalog, session, sources, groups, records, context,
		revoke() { current = false; }, unload() { ready = false; }, members(files: TFile[]) { members = files; } };
}
const fixtures: ReturnType<typeof fixture>[] = [];
function setup(value?: NativeBaseGroupValue) { const f = fixture(value); fixtures.push(f); return f; }
afterEach(() => { fixtures.splice(0).forEach(f => f.doc.destroy()); });

async function coldFixture() {
	const f = setup(), names = new Map<TFile, string>();
	async function persist(file: TFile, source = f.doc) {
		const name = `group-retained-${crypto.randomUUID()}`, doc = new Y.Doc(), store = new LocalDocumentStore(name, doc);
		await store.whenSynced; Y.applyUpdate(doc, Y.encodeStateAsUpdate(source)); await store.rememberServerSync();
		await store.close(); doc.destroy(); names.set(file, name);
	}
	f.unload();
	const loaded: Y.Doc[] = [];
	f.sources.retained = async (files, current) => {
		const candidates = await retainedBaseGroupSources(files, {
			key: file => names.has(file) ? { name: names.get(file)!, current: () => f.context.current() } : undefined,
			read: file => f.sources.read(file),
		}, current);
		return candidates.map(candidate => ({ file: candidate.file, load: async () => {
			const source = await candidate.load(); if (source) loaded.push(source.text.doc!); return source;
		} }));
	};
	return { ...f, persist, names, loaded };
}

test("captures from a closed actual document cache, keeps exact history and disposes the temporary document", async () => {
	const f = await coldFixture(); await f.persist(f.a);
	const captured = await f.groups.capture(f.handle);
	expect(captured.capture.record_id).toBe(id(6));
	expect(Y.equalSnapshots(Y.decodeSnapshot(Buffer.from(captured.capture.dependency, "base64")), Y.snapshot(f.doc))).toBe(true);
	expect(f.loaded).toHaveLength(1); expect(f.loaded[0].isDestroyed).toBe(true);
	expect(f.session.readBaseContext).toHaveBeenCalledWith(f.context.entryId, id(6));
});

test("tries a second cached member when the first is stale or unreadable", async () => {
	const f = await coldFixture(), stale = new Y.Doc(); stale.getText("contents").insert(0, "old source");
	await f.persist(f.a, stale); stale.destroy(); await f.persist(f.b);
	expect((await f.groups.capture(f.handle)).capture.record_id).toBe(id(7));
	const g = await coldFixture(); await g.persist(g.a); await g.persist(g.b);
	g.session.readBaseContext.mockImplementation(async (_scope, record) => {
		if (record === id(6)) throw new Error("Access denied");
		return { ...g.catalog, record_id: record, record_generation: id(8) };
	});
	expect((await g.groups.capture(g.handle)).capture.record_id).toBe(id(7));
	expect((g.sources.read as jest.Mock).mock.calls.every(([file]) => file === g.b)).toBe(true);
});

test("does not read retained content before source authorization and stops after revocation", async () => {
	const f = setup(); f.unload(); const load = jest.fn(async () => ({ text: f.text, current: () => true }));
	f.sources.retained = async () => [{ file: f.a, load }]; f.session.readBaseContext.mockRejectedValue(new Error("No source access"));
	await expect(f.groups.capture(f.handle)).rejects.toThrow("synchronized source"); expect(load).not.toHaveBeenCalled();
	const g = await coldFixture(); await g.persist(g.a);
	g.sources.read = async () => { g.revoke(); return g.text.toString(); };
	await expect(g.groups.capture(g.handle)).rejects.toThrow(); expect(g.session.captureBaseGroupSelection).not.toHaveBeenCalled();
});

test("disposes retained sources when membership or the final server lineage check changes", async () => {
	const f = await coldFixture(); await f.persist(f.a);
	const original = f.sources.retained!;
	f.sources.retained = async (files, current) => (await original(files, current)).map(candidate => ({ ...candidate, load: async () => {
		const source = await candidate.load(); f.members([f.b]); return source;
	} }));
	await expect(f.groups.capture(f.handle)).rejects.toThrow("still updating");
	expect(f.loaded[0].isDestroyed).toBe(true); expect(f.session.captureBaseGroupSelection).not.toHaveBeenCalled();
	const g = await coldFixture(); await g.persist(g.a); g.session.captureBaseGroupSelection.mockRejectedValue(new Error("Record generation changed"));
	await expect(g.groups.capture(g.handle)).rejects.toThrow("generation changed"); expect(g.loaded[0].isDestroyed).toBe(true);
});

test("uses loaded sources without scanning databases and freezes native values during cache discovery", async () => {
	const f = setup(); f.sources.retained = jest.fn(); await f.groups.capture(f.handle); expect(f.sources.retained).not.toHaveBeenCalled();
	const g = await coldFixture(); await g.persist(g.a); const original = g.sources.retained!;
	g.sources.retained = async (files, current) => { g.target.value = { type: "text", value: "Different" }; return original(files, current); };
	await expect(g.groups.capture(g.handle)).rejects.toThrow(); expect(g.session.captureBaseGroupSelection).not.toHaveBeenCalled();
});

test("native capture uses a stable existing source and an exact Yjs snapshot without opening or changing notes", async () => {
	const f = setup(), source = f.text.toString(), lookup = jest.spyOn(f.sources, "source");
	const captured = await f.groups.capture(f.handle); expect(lookup).toHaveBeenCalledTimes(1);
	expect(captured.capture.record_id).toBe(id(6)); expect(captured.capture.value).toEqual({ type: "text", value: "Done" });
	expect(Y.equalSnapshots(Y.decodeSnapshot(Buffer.from(captured.capture.dependency, "base64")), Y.snapshot(f.doc))).toBe(true);
	f.members([f.a, f.b]); expect((await f.groups.capture(f.handle)).capture.record_id).toBe(id(6));
	expect(f.text.toString()).toBe(source);
	expect(f.session.readBaseContext).toHaveBeenCalledWith(f.context.entryId, id(6));
	expect(f.sources.read).toHaveBeenCalledWith(f.a);
});

test("unloaded, unsynchronized and changed member sources fail without silently falling back to view comments", async () => {
	const f = setup(); f.unload(); await expect(f.groups.capture(f.handle)).rejects.toThrow("finish synchronizing");
	expect(f.sources.read).not.toHaveBeenCalled(); expect(f.session.captureBaseGroupSelection).not.toHaveBeenCalled();
	const g = setup(); (g.sources.read as jest.Mock).mockResolvedValue("Different source");
	await expect(g.groups.capture(g.handle)).rejects.toThrow("still updating"); expect(g.session.captureBaseGroupSelection).not.toHaveBeenCalled();
	const h = setup(); h.sources.read = async () => { h.members([h.b]); return h.text.toString(); };
	await expect(h.groups.capture(h.handle)).rejects.toThrow("still updating"); expect(h.session.captureBaseGroupSelection).not.toHaveBeenCalled();
});

test("account or source changes while verification is pending prevent saving the selection", async () => {
	const f = setup(); f.sources.read = async () => { f.revoke(); return f.text.toString(); };
	await expect(f.groups.capture(f.handle)).rejects.toThrow(); expect(f.session.captureBaseGroupSelection).not.toHaveBeenCalled();
	const g = setup(); g.sources.read = async () => { g.a.path = "Team/Moved.md"; return g.text.toString(); };
	await expect(g.groups.capture(g.handle)).rejects.toThrow(); expect(g.session.captureBaseGroupSelection).not.toHaveBeenCalled();
});

test("file and link values become managed references, deduplicate reads, and follow a verified rename", async () => {
	const f = setup(); f.target.value = { type: "list", value: [{ type: "link", file: f.b, subpath: "#Heading" }, { type: "file", file: f.b }] };
	const captured = await f.groups.capture(f.handle);
	expect(captured.capture.value).toEqual({ type: "list", value: [
		{ type: "link", record_id: id(7), record_generation: id(8), subpath: "#Heading" }, { type: "file", record_id: id(7), record_generation: id(8) }] });
	expect(f.session.readBaseContext.mock.calls.filter(([, record]) => record === id(7))).toHaveLength(1);
	f.b.path = "Team/Renamed.md"; f.records.set(f.b, { id: id(7), type: "markdown", path: "Renamed.md" });
	const native = await f.groups.native(captured);
	expect(native?.value).toEqual({ type: "list", value: [{ type: "link", file: f.b, subpath: "#Heading" }, { type: "file", file: f.b }] });
});

test("unresolved links retain source path evidence and refuse reinterpretation after a move", async () => {
	const f = setup(); f.target.value = { type: "unresolved_link", source: f.a.path, link: "Missing#Heading" };
	const captured = await f.groups.capture(f.handle);
	expect(captured.capture.value).toEqual({ type: "unresolved_link", record_id: id(6), record_generation: id(8), link: "Missing#Heading", source_path_sha256: hash("A.md") });
	expect((await f.groups.native(captured))?.value).toEqual(f.target.value);
	f.a.path = "Team/Moved.md"; f.records.set(f.a, { id: id(6), type: "markdown", path: "Moved.md" });
	expect(await f.groups.native(captured)).toBeUndefined();
});

test("unmanaged links, revoked references and replaced generations cannot be navigated or captured", async () => {
	const f = setup(); f.target.value = { type: "link", file: file("Private.md"), subpath: "" };
	await expect(f.groups.capture(f.handle)).rejects.toThrow("readable shared record");
	f.target.value = { type: "file", file: f.b }; const captured = await f.groups.capture(f.handle);
	f.session.readBaseContext.mockResolvedValue({ ...f.catalog, record_id: id(7), record_generation: id(99) });
	expect(await f.groups.native(captured)).toBeUndefined();
	f.session.readBaseContext.mockRejectedValue(new Error("Access denied")); expect(await f.groups.native(captured)).toBeUndefined();
});

test("historical or wrong-view definitions retain their targets without attaching to a current header", async () => {
	const f = setup(), captured = await f.groups.capture(f.handle);
	expect(await f.groups.native({ ...captured, entry_id: id(99) })).toBeUndefined();
	expect(await f.groups.native({ ...captured, capture: { ...captured.capture, group_definition_revision: 2 } })).toBeUndefined();
	const wire: BaseAnchor = { version: 1, type: "base", definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1,
		target: { type: "group", definition_id: id(5), definition_revision: 1, group_id: id(30), witness_id: id(31), property: f.target.property, value: { type: "text", value: "Done" } } };
	expect(await f.groups.native(wire)).toEqual(f.target);
	f.catalog.targets[0].revision = 2; expect(await f.groups.native(wire)).toBeUndefined();
});

test("the reference bridge freezes siblings before waiting and bounds malformed trees before identity reads", async () => {
	const f = setup(); let finish!: (ref: { record_id: string; record_generation: string }) => void;
	const refs = { file: jest.fn(() => new Promise<{ record_id: string; record_generation: string }>(resolve => { finish = resolve; })), source: jest.fn() };
	const sibling: NativeBaseGroupValue = { type: "text", value: "Original" };
	const capture = captureBaseGroupValue({ type: "list", value: [{ type: "file", file: f.a }, sibling] }, refs);
	sibling.value = "Changed"; finish({ record_id: id(6), record_generation: id(8) });
	expect(await capture).toMatchObject({ value: [{ type: "file" }, { type: "text", value: "Original" }] });
	const cyclic: NativeBaseGroupValue = { type: "list", value: [] }; cyclic.value.push(cyclic);
	await expect(captureBaseGroupValue(cyclic, refs)).rejects.toThrow("limits");
	await expect(captureBaseGroupValue({ type: "list", value: Array(257).fill({ type: "empty" }) }, refs)).rejects.toThrow("limits");
	expect(refs.file).toHaveBeenCalledTimes(1);
	await expect(revealBaseGroupValue({ type: "unresolved_link", record_id: id(6), record_generation: id(8), link: "Missing", source_path_sha256: hash("old") },
		async () => ({ file: f.a, sourcePathHash: hash("new") }))).rejects.toThrow("moved");
});
