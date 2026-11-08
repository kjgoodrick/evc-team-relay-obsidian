import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { sha256Hex } from "../../src/contentDigest";
import { BASE_CONTENT_LIMIT, decideBaseSync, encodeBaseBytes, parseBaseSnapshot, type BaseSnapshot, type BasePending, type BaseAccepted } from "../../src/bases/BaseContentProtocol";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
Object.assign(globalThis, { IDBKeyRange });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.example", accountId: id(1), shareId: id(2), vaultId: "vault" };
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (value: ArrayBuffer | null | undefined) => value == null ? value : new TextDecoder().decode(value);
const credentials = async () => ({ accountId: id(1), accessToken: "synthetic-token" });
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
async function snapshot(value: string | null, version = 1): Promise<BaseSnapshot> {
	const data = value === null ? null : bytes(value);
	return { bytes: data, state: { path: "Planning.base", generation: data === null ? null : id(9), content_version: data === null ? null : id(100 + version),
		record: { id: id(3), version: 0, type: "file", ...(data === null ? {} : { hash: await sha256Hex(data), mimetype: "application/yaml", synctime: version }) } } };
}
const wire = (value: BaseSnapshot) => ({ protocol_version: 1, state: value.state, content_base64: value.bytes === null ? null : encodeBaseBytes(value.bytes) });
async function accepted(pending: BasePending, version = 2): Promise<BaseAccepted> {
	return { operation_id: pending.operationId, state: { ...(await snapshot(text(pending.bytes)!, version)).state, path: pending.expected.path } };
}

test.each([
	[undefined, "same", "same", "adopt"], [undefined, "local", "remote", "unknown-baseline"],
	[undefined, null, "remote", "download"], ["base", "base", "remote", "download"],
	["base", "local", "base", "upload"], ["base", "local", "remote", "diverged"],
	["base", "changed", "changed", "adopt"], ["base", null, "remote", "local-deletion"],
	[undefined, null, null, "wait"], [undefined, "local", null, "unpublished"],
] as const)("three-way content comparison %s / %s / %s gives %s", async (base, local, remote, decision) => {
	expect(await decideBaseSync(base === undefined ? undefined : await snapshot(base), local === null ? null : bytes(local), await snapshot(remote, 2))).toBe(decision);
});

test("only a known new claim can initialize absent bytes; restore generations conflict", async () => {
	expect(await decideBaseSync(undefined, bytes("new"), await snapshot(null), true)).toBe("upload");
	const restored = await snapshot("remote", 2); restored.state.generation = id(10);
	expect(await decideBaseSync(await snapshot("base"), bytes("local"), restored)).toBe("generation-changed");
});

test("wire parsing verifies digest, size, target identity and canonical path, preserving empty bytes", async () => {
	const value = await snapshot("");
	expect(await parseBaseSnapshot(wire(value), id(3))).toEqual(value);
	await expect(parseBaseSnapshot(wire(value), id(4))).rejects.toThrow();
	await expect(parseBaseSnapshot({ ...wire(value), content_base64: encodeBaseBytes(bytes("wrong")) }, id(3))).rejects.toThrow();
	await expect(parseBaseSnapshot({ ...wire(value), state: { ...value.state, path: "../Private.base" } }, id(3))).rejects.toThrow();
	expect(() => encodeBaseBytes(new ArrayBuffer(BASE_CONTENT_LIMIT + 1))).toThrow();
	await expect(parseBaseSnapshot({ ...wire(value), content_base64: "?" }, id(3))).rejects.toThrow();
});

test("baselines and exact pending bytes survive restart and remain isolated by account, server and vault", async () => {
	const factory = new IDBFactory(), store = await BaseSyncStore.open(identity, factory), base = await snapshot("base");
	await store.adopt(id(3), 0, base);
	const local = bytes("local"), pending = await store.stage(id(3), 1, base.state, local);
	new Uint8Array(local).fill(0); new Uint8Array(pending.bytes).fill(0); store.close();
	const reopened = await BaseSyncStore.open(identity, factory);
	try {
		const persisted = await reopened.get(id(3));
		expect(text(persisted.baseline?.bytes)).toBe("base"); expect(text(persisted.pending?.bytes)).toBe("local");
		expect(persisted.pending?.operationId).toBe(pending.operationId);
		for (const patch of [{ accountId: id(8) }, { serverId: "https://other.example" }, { vaultId: "other" }, { shareId: id(7) }]) {
			const other = await BaseSyncStore.open({ ...identity, ...patch }, factory);
			expect(await other.get(id(3))).toEqual({ entryId: id(3), revision: 0 }); other.close();
		}
	} finally { reopened.close(); }
});

test("competing windows stage one request; stale baseline replacement cannot erase it", async () => {
	const factory = new IDBFactory(), first = await BaseSyncStore.open(identity, factory), second = await BaseSyncStore.open(identity, factory);
	try {
		const base = await snapshot("base"); await first.adopt(id(3), 0, base);
		const results = await Promise.allSettled([first.stage(id(3), 1, base.state, bytes("one")), second.stage(id(3), 1, base.state, bytes("two"))]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		await expect(second.adopt(id(3), 1, await snapshot("remote", 3))).rejects.toThrow("changed");
		await expect(first.stage(id(3), 2, base.state, bytes("replacement"))).rejects.toThrow("pending");
		expect((await second.get(id(3))).pending).toBeDefined();
	} finally { first.close(); second.close(); }
});

test("acceptance advances only its pending request; a late old receipt cannot erase a later edit", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory());
	try {
		const base = await snapshot("base"); await store.adopt(id(3), 0, base);
		const pending = await store.stage(id(3), 1, base.state, bytes("first")), result = await accepted(pending);
		await expect(store.settle(id(3), pending.operationId, { status: "accepted", result: { ...result, state: base.state } })).rejects.toThrow();
		expect((await store.get(id(3))).pending).toBeDefined();
		expect(await store.settle(id(3), pending.operationId, { status: "accepted", result })).toBe(true);
		const later = await store.stage(id(3), 3, result.state, bytes("later"));
		expect(await store.settle(id(3), pending.operationId, { status: "accepted", result })).toBe(false);
		expect((await store.get(id(3))).pending?.operationId).toBe(later.operationId);
	} finally { store.close(); }
});

test("confirmed withdrawal archives original bytes and context before releasing the pending request", async () => {
	const factory = new IDBFactory(), store = await BaseSyncStore.open(identity, factory), base = await snapshot("base");
	await store.adopt(id(3), 0, base);
	const pending = await store.stage(id(3), 1, base.state, bytes("unsent"));
	await expect(store.settle(id(3), pending.operationId, { status: "withdrawn", operation_id: id(5), entry_id: id(3) })).rejects.toThrow();
	await store.settle(id(3), pending.operationId, { status: "withdrawn", operation_id: pending.operationId, entry_id: id(3) }); store.close();
	const reopened = await BaseSyncStore.open(identity, factory);
	try {
		expect((await reopened.get(id(3))).pending).toBeUndefined();
		const recovery = (await reopened.recoveries(id(3)))[0];
		expect(text(recovery.record.pending?.bytes)).toBe("unsent"); expect(text(recovery.record.baseline?.bytes)).toBe("base");
	} finally { reopened.close(); }
});

test("quota failure rolls back both archival and pending removal", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory(), 8), base = await snapshot("abc");
	try {
		await store.adopt(id(3), 0, base); const pending = await store.stage(id(3), 1, base.state, bytes("def"));
		await expect(store.settle(id(3), pending.operationId, { status: "withdrawn", operation_id: pending.operationId, entry_id: id(3) })).rejects.toThrow("quota");
		expect((await store.get(id(3))).pending?.operationId).toBe(pending.operationId);
		expect(await store.recoveries(id(3))).toEqual([]);
	} finally { store.close(); }
});

test("download intent survives a crash before disk replacement; stale completion is ignored", async () => {
	const factory = new IDBFactory(), store = await BaseSyncStore.open(identity, factory);
	await store.adopt(id(3), 0, await snapshot("before"));
	const download = await store.prepareDownload(id(3), 1, bytes("before"), await snapshot("after", 2)); store.close();
	const reopened = await BaseSyncStore.open(identity, factory);
	try {
		const saved = await reopened.get(id(3)); expect(text(saved.baseline?.bytes)).toBe("before"); expect(text(saved.download?.remote.bytes)).toBe("after");
		expect(await reopened.completeDownload(id(3), id(90))).toBe(false);
		expect(await reopened.completeDownload(id(3), download.id)).toBe(true);
		expect(text((await reopened.get(id(3))).baseline?.bytes)).toBe("after");
	} finally { reopened.close(); }
});

test("conflict review retains original local, remote and baseline copies across later observations", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory());
	try {
		await store.adopt(id(3), 0, await snapshot("base"));
		await store.retainConflict(id(3), 1, { reason: "diverged", local: bytes("local"), remote: await snapshot("remote", 2) });
		await expect(store.retainConflict(id(3), 2, { reason: "diverged", local: bytes("new local"), remote: await snapshot("new remote", 3) })).rejects.toThrow("retained");
		await store.archiveConflict(id(3), 2);
		const archived = (await store.recoveries(id(3)))[0];
		expect(text(archived.record.conflict?.local)).toBe("local"); expect(text(archived.record.conflict?.remote.bytes)).toBe("remote");
		expect(text(archived.record.baseline?.bytes)).toBe("base"); expect((await store.get(id(3))).conflict).toBeUndefined();
	} finally { store.close(); }
});

test("a rejected local replacement preserves both the prepared download and the newer local edit", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory());
	try {
		await store.adopt(id(3), 0, await snapshot("base"));
		const download = await store.prepareDownload(id(3), 1, bytes("base"), await snapshot("remote", 2));
		expect(await store.rejectDownload(id(3), download.id, bytes("edited during download"))).toBe(true);
		const record = await store.get(id(3));
		expect(text(record.conflict?.local)).toBe("edited during download"); expect(text(record.conflict?.remote.bytes)).toBe("remote");
		expect(text((await store.recoveries(id(3)))[0].record.download?.before)).toBe("base");
		expect(await store.completeDownload(id(3), download.id)).toBe(false);
	} finally { store.close(); }
});

test("transport captures exact bytes before credential refresh and verifies accepted content", async () => {
	const base = await snapshot("base"), pending = { operationId: id(4), expected: base.state, bytes: bytes("new") }, result = await accepted(pending);
	let ready!: (value: { accountId: string; accessToken: string }) => void;
	const token = new Promise<{ accountId: string; accessToken: string }>(resolve => { ready = resolve; });
	const fetcher = jest.fn().mockResolvedValue(reply(200, { protocol_version: 1, ...result }));
	const transport = new BaseContentTransport(identity, () => token, fetcher);
	const sending = transport.publish(id(3), pending); new Uint8Array(pending.bytes).fill(0); pending.expected.path = "Changed.base";
	ready(await credentials()); expect(await sending).toEqual(result);
	expect(fetcher.mock.calls[0][0]).toBe(`https://relay.example/v1/managed/shares/${id(2)}/entries/${id(3)}/base-content`);
	expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "PUT", sensitive: true });
	expect(JSON.parse(fetcher.mock.calls[0][1].body).content_base64).toBe(encodeBaseBytes(bytes("new")));
});

test("transport checks account before submission and after delivery", async () => {
	const value = await snapshot("remote"), fetcher = jest.fn().mockResolvedValue(reply(200, wire(value)));
	await expect(new BaseContentTransport(identity, async () => ({ accountId: id(8), accessToken: "wrong" }), fetcher).read(id(3))).rejects.toMatchObject({ action: "authenticate" });
	expect(fetcher).not.toHaveBeenCalled();
	const changing = jest.fn().mockResolvedValueOnce(await credentials()).mockResolvedValue(undefined);
	await expect(new BaseContentTransport(identity, changing, fetcher).read(id(3))).rejects.toMatchObject({ action: "authenticate" });
});

test("account switching while response bytes arrive prevents delivery", async () => {
	let active = true;
	const response = { ok: true, status: 200, body: null, headers: new Headers(), text: async () => {
		active = false; return JSON.stringify(wire(await snapshot("private")));
	} } as Response;
	const transport = new BaseContentTransport(identity, async () => active ? credentials() : undefined, async () => response);
	await expect(transport.read(id(3))).rejects.toMatchObject({ action: "authenticate" });
});

test.each([[409, "base_content_conflict", "conflict"], [409, "base_content_changed", "retry"],
	[409, "base_content_lineage_changed", "reject"], [410, "base_content_withdrawn", "reject"],
	[403, "base_editor_required", "reject"], [404, "base_content_disabled", "pause"], [503, "server_unavailable", "retry"]])(
	"transport classifies %s %s without exposing configuration", async (status, code, action) => {
		const fetcher = jest.fn().mockResolvedValue(reply(status as number, { error: { message: { code }, secret: "private configuration" } }));
		const failure = await new BaseContentTransport(identity, credentials, fetcher).read(id(3)).catch(error => error);
		expect(failure).toMatchObject({ code, action }); expect(String(failure)).not.toContain("private"); expect(fetcher).toHaveBeenCalledTimes(1);
	});

test("timeout leaves exact pending work durable; verified withdrawal is required to clear it", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory()), base = await snapshot("base");
	try {
		const pending = await store.stage(id(3), 0, base.state, bytes("pending"));
		const transport = new BaseContentTransport(identity, credentials, async () => new Promise<Response>(() => {}), 5);
		await expect(transport.publish(id(3), pending)).rejects.toMatchObject({ code: "request_timeout" });
		expect((await store.get(id(3))).pending).toEqual(pending);
		const transport2 = new BaseContentTransport(identity, credentials, async () => reply(200, { status: "withdrawn", operation_id: pending.operationId, entry_id: id(3) }));
		const result = await transport2.withdraw(id(3), pending);
		await store.settle(id(3), pending.operationId, result);
		expect((await store.recoveries(id(3)))[0].record.pending).toEqual(pending);
	} finally { store.close(); }
});

test("transport rejects corrupted or oversized successful responses and mismatched withdrawal receipts", async () => {
	const base = await snapshot("base"), pending = { operationId: id(4), expected: base.state, bytes: bytes("pending") };
	await expect(new BaseContentTransport(identity, credentials, async () => reply(200, { ...wire(base), content_base64: encodeBaseBytes(bytes("corrupt")) })).read(id(3))).rejects.toMatchObject({ code: "invalid_base_response" });
	await expect(new BaseContentTransport(identity, credentials, async () => new Response("x".repeat(400_000))).read(id(3))).rejects.toMatchObject({ code: "invalid_base_response" });
	await expect(new BaseContentTransport(identity, credentials, async () => reply(200, { status: "withdrawn", operation_id: id(90), entry_id: id(3) })).withdraw(id(3), pending)).rejects.toMatchObject({ code: "invalid_base_response" });
});

test("read-only status freezes the exact request and validates accepted, withdrawn and unknown receipts", async () => {
	const base = await snapshot("base"), pending = { operationId: id(4), expected: base.state, bytes: bytes("new") }, result = await accepted(pending);
	for (const status of [{ status: "accepted", result: { protocol_version: 1, ...result } },
		{ status: "withdrawn", operation_id: pending.operationId, entry_id: id(3) }, { status: "unknown", operation_id: pending.operationId, entry_id: id(3) }]) {
		const fetcher = jest.fn().mockResolvedValue(reply(200, status));
		const transport = new BaseContentTransport(identity, credentials, fetcher);
		expect((await transport.status(id(3), pending)).status).toBe(status.status);
		expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][0]).toMatch(/base-content\/status$/);
		expect(new Headers(fetcher.mock.calls[0][1].headers).has("X-Relay-Restore-Generation")).toBe(false);
	}
	for (const invalid of [{ status: "unknown", operation_id: id(8), entry_id: id(3) }, { status: "unknown", operation_id: pending.operationId, entry_id: id(8) },
		{ status: "unknown", operation_id: pending.operationId, entry_id: id(3), result }, { status: "accepted", result: { protocol_version: 1, ...result, operation_id: id(8) } }]) {
		await expect(new BaseContentTransport(identity, credentials, async () => reply(200, invalid)).status(id(3), pending)).rejects.toMatchObject({ code: "invalid_base_response" });
	}
	let resume!: (value: Awaited<ReturnType<typeof credentials>>) => void;
	const fetcher = jest.fn().mockResolvedValue(reply(200, { status: "accepted", result: { protocol_version: 1, ...result } }));
	const token = new Promise<Awaited<ReturnType<typeof credentials>>>(resolve => { resume = resolve; });
	const checking = new BaseContentTransport(identity, () => token, fetcher).status(id(3), pending);
	new Uint8Array(pending.bytes).fill(0); pending.expected.path = "Other.base"; resume(await credentials()); await checking;
	expect(JSON.parse(fetcher.mock.calls[0][1].body).content_base64).toBe(encodeBaseBytes(bytes("new")));
});

test("restore snapshots reject unsupported metadata and require review for an unproven initialization", async () => {
	const remote = await snapshot(null);
	for (const metadata of [{ restore_guard: true }, { restore_generation: null }, { restore_guard: false, restore_generation: id(60) }, { restore_guard: true, restore_generation: "bad" }]) {
		await expect(parseBaseSnapshot({ ...wire(remote), ...metadata }, id(3))).rejects.toThrow();
	}
	const current = await parseBaseSnapshot({ ...wire(remote), restore_guard: true, restore_generation: id(60) }, id(3));
	expect(await decideBaseSync(undefined, bytes("unproven local file"), current, true)).toBe("restore-changed");
});

test("Bases restore observation rejects stale readers, downgrades and late staged intents", async () => {
	const store = await BaseSyncStore.open(identity, new IDBFactory());
	try {
		const expected = await snapshot("base"), captured = await store.get(id(3));
		await store.observeRestoreContext(id(3), captured.revision, { supported: true, generation: id(60) }, () => true);
		const before = await store.get(id(3));
		await expect(store.observeRestoreContext(id(3), captured.revision, { supported: true, generation: id(61) }, () => true)).rejects.toThrow("changed");
		await expect(store.observeRestoreContext(id(3), before.revision, undefined, () => true)).rejects.toMatchObject({ code: "restore_guard_unavailable" });
		await expect(store.stage(id(3), before.revision, expected.state, bytes("old intent"))).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(await store.get(id(3))).toEqual(before);
	} finally { store.close(); }
});

test("publish and withdrawal freeze restore bindings before credential refresh, outside their canonical body", async () => {
	const before = await snapshot("base");
	for (const action of ["publish", "withdraw"] as const) {
		const pending = { operationId: id(4), expected: before.state, bytes: bytes("new"), restoreGeneration: id(60) };
		const result = { protocol_version: 1, ...await accepted(pending) };
		const fetcher = jest.fn().mockResolvedValue(reply(200, action === "publish" ? result : { status: "accepted", result }));
		let resume!: (value: Awaited<ReturnType<typeof credentials>>) => void;
		const token = new Promise<Awaited<ReturnType<typeof credentials>>>(resolve => { resume = resolve; });
		const sending = new BaseContentTransport(identity, () => token, fetcher)[action](id(3), pending);
		pending.restoreGeneration = id(61); resume(await credentials()); await sending;
		expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Relay-Restore-Generation")).toBe(id(60));
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty("restoreGeneration");
	}
});

test("Bases database upgrade closes old workers and preserves original pending and recovery bytes", async () => {
	const factory = new IDBFactory(), name = "team-relay-bases:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	const prior = await new Promise<IDBDatabase>((resolve, reject) => {
		const opening = factory.open(name, 2);
		opening.onupgradeneeded = () => { opening.result.createObjectStore("files", { keyPath: "entryId" }); opening.result.createObjectStore("recoveries", { keyPath: ["entryId", "id"] }); opening.result.createObjectStore("meta"); };
		opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
	});
	const record = { entryId: id(3), revision: 1, pending: { operationId: id(4), expected: (await snapshot("base")).state, bytes: bytes("old pending") } };
	await new Promise<void>((resolve, reject) => {
		const tx = prior.transaction(["files", "recoveries", "meta"], "readwrite"); tx.objectStore("files").put(record);
		tx.objectStore("recoveries").put({ entryId: id(3), id: id(5), createdAt: 1, record }); tx.objectStore("meta").put(record.pending.bytes.byteLength * 2, "bytes");
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
	});
	let closed = false; prior.onversionchange = () => { closed = true; prior.close(); };
	const upgraded = await BaseSyncStore.open(identity, factory);
	try {
		expect(closed).toBe(true); expect(await upgraded.get(id(3))).toEqual(record);
		expect((await upgraded.recoveries(id(3)))[0].record).toEqual(record);
		const obsolete = await new Promise<string>((resolve, reject) => {
			const opening = factory.open(name, 2); opening.onerror = event => { event.preventDefault(); resolve(opening.error!.name); }; opening.onsuccess = () => { opening.result.close(); reject(new Error("Old worker opened new storage")); };
		});
		expect(obsolete).toBe("VersionError");
		await upgraded.observeRestoreContext(id(3), 1, { supported: true, generation: id(60) }, () => true);
		expect((await upgraded.get(id(3))).pending).toEqual(record.pending);
	} finally { upgraded.close(); }
});
