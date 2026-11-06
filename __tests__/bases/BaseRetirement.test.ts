import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TFile, TFolder, type Vault } from "obsidian";
import { BaseRetirementController } from "../../src/bases/BaseRetirement";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { BaseSyncRunner, type BaseSyncLock } from "../../src/bases/BaseSyncRunner";
import { retiredBaseEntries } from "../../src/bases/BaseContentProtocol";
import { sha256Hex } from "../../src/contentDigest";
import { isConflictCopyPath } from "../../src/conflictCopyPath";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entryId = id(3), path = "Former-base.txt", absolute = "Team/" + path;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (value: ArrayBuffer | null | undefined) => value ? new TextDecoder().decode(value) : null;
const lock: BaseSyncLock = async (_id, action) => action();

async function fixture(quota?: number) {
	Object.assign(globalThis, { IDBKeyRange });
	const factory = new IDBFactory(), identity = { serverId: "https://bases.fixture", accountId: id(1), shareId: id(2), vaultId: "vault" };
	let store = await BaseSyncStore.open(identity, factory, quota), current = true;
	const nodes = new Map<string, TFile | TFolder>(), contents = new Map<string, ArrayBuffer>();
	const put = (path: string, value: string, replace = false) => {
		const node = !replace && nodes.get(path) || Object.assign(Object.create(TFile.prototype) as TFile, { path, stat: { size: 0 } });
		Object.assign(node, { stat: { size: bytes(value).byteLength } }); nodes.set(path, node); contents.set(path, bytes(value)); return node;
	};
	put(absolute, "local edit"); let beforeRename = () => {}, afterRename = () => {};
	const vault = {
		getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
		readBinary: jest.fn(async (file: TFile) => contents.get(file.path)!.slice(0)),
		createFolder: jest.fn(async (path: string) => {
			if (nodes.has(path)) throw new Error("occupied"); const folder = Object.assign(Object.create(TFolder.prototype) as TFolder, { path }); nodes.set(path, folder); return folder;
		}),
		rename: jest.fn(async (file: TFile, destination: string) => {
			beforeRename();
			if (nodes.get(file.path) !== file || nodes.has(destination)) throw new Error("changed");
			const data = contents.get(file.path)!; contents.delete(file.path); nodes.delete(file.path);
			file.path = destination; nodes.set(destination, file); contents.set(destination, data); afterRename();
		}),
	};
	const access = { current: () => current, absolute: (path: string) => "Team/" + path, refresh: jest.fn(async () => {}) };
	const make = () => new BaseRetirementController(store, vault as unknown as Vault, access, lock);
	let controller = make();
	const baseline = { state: { path, generation: id(4), content_version: id(5), record: { id: entryId, type: "file" as const, version: 0 as const, hash: await sha256Hex(bytes("base")) } }, bytes: bytes("base") };
	await store.adopt(entryId, 0, baseline);
	return { get store() { return store; }, get controller() { return controller; }, access, vault, nodes, contents, put, baseline,
		current: (value: boolean) => { current = value; }, beforeRename: (run: () => void) => { beforeRename = run; }, afterRename: (run: () => void) => { afterRename = run; },
		restart: async () => { store.close(); store = await BaseSyncStore.open(identity, factory, quota); controller = make(); }, close: () => store.close() };
}

test("removal retains pending publication and both original and newly reviewed edits before moving outside sync", async () => {
	const s = await fixture(); try {
		const pending = await s.store.stage(entryId, 1, s.baseline.state, bytes("pending"));
		expect(await s.controller.observe(entryId, path)).toBe(true);
		s.put(absolute, "later local edit");
		const review = (await s.controller.review(entryId))!, destination = (await s.controller.move(entryId, review))!;
		expect(isConflictCopyPath(destination)).toBe(true); expect(s.nodes.has(absolute)).toBe(false);
		expect(text(s.contents.get(destination))).toBe("later local edit");
		const record = await s.store.get(entryId);
		expect(record.pending?.operationId).toBe(pending.operationId);
		expect(text(record.retirement?.local)).toBe("local edit");
		expect(text(record.retirement?.move?.local)).toBe("later local edit"); expect(record.retirement?.move?.state).toBe("complete");
		expect((await s.store.recoveries(entryId))[0].record.pending?.bytes).toEqual(bytes("pending"));
	} finally { s.close(); }
});

test("a crash after native rename recovers its committed intent without moving twice", async () => {
	const s = await fixture(); try {
		await s.controller.observe(entryId, path); s.afterRename(() => { throw new Error("process stopped after move"); });
		await expect(s.controller.move(entryId, (await s.controller.review(entryId))!)).rejects.toThrow("process stopped");
		const destination = (await s.store.get(entryId)).retirement!.move!.path;
		await s.restart(); s.afterRename(() => {});
		expect(await s.controller.move(entryId, (await s.controller.review(entryId))!)).toBe(destination);
		expect(s.vault.rename).toHaveBeenCalledTimes(1); expect((await s.store.get(entryId)).retirement?.move?.state).toBe("complete");
	} finally { s.close(); }
});

test.each(["edit", "replace"])("a %s after review cannot move a file under stale authorization", async action => {
	const s = await fixture(); try {
		await s.controller.observe(entryId, path); const review = (await s.controller.review(entryId))!;
		s.put(absolute, action === "edit" ? "new edit" : "local edit", action === "replace");
		await expect(s.controller.move(entryId, review)).rejects.toThrow("base_review_changed"); expect(s.vault.rename).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("a racing edit inside native rename is retained in the moved file and the reviewed snapshot stays durable", async () => {
	const s = await fixture(); try {
		await s.controller.observe(entryId, path); s.beforeRename(() => { s.put(absolute, "last instant edit"); });
		const destination = (await s.controller.move(entryId, (await s.controller.review(entryId))!))!;
		expect(text(s.contents.get(destination))).toBe("last instant edit"); expect(text((await s.store.get(entryId)).retirement?.move?.local)).toBe("local edit");
	} finally { s.close(); }
});

test("permission loss or replacement at the server blocks a previously reviewed move", async () => {
	const s = await fixture(); try {
		await s.controller.observe(entryId, path); const review = (await s.controller.review(entryId))!;
		s.access.refresh.mockImplementationOnce(async () => { s.current(false); });
		await expect(s.controller.move(entryId, review)).rejects.toThrow("base_context_changed");
		expect(s.vault.rename).not.toHaveBeenCalled(); expect(text(s.contents.get(absolute))).toBe("local edit");
	} finally { s.close(); }
});

test("occupied recovery destinations preserve both files and the prepared move", async () => {
	const s = await fixture(); try {
		await s.controller.observe(entryId, path); s.beforeRename(() => { throw new Error("interrupted before rename"); });
		await expect(s.controller.move(entryId, (await s.controller.review(entryId))!)).rejects.toThrow("interrupted");
		const destination = (await s.store.get(entryId)).retirement!.move!.path; s.put(destination, "unrelated file");
		s.beforeRename(() => {});
		await expect(s.controller.move(entryId, (await s.controller.review(entryId))!)).rejects.toThrow("occupied");
		expect(text(s.contents.get(absolute))).toBe("local edit"); expect(text(s.contents.get(destination))).toBe("unrelated file");
	} finally { s.close(); }
});

test("quota failure rolls back retirement without dropping a pending edit or moving disk data", async () => {
	const s = await fixture(25); try {
		await s.store.stage(entryId, 1, s.baseline.state, bytes("pending"));
		await expect(s.controller.observe(entryId, path)).rejects.toThrow("quota");
		expect((await s.store.get(entryId)).pending?.bytes).toEqual(bytes("pending")); expect((await s.store.get(entryId)).retirement).toBeUndefined();
		expect(await s.store.recoveries(entryId)).toHaveLength(0); expect(s.vault.rename).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("unknown tombstones cannot capture unrelated local files; retired cache prevents old publication after restore", async () => {
	const s = await fixture(); try {
		expect(await s.controller.observe(id(99), path)).toBe(false); expect(s.vault.readBinary).not.toHaveBeenCalled();
		await s.controller.observe(entryId, path); await s.restart();
		const transport = { read: jest.fn(), publish: jest.fn(), withdraw: jest.fn() };
		const runner = new BaseSyncRunner(s.store, transport, lock);
		await expect(runner.sync(entryId, { path, current: () => true, writable: () => true, canInitialize: false, read: jest.fn(), replace: jest.fn() })).rejects.toThrow("base_entry_retired");
		expect(transport.read).not.toHaveBeenCalled(); expect(transport.publish).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("guarded retirement metadata requires matching identity and a safe explicit tombstone path", () => {
	expect(retiredBaseEntries({ base_content: { retired: { [entryId]: path } }, deleted: { [path]: [entryId] } })).toEqual([[entryId, path]]);
	for (const bad of ["../escape", "a/../b", "/absolute", "a\\b", ".hidden", "a\nfile"]) expect(retiredBaseEntries({ base_content: { retired: { [entryId]: bad } }, deleted: { [bad]: [entryId] } })).toEqual([]);
	expect(retiredBaseEntries({ base_content: { retired: { [entryId]: path } }, deleted: { [path]: [id(99)] } })).toEqual([]);
	expect(retiredBaseEntries({ base_content: { retired: { [entryId]: path } } })).toEqual([]);
});
