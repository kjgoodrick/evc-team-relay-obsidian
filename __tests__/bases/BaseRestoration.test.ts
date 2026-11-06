import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TFile, TFolder, type Vault } from "obsidian";
import { BaseRestorationController } from "../../src/bases/BaseRestoration";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import type { BaseSyncLock } from "../../src/bases/BaseSyncRunner";
import { sha256Hex } from "../../src/contentDigest";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entryId = id(3), source = "Old.base", destination = "Restored.base";
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (data: ArrayBuffer | undefined) => data ? new TextDecoder().decode(data) : undefined;

async function fixture(quota?: number) {
	Object.assign(globalThis, { IDBKeyRange });
	const factory = new IDBFactory(), identity = { serverId: "https://bases.fixture", accountId: id(1), shareId: id(2), vaultId: "restore" };
	let store = await BaseSyncStore.open(identity, factory, quota), current = true, held = false;
	const nodes = new Map<string, TFile | TFolder>(), contents = new Map<string, ArrayBuffer>();
	const put = (path: string, value: string, replace = false) => {
		const file = !replace && nodes.get(path) || Object.assign(Object.create(TFile.prototype) as TFile, { path });
		Object.assign(file, { stat: { size: bytes(value).byteLength } }); nodes.set(path, file); contents.set(path, bytes(value)); return file;
	};
	nodes.set("Team", Object.assign(Object.create(TFolder.prototype) as TFolder, { path: "Team" }));
	put("Team/" + source, "local"); let beforeCreate = () => {}, afterCreate = () => {};
	const vault = {
		getAbstractFileByPath: (path: string) => nodes.get(path) ?? null,
		readBinary: jest.fn(async (file: TFile) => contents.get(file.path)!.slice(0)),
		create: jest.fn(async (path: string, value: string) => {
			beforeCreate(); if (nodes.has(path)) throw new Error("occupied"); const file = put(path, value); afterCreate(); return file;
		}),
	};
	const access = { current: () => current, absolute: (path: string) => "Team/" + path, localSource: () => "Team/" + source as string | undefined,
		refresh: jest.fn(async () => {}), destination: jest.fn(async (_path: string) => {}) };
	const lock: BaseSyncLock = async (_entry, action) => { if (held) return undefined; held = true; try { return await action(); } finally { held = false; } };
	const make = () => new BaseRestorationController(store, vault as unknown as Vault, access, lock);
	let controller = make();
	const baseline = { state: { path: source, generation: id(4), content_version: id(5), record: { id: entryId, type: "file" as const, version: 0 as const, hash: await sha256Hex(bytes("base")) } }, bytes: bytes("base") };
	await store.adopt(entryId, 0, baseline); await store.retainRetirement(entryId, 1, source, bytes("saved"));
	return { get store() { return store; }, get controller() { return controller; }, access, nodes, contents, vault, put,
		current: (value: boolean) => { current = value; }, beforeCreate: (run: () => void) => { beforeCreate = run; }, afterCreate: (run: () => void) => { afterCreate = run; },
		restart: async () => { store.close(); store = await BaseSyncStore.open(identity, factory, quota); controller = make(); }, close: () => store.close() };
}

test("guided restoration previews exact retained alternatives and creates a separate local file without altering originals", async () => {
	const s = await fixture(); try {
		const review = (await s.controller.review(entryId))!;
		expect(review.copies.map(copy => copy.key)).toEqual(["file", "removed", "baseline"]);
		expect(await s.controller.restore(entryId, review, "removed", destination)).toBe("Team/" + destination);
		expect(text(s.contents.get("Team/" + destination))).toBe("saved"); expect(text(s.contents.get("Team/" + source))).toBe("local");
		const record = await s.store.get(entryId);
		expect(record.restore?.state).toBe("created"); expect(record.baseline?.bytes).toEqual(bytes("base")); expect(record.retirement?.local).toEqual(bytes("saved"));
		expect(await s.store.list()).toHaveLength(1); // No invented target ID or publication receipt.
	} finally { s.close(); }
});

test("interruption after native create recovers the exact local result after restart without a second write", async () => {
	const s = await fixture(); try {
		s.afterCreate(() => { throw new Error("process stopped"); });
		await expect(s.controller.restore(entryId, (await s.controller.review(entryId))!, "file", destination)).rejects.toThrow("destination now exists");
		expect((await s.store.get(entryId)).restore?.state).toBe("prepared"); await s.restart();
		expect(await s.controller.resume(entryId)).toBe("Team/" + destination); expect(s.vault.create).toHaveBeenCalledTimes(1);
		expect((await s.store.get(entryId)).restore?.state).toBe("created");
	} finally { s.close(); }
});

test("an occupied destination is never overwritten, including creation racing the final check", async () => {
	const s = await fixture(); try {
		const review = (await s.controller.review(entryId))!;
		s.put("Team/" + destination, "other");
		await expect(s.controller.restore(entryId, review, "file", destination)).rejects.toThrow("already exists");
		expect((await s.store.get(entryId)).restore).toBeUndefined();
		s.nodes.delete("Team/" + destination); s.beforeCreate(() => { s.put("Team/" + destination, "racing file"); });
		await expect(s.controller.restore(entryId, review, "file", destination)).rejects.toThrow("destination now exists");
		expect(text(s.contents.get("Team/" + destination))).toBe("racing file");
		await expect(s.controller.resume(entryId)).rejects.toThrow("occupied or changed");
		expect((await s.store.get(entryId)).restore?.bytes).toEqual(bytes("local"));
	} finally { s.close(); }
});

test.each(["edit", "replace"])("a retained file %s after review requires a new review", async kind => {
	const s = await fixture(); try {
		const review = (await s.controller.review(entryId))!; s.put("Team/" + source, kind === "edit" ? "later" : "local", kind === "replace");
		await expect(s.controller.restore(entryId, review, "file", destination)).rejects.toThrow("base_review_changed");
		expect(s.vault.create).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("cached originals remain restorable when another identity occupies the old path", async () => {
	const s = await fixture(); try {
		s.access.localSource = () => undefined; s.put("Team/" + source, "replacement", true);
		const review = (await s.controller.review(entryId))!; expect(review.copies.map(copy => copy.key)).toEqual(["removed", "baseline"]);
		await s.controller.restore(entryId, review, "baseline", destination);
		expect(text(s.contents.get("Team/" + source))).toBe("replacement"); expect(text(s.contents.get("Team/" + destination))).toBe("base");
	} finally { s.close(); }
});

test.each(["../escape.base", "Old.base", "old.BASE", "Wrong.txt", "/absolute.base", "Missing/New.base"])("invalid or unavailable destination %s cannot create a file", async path => {
	const s = await fixture(); try {
		await expect(s.controller.restore(entryId, (await s.controller.review(entryId))!, "file", path)).rejects.toThrow();
		expect(s.vault.create).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("destination permission checks cannot create a local file after account or source-access loss", async () => {
	const s = await fixture(); try {
		const review = (await s.controller.review(entryId))!;
		s.access.destination.mockImplementationOnce(async () => { s.current(false); });
		await expect(s.controller.restore(entryId, review, "file", destination)).rejects.toThrow("base_context_changed");
		expect(s.vault.create).not.toHaveBeenCalled(); expect((await s.store.get(entryId)).restore).toBeUndefined();
	} finally { s.close(); }
});

test("quota failure preserves all copies without disk work, while cancellation archives an intent without increasing quota use", async () => {
	const s = await fixture(17); try {
		const review = (await s.controller.review(entryId))!;
		await expect(s.controller.restore(entryId, review, "file", destination)).rejects.toThrow("quota");
		expect(s.vault.create).not.toHaveBeenCalled(); expect((await s.store.get(entryId)).restore).toBeUndefined();
		const intent = await s.store.prepareRestore(entryId, review.record.revision, destination, bytes("a"), "Small copy");
		const prepared = await s.store.get(entryId); await s.controller.cancel(entryId, prepared.revision);
		expect((await s.store.get(entryId)).restore).toBeUndefined();
		expect((await s.store.recoveries(entryId)).some(item => item.record.restore?.id === intent.id)).toBe(true);
	} finally { s.close(); }
});

test("only one window can restore or cancel a source while native creation is pending", async () => {
	const s = await fixture(); try {
		let finish!: () => void;
		s.access.destination.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const review = (await s.controller.review(entryId))!, running = s.controller.restore(entryId, review, "file", destination);
		while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
		expect(await s.controller.restore(entryId, review, "file", "Duplicate.base")).toBeUndefined();
		expect(await s.controller.cancel(entryId, review.record.revision)).toBeUndefined(); finish(); await running;
		expect(s.vault.create).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("a failed prepared restore can be stopped without deleting a racing file or losing its saved bytes", async () => {
	const s = await fixture(); try {
		s.beforeCreate(() => { throw new Error("disk unavailable"); });
		await expect(s.controller.restore(entryId, (await s.controller.review(entryId))!, "file", destination)).rejects.toThrow("disk unavailable");
		s.put("Team/" + destination, "unrelated"); const record = await s.store.get(entryId);
		await s.controller.cancel(entryId, record.revision);
		expect(text(s.contents.get("Team/" + destination))).toBe("unrelated");
		expect((await s.store.recoveries(entryId)).some(item => text(item.record.restore?.bytes) === "local")).toBe(true);
	} finally { s.close(); }
});

test("version-one caches upgrade without dropping retained work and older workers cannot reopen the new quota schema", async () => {
	Object.assign(globalThis, { IDBKeyRange }); const factory = new IDBFactory();
	const identity = { serverId: "https://bases.fixture", accountId: id(1), shareId: id(2), vaultId: "upgrade" };
	const name = "team-relay-bases:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	await new Promise<void>((resolve, reject) => {
		const open = factory.open(name, 1);
		open.onupgradeneeded = () => {
			open.result.createObjectStore("files", { keyPath: "entryId" }).put({ entryId, revision: 7, retirement: { path: source, local: bytes("saved") } });
			open.result.createObjectStore("recoveries", { keyPath: ["entryId", "id"] }); open.result.createObjectStore("meta").put(5, "bytes");
		};
		open.onsuccess = () => { open.result.close(); resolve(); }; open.onerror = () => reject(open.error);
	});
	const store = await BaseSyncStore.open(identity, factory, 10);
	try {
		expect((await store.get(entryId)).retirement?.local).toEqual(bytes("saved"));
		await store.prepareRestore(entryId, 7, destination, bytes("copy"), "Saved copy");
		await expect(new Promise((resolve, reject) => { const older = factory.open(name, 1); older.onsuccess = () => resolve(older.result); older.onerror = () => reject(older.error); })).rejects.toMatchObject({ name: "VersionError" });
	} finally { store.close(); }
});
