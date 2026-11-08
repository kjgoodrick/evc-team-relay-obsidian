import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { BaseRegistryStore } from "../../src/bases/BaseRegistryStore";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import { BaseViewsController, type BaseViewsAccess } from "../../src/bases/BaseViewsController";
import { BaseContentFailure } from "../../src/bases/BaseContentTransport";
import { copyBaseViewRepair, parseBaseRegistry, parseBaseViewPage, parseBaseViewRepairResult,
	type BaseRegistrySnapshot, type BaseViewRepairIntent } from "../../src/bases/BaseRegistryProtocol";
import type { BaseSyncLock } from "../../src/bases/BaseSyncRunner";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entryId = id(3), hash = "a".repeat(64);
const identity = { serverId: "https://registry.fixture", accountId: id(1), shareId: id(2), vaultId: "views" };
const snapshot = (revision = 1): BaseRegistrySnapshot => ({ protocol_version: 1, entry_id: entryId, definition_id: id(4), generation: id(5), revision,
	content_sha256: hash, views: [{ slot: 0, id: id(6), name: "Planning", type: "table", descriptor_sha256: "b".repeat(64) }],
	unmatched: { views: [{ id: id(7), state: "unmatched", name: "Earlier", type: "cards", descriptor_sha256: "c".repeat(64) }], has_more: false, next_after: id(7) } });
const intent = (operation = 8): BaseViewRepairIntent => ({ definitionId: id(4), generation: id(5), request: {
	operation_id: id(operation), expected_revision: 1, content_sha256: hash, bindings: [{ slot: 0, view_id: id(7) }], archive: [id(6)] } });
const accepted = (): BaseRegistrySnapshot => ({ ...snapshot(2), views: [{ ...snapshot().views[0], id: id(7) }], unmatched: { views: [], has_more: false, next_after: null } });
const credential = async () => ({ accountId: id(1), accessToken: "synthetic-token" });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const lock: BaseSyncLock = async (_entry, action) => action();

test("registry protocol preserves saved-view identity while rejecting wrong files, generations, duplicate slots and invalid pages", () => {
	expect(parseBaseRegistry(snapshot(), entryId, hash, id(5))).toEqual(snapshot());
	expect(() => parseBaseRegistry(snapshot(), id(99))).toThrow();
	expect(() => parseBaseRegistry(snapshot(), entryId, "d".repeat(64))).toThrow();
	expect(() => parseBaseRegistry(snapshot(), entryId, hash, id(99))).toThrow();
	expect(() => parseBaseRegistry({ ...snapshot(), views: [{ ...snapshot().views[0], slot: 1 }] }, entryId)).toThrow();
	expect(() => parseBaseRegistry({ ...snapshot(), unmatched: { ...snapshot().unmatched, views: [{ ...snapshot().unmatched.views[0], id: id(6) }], next_after: id(6) } }, entryId)).toThrow();
	expect(() => parseBaseViewPage({ views: [], has_more: true, next_after: null }, "archived")).toThrow();
	expect(() => parseBaseViewPage(snapshot().unmatched, "unmatched", id(9))).toThrow();
	expect(() => copyBaseViewRepair({ ...intent().request, archive: [id(7)] })).toThrow();
	expect(() => copyBaseViewRepair({ ...intent().request, bindings: [{ slot: 0, view_id: id(7) }, { slot: 1, view_id: id(7) }] })).toThrow();
	expect(parseBaseViewRepairResult(accepted(), entryId, intent())).toEqual(accepted());
	expect(() => parseBaseViewRepairResult(snapshot(2), entryId, intent())).toThrow();
});

test("registry transport sends bounded exact repair input captured before credential refresh", async () => {
	let release!: () => void; const pending = intent(), sent: string[] = [];
	const transport = new BaseRegistryTransport(identity, async () => { if (!release) await new Promise<void>(resolve => { release = resolve; }); return credential(); }, async (_url, init) => {
		sent.push(init.body as string); return response(accepted());
	});
	const sending = transport.reconcile(entryId, pending); pending.request.bindings[0].view_id = id(98); pending.request.archive.length = 0; release();
	expect(await sending).toEqual(accepted()); expect(JSON.parse(sent[0])).toEqual(intent().request);
});

test("saved-view names retain Unicode but reject controls, malformed surrogates and oversized labels", () => {
	const named = (name: string) => ({ ...snapshot(), views: [{ ...snapshot().views[0], name }] });
	expect(parseBaseRegistry(named("📆".repeat(256)), entryId).views[0].name).toHaveLength(512);
	for (const name of ["", "line\nbreak", "bad\ud800", "📆".repeat(257)]) expect(() => parseBaseRegistry(named(name), entryId)).toThrow();
});

test("registry transport rejects old-account responses, oversized payloads and inconsistent repair results", async () => {
	let calls = 0;
	const old = new BaseRegistryTransport(identity, async () => ++calls === 1 ? credential() : undefined, async () => response(snapshot()));
	await expect(old.inspect(entryId, hash)).rejects.toMatchObject({ action: "authenticate" });
	const huge = new BaseRegistryTransport(identity, credential, async () => response({ ...snapshot(), extra: "x".repeat(520_000) }));
	await expect(huge.inspect(entryId, hash)).rejects.toMatchObject({ code: "invalid_base_response" });
	const wrong = new BaseRegistryTransport(identity, credential, async () => response(snapshot(2)));
	await expect(wrong.reconcile(entryId, intent())).rejects.toMatchObject({ code: "invalid_base_registry_response" });
	const stale = new BaseRegistryTransport(identity, credential, async () => response({ detail: { code: "stale_base_revision" } }, 409));
	await expect(stale.reconcile(entryId, intent())).rejects.toMatchObject({ action: "conflict", code: "stale_base_revision" });
});

test("pending association choices and original review survive restart and stay isolated by account", async () => {
	const factory = new IDBFactory(); let store = await BaseRegistryStore.open(identity, factory);
	try {
		await store.cache(entryId, snapshot()); await store.stage(entryId, 1, intent()); store.close(); store = await BaseRegistryStore.open(identity, factory);
		const record = await store.get(entryId); expect(record.pending?.request).toEqual(intent().request); expect(record.pending?.reviewed).toEqual(snapshot());
		const other = await BaseRegistryStore.open({ ...identity, accountId: id(99) }, factory);
		try { expect((await other.get(entryId)).snapshot).toBeUndefined(); } finally { other.close(); }
	} finally { store.close(); }
});

test("competing stores cannot replace a pending request and a quota failure rolls back before remote work", async () => {
	const factory = new IDBFactory(), first = await BaseRegistryStore.open(identity, factory), second = await BaseRegistryStore.open(identity, factory);
	try {
		await first.cache(entryId, snapshot());
		const results = await Promise.allSettled([first.stage(entryId, 1, intent()), second.stage(entryId, 1, intent(9))]);
		expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
		await expect(second.stage(entryId, (await second.get(entryId)).revision, intent(10))).rejects.toThrow("pending");
	} finally { first.close(); second.close(); }
	const small = await BaseRegistryStore.open(identity, new IDBFactory(), 20_000);
	try { await small.cache(entryId, snapshot()); await expect(small.stage(entryId, 1, intent())).rejects.toThrow("full"); expect((await small.get(entryId)).pending).toBeUndefined(); }
	finally { small.close(); }
});

test("late accepted repair receipts never roll a newer cached mapping backwards", async () => {
	const store = await BaseRegistryStore.open(identity, new IDBFactory());
	try {
		await store.cache(entryId, snapshot()); await store.stage(entryId, 1, intent()); await store.cache(entryId, snapshot(3));
		expect(await store.settle(entryId, id(8), accepted(), "accepted")).toBe(true);
		expect((await store.get(entryId)).snapshot).toEqual(snapshot(3)); expect((await store.get(entryId)).pending).toBeUndefined();
		expect((await store.history(entryId))[0]).toMatchObject({ status: "accepted", observedRevision: 2, bindings: [{ slot: 0, view_id: id(7) }] });
		expect(await store.settle(entryId, id(8), accepted(), "accepted")).toBe(false);
		await expect(store.cache(entryId, accepted())).rejects.toThrow("newer");
		await expect(store.cache(entryId, { ...snapshot(4), generation: id(99) })).rejects.toThrow("identity changed");
	} finally { store.close(); }
});

test("a pending request is retained until an accepted receipt or a newer same-lineage revision fences it", async () => {
	const store = await BaseRegistryStore.open(identity, new IDBFactory());
	try {
		await store.cache(entryId, snapshot()); await store.stage(entryId, 1, intent());
		await expect(store.settle(entryId, id(8), snapshot(), "superseded")).rejects.toThrow("fenced");
		expect((await store.get(entryId)).pending).toBeDefined();
		await store.settle(entryId, id(8), snapshot(3), "superseded");
		expect((await store.history(entryId))[0]).toMatchObject({ status: "superseded", observedRevision: 3, intent: { request: intent().request, reviewed: snapshot() } });
	} finally { store.close(); }
});

test("contradictory receipts retain the pending request and diagnostic export preserves its original choices", async () => {
	const store = await BaseRegistryStore.open(identity, new IDBFactory());
	try {
		await store.cache(entryId, snapshot()); await store.stage(entryId, 1, intent()); await store.cache(entryId, snapshot(2));
		await expect(store.settle(entryId, id(8), accepted(), "accepted")).rejects.toThrow("Inconsistent");
		const saved = await store.exportRecord(entryId);
		expect(saved.record.pending?.request).toEqual(intent().request); expect(saved.record.snapshot).toEqual(snapshot(2)); expect(saved.history).toEqual([]);
	} finally { store.close(); }
});

async function controllerFixture() {
	const factory = new IDBFactory(); let store = await BaseRegistryStore.open(identity, factory), current = true, writable = true;
	const source = { path: "Planning.base", sha256: hash, generation: id(5) };
	const access: BaseViewsAccess = { read: async () => source, current: () => current, writable: () => writable };
	const transport = { inspect: jest.fn(async () => snapshot()), reconcile: jest.fn(async (_entry: string, _intent: BaseViewRepairIntent) => accepted()), views: jest.fn(async () => snapshot().unmatched) };
	let controller = new BaseViewsController(store, transport, lock);
	return { get store() { return store; }, get controller() { return controller; }, access, source, transport,
		current: (value: boolean) => { current = value; }, writable: (value: boolean) => { writable = value; },
		restart: async () => { store.close(); store = await BaseRegistryStore.open(identity, factory); controller = new BaseViewsController(store, transport, lock); }, close: () => store.close() };
}

test("inspection caches read-only associations without replaying a saved repair; exact check recovers a lost acceptance", async () => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access);
		s.transport.reconcile.mockRejectedValueOnce(new BaseContentFailure("retry", "network_unavailable"));
		await expect(s.controller.repair(entryId, s.access, snapshot(), intent().request.bindings, intent().request.archive)).rejects.toMatchObject({ action: "retry" });
		const pending = (await s.store.get(entryId)).pending!; await s.restart();
		await s.controller.refresh(entryId, s.access); expect(s.transport.reconcile).toHaveBeenCalledTimes(1);
		await s.controller.checkDelivery(entryId, s.access);
		expect(s.transport.reconcile.mock.calls[1][1].request).toEqual(pending.request); expect((await s.store.get(entryId)).pending).toBeUndefined();
	} finally { s.close(); }
});

test.each(["permissions", "account", "revision"])("%s changing during repair review prevents staging and remote mutation", async kind => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access);
		if (kind === "permissions") s.writable(false);
		if (kind === "account") s.transport.inspect.mockImplementationOnce(async () => { s.current(false); return snapshot(); });
		if (kind === "revision") s.transport.inspect.mockResolvedValueOnce(snapshot(2));
		await expect(s.controller.repair(entryId, s.access, snapshot(), intent().request.bindings, [])).rejects.toThrow();
		expect(s.transport.reconcile).not.toHaveBeenCalled(); expect((await s.store.get(entryId)).pending).toBeUndefined();
	} finally { s.close(); }
});

test("a conflicted repair releases its pending request only after observing the server's newer revision", async () => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access); await s.store.stage(entryId, 1, intent());
		s.transport.reconcile.mockRejectedValue(new BaseContentFailure("conflict", "stale_base_revision"));
		await expect(s.controller.checkDelivery(entryId, s.access)).rejects.toMatchObject({ code: "stale_base_revision" });
		expect((await s.store.get(entryId)).pending).toBeDefined();
		s.transport.inspect.mockResolvedValue(snapshot(3)); await s.controller.checkDelivery(entryId, s.access);
		expect((await s.store.get(entryId)).pending).toBeUndefined(); expect((await s.store.history(entryId))[0].status).toBe("superseded");
	} finally { s.close(); }
});

test("pagination cannot mix historical candidates into an already changed mapping", async () => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access); s.transport.inspect.mockResolvedValueOnce(snapshot(2));
		await expect(s.controller.page(entryId, s.access, snapshot(), "unmatched")).rejects.toMatchObject({ code: "base_review_changed" });
		expect((await s.store.get(entryId)).snapshot?.revision).toBe(2);
	} finally { s.close(); }
});

const restored = (value = snapshot(), generation = id(50)): BaseRegistrySnapshot => ({ ...value, restore_guard: true, restore_generation: generation });

test("restored mappings preserve earlier snapshots and pending intent across a lower revision and restart", async () => {
	const factory = new IDBFactory(); let store = await BaseRegistryStore.open(identity, factory);
	try {
		await store.cache(entryId, snapshot()); await store.stage(entryId, 1, intent()); await store.cache(entryId, snapshot(5));
		const before = await store.get(entryId), next = restored();
		await store.cache(entryId, next, before.revision); store.close(); store = await BaseRegistryStore.open(identity, factory);
		const record = await store.get(entryId);
		expect(record.snapshot).toEqual(next); expect(record.pending).toEqual(before.pending);
		expect((await store.exportRecord(entryId)).recoveries).toEqual([{ entryId, revision: before.revision, snapshot: snapshot(5) }]);
		await expect(store.requireBinding(entryId, record.pending!)).rejects.toMatchObject({ code: "restore_generation_changed" });
		await expect(store.settle(entryId, id(8), accepted(), "accepted")).rejects.toMatchObject({ code: "restore_generation_changed" });
		await expect(store.settle(entryId, id(8), restored(snapshot(6)), "superseded")).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await store.get(entryId)).pending).toEqual(before.pending); expect(await store.history(entryId)).toEqual([]);
	} finally { store.close(); }
});

test("saved-view restore observations require current CAS and cannot downgrade or quietly rebind staged work", async () => {
	const store = await BaseRegistryStore.open(identity, new IDBFactory());
	try {
		await store.cache(entryId, snapshot());
		await expect(store.cache(entryId, restored(), 0)).rejects.toMatchObject({ code: "base_review_changed" });
		await expect(store.cache(entryId, restored(), 1, () => false)).rejects.toMatchObject({ code: "base_review_changed" });
		await store.cache(entryId, restored(), 1);
		const record = await store.get(entryId);
		await expect(store.cache(entryId, snapshot(), record.revision)).rejects.toMatchObject({ code: "restore_guard_unavailable" });
		await expect(store.cache(entryId, { ...restored(), restore_guard: false }, record.revision)).rejects.toThrow();
		await expect(store.stage(entryId, record.revision, intent())).rejects.toMatchObject({ code: "restore_generation_changed" });
		const bound = { ...intent(), restoreGeneration: id(50) };
		await store.stage(entryId, record.revision, bound);
		await store.settle(entryId, id(8), restored(accepted()), "accepted");
		expect((await store.history(entryId))[0].intent.restoreGeneration).toBe(id(50));
	} finally { store.close(); }
});

test("restore-aware registry rejects unsupported or malformed metadata and mismatched accepted receipts", () => {
	for (const bad of [{ restore_guard: true }, { restore_generation: id(50) }, { restore_guard: false, restore_generation: id(50) }, { restore_guard: true, restore_generation: "bad" }]) {
		expect(() => parseBaseRegistry({ ...snapshot(), ...bad }, entryId)).toThrow();
	}
	expect(() => parseBaseViewRepairResult(restored(accepted()), entryId, intent())).toThrow();
	expect(() => parseBaseViewRepairResult(accepted(), entryId, { ...intent(), restoreGeneration: id(50) })).toThrow();
});

test("repair headers are frozen before credential refresh and stay outside exact request and read-only status bodies", async () => {
	let release!: () => void; const pending = { ...intent(), restoreGeneration: id(50) }, sent: { url: string; body: unknown; generation: string | null }[] = [];
	const transport = new BaseRegistryTransport(identity, async () => { if (!release) await new Promise<void>(resolve => { release = resolve; }); return credential(); }, async (url, init) => {
		sent.push({ url, body: JSON.parse(init.body as string), generation: new Headers(init.headers).get("X-Relay-Restore-Generation") });
		return response(url.endsWith("/status") ? { status: "accepted", result: restored(accepted()) } : restored(accepted()));
	});
	const sending = transport.reconcile(entryId, pending); pending.restoreGeneration = id(51); pending.request.archive.length = 0; release(); await sending;
	expect(sent[0]).toMatchObject({ body: intent().request, generation: id(50) });
	await expect(transport.repairStatus(entryId, { ...intent(), restoreGeneration: id(50) })).resolves.toEqual({ status: "accepted", result: restored(accepted()) });
	expect(sent[1]).toMatchObject({ body: intent().request, generation: null });
	const invalid = new BaseRegistryTransport(identity, credential, async () => response({ status: "unknown", entry_id: entryId, operation_id: id(99) }));
	await expect(invalid.repairStatus(entryId, intent())).rejects.toMatchObject({ code: "invalid_base_registry_response" });
});

test("an old saved repair cannot replay after restore but read-only status preserves its original evidence", async () => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access); await s.store.stage(entryId, 1, intent()); await s.restart();
		s.transport.inspect.mockResolvedValue(restored());
		await expect(s.controller.checkDelivery(entryId, s.access)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(s.transport.reconcile).not.toHaveBeenCalled();
		const before = await s.store.exportRecord(entryId), repairStatus = jest.fn(async () => ({ status: "accepted" as const, result: accepted() }));
		const controller = new BaseViewsController(s.store, { ...s.transport, repairStatus }, lock);
		s.writable(false); expect(await controller.checkStatus(entryId, () => true)).toEqual({ status: "accepted", result: accepted() });
		expect(repairStatus).toHaveBeenCalledWith(entryId, before.record.pending);
		expect(await s.store.exportRecord(entryId)).toEqual(before);
		await expect(controller.checkStatus(entryId, () => false)).rejects.toMatchObject({ code: "base_context_changed" });
		expect(repairStatus).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("a restore during review refuses staging even when file and view revision are identical", async () => {
	const s = await controllerFixture(); try {
		await s.controller.refresh(entryId, s.access); s.transport.inspect.mockResolvedValue(restored());
		await expect(s.controller.repair(entryId, s.access, snapshot(), intent().request.bindings, [])).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await s.store.get(entryId)).pending).toBeUndefined(); expect(s.transport.reconcile).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("fresh restored repair retains exact binding through lost response and restart; late old status is not applied", async () => {
	const s = await controllerFixture(); try {
		s.transport.inspect.mockResolvedValue(restored()); await s.controller.refresh(entryId, s.access);
		s.transport.reconcile.mockRejectedValueOnce(new BaseContentFailure("retry", "network_unavailable"));
		await expect(s.controller.repair(entryId, s.access, restored(), intent().request.bindings, intent().request.archive)).rejects.toMatchObject({ action: "retry" });
		const pending = (await s.store.get(entryId)).pending!; expect(pending.restoreGeneration).toBe(id(50)); await s.restart();
		s.transport.reconcile.mockResolvedValue(restored(accepted())); await s.controller.checkDelivery(entryId, s.access);
		expect(s.transport.reconcile.mock.calls[1][1]).toEqual(pending); expect((await s.store.history(entryId))[0].intent).toEqual(pending);
	} finally { s.close(); }
});

test("registry database upgrade closes old workers and retains original-lineage pending repairs", async () => {
	const factory = new IDBFactory(), name = "team-relay-base-views:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	const opening = factory.open(name, 1);
	opening.onupgradeneeded = () => { opening.result.createObjectStore("files", { keyPath: "entryId" }); opening.result.createObjectStore("history", { keyPath: ["entryId", "id"] }); opening.result.createObjectStore("meta"); };
	const old = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
	const record = { entryId, revision: 2, snapshot: snapshot(), pending: { ...intent(), reviewed: snapshot() } };
	const tx = old.transaction(["files", "meta"], "readwrite"); tx.objectStore("files").put(record); tx.objectStore("meta").put(600_000, "bytes");
	await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
	let closed = false; old.onversionchange = () => { closed = true; old.close(); };
	const store = await BaseRegistryStore.open(identity, factory); try {
		expect(closed).toBe(true); expect(await store.get(entryId)).toEqual(record);
		expect((await store.exportRecord(entryId)).recoveries).toEqual([]);
		const obsolete = factory.open(name, 1);
		await expect(new Promise((resolve, reject) => { obsolete.onsuccess = () => resolve(obsolete.result); obsolete.onerror = () => reject(obsolete.error); })).rejects.toMatchObject({ name: "VersionError" });
	} finally { store.close(); }
});
