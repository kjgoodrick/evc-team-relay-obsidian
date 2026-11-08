import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { Vault } from "obsidian";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseSyncStore } from "../../src/bases/BaseSyncStore";
import { BaseRetirementController } from "../../src/bases/BaseRetirement";
import { nativeBaseLock } from "../../src/bases/NativeBaseFile";
import { platformFetch } from "../../src/platformFetch";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";

// Only the host HTTP boundary and local missing-file port are replaced. The
// inventory/content HTTP services, durable cache and private Yjs outbox are real.
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
Object.assign(globalThis, { IDBKeyRange });
const request = platformFetch as jest.MockedFunction<typeof platformFetch>;
const fixturePath = process.env.EVC_BASE_LIFECYCLE_FIXTURE;
const integration = fixturePath ? test : test.skip;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const peers: { doc: Y.Doc; transport: ManagedIndexTransport }[] = [];
const stores: BaseSyncStore[] = [];
afterEach(() => {
	for (const { doc, transport } of peers.splice(0)) { transport.destroy(); doc.destroy(); }
	for (const store of stores.splice(0)) store.close();
});

async function setup() {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback fixture is allowed");
	request.mockReset(); request.mockImplementation((url, init) => fetch(url, init));
	const granted = await fetch(fixture.base + "/v1/tokens/relay", { method: "POST",
		headers: { Authorization: "Bearer " + fixture.ownerToken, "Content-Type": "application/json" },
		body: JSON.stringify({ share_id: fixture.share, doc_id: fixture.share, mode: "write" }) });
	expect(granted.status).toBe(200);
	const grant = await granted.json() as { token: string };
	const identity = { serverId: fixture.base, accountId: fixture.ownerId, shareId: fixture.share, vaultId: crypto.randomUUID() };
	const factory = new IDBFactory();
	const openStore = async () => { const store = await BaseSyncStore.open(identity, factory); stores.push(store); return store; };
	const content = new BaseContentTransport(identity, async () => ({ accountId: fixture.ownerId, accessToken: fixture.ownerToken }), (url, init) => fetch(url, init));
	function peer(saved?: Uint8Array) {
		const doc = new Y.Doc(); if (saved) Y.applyUpdate(doc, saved);
		const failed = jest.fn();
		const transport = new ManagedIndexTransport(doc, () => ({ endpoint: fixture.base + "/v1/managed/index/" + fixture.share, token: grant.token }), () => {}, failed);
		peers.push({ doc, transport });
		return { doc, transport, failed, records: doc.getMap<ItemRecord>("filemeta_v0") };
	}
	async function seed(path: string) {
		const client = peer(); await client.transport.flush();
		const id = crypto.randomUUID();
		expect(await client.transport.claim(path, { id, type: ItemKind.File, version: 0 } as ItemRecord)).toBe(true);
		const empty = await content.read(id), baseline = bytes("views: []\n# " + path + "\n");
		await content.publish(id, { operationId: crypto.randomUUID(), expected: empty.state, bytes: baseline });
		await client.transport.flush();
		return { client, id, baseline, snapshot: await content.read(id) };
	}
	return { fixture, identity, content, peer, seed, openStore };
}

integration("offline Bases deletion survives a lost accepted response and two restarts without losing retained bytes", async () => {
	const { identity, content, peer, seed, openStore } = await setup();
	const path = "Offline-deletion.base", { client, id, snapshot } = await seed(path);
	let store = await openStore(); await store.adopt(id, 0, snapshot);
	const pending = await store.stage(id, (await store.get(id)).revision, snapshot.state, bytes("views: []\n# unsent before deletion\n"));
	client.transport.stop(); client.records.delete(path);
	const saved = Y.encodeStateAsUpdate(client.doc); store.close(); store = await openStore();
	const resumed = peer(saved);
	request.mockImplementationOnce(async (url, init) => {
		expect(init?.method).toBe("POST"); const response = await fetch(url, init);
		expect(response.status).toBe(200); await response.arrayBuffer();
		throw new Error("Synthetic loss after the server accepted deletion");
	});
	await expect(resumed.transport.flush()).rejects.toThrow("Synthetic loss");
	expect(resumed.failed).toHaveBeenCalledTimes(1);
	expect(resumed.records.has(path)).toBe(false);
	expect(resumed.transport.snapshot.records[path]?.id).toBe(id);
	resumed.transport.stop();
	const retried = peer(Y.encodeStateAsUpdate(resumed.doc)); await retried.transport.flush();
	expect(retried.transport.conflicts).toEqual([]);
	expect(retried.records.has(path)).toBe(false);
	expect(retried.transport.snapshot.deleted?.[path]).toContain(id);
	expect(retried.transport.snapshot.base_content?.retired?.[id]).toBe(path);
	await expect(content.publish(id, pending)).rejects.toMatchObject({ action: "reject", code: "target_unavailable" });
	const retirement = new BaseRetirementController(store, { getAbstractFileByPath: () => null } as unknown as Vault, {
		current: (entry, target) => entry === id && target === path && retried.transport.snapshot.base_content?.retired?.[entry] === target,
		absolute: target => "Team/" + target, refresh: async () => { await retried.transport.flush(); },
	}, nativeBaseLock(identity, navigator.locks));
	expect(await retirement.observe(id, path)).toBe(true);
	store.close(); store = await openStore();
	expect((await store.get(id))).toMatchObject({ baseline: snapshot, pending, retirement: { path, local: null } });
	expect((await store.recoveries(id))[0].record.pending).toEqual(pending);
	await retried.transport.flush(); expect(retried.records.has(path)).toBe(false);
}, 30_000);

integration("an offline deletion conflicts with a newer Bases content version and survives restart without deleting it", async () => {
	const { content, peer, seed, openStore } = await setup();
	const path = "Concurrent-edit.base", { client, id, snapshot } = await seed(path);
	let store = await openStore(); await store.adopt(id, 0, snapshot);
	client.transport.stop(); client.records.delete(path);
	const newer = bytes("views: []\n# remote work while this device is offline\n");
	await content.publish(id, { operationId: crypto.randomUUID(), expected: snapshot.state, bytes: newer });
	const resumed = peer(Y.encodeStateAsUpdate(client.doc)); await resumed.transport.flush();
	expect(resumed.transport.conflicts).toHaveLength(1);
	expect(resumed.transport.isBlocked(path, id)).toBe(true);
	expect(resumed.records.has(path)).toBe(false);
	expect((await content.read(id)).bytes).toEqual(newer);
	expect(resumed.transport.snapshot.base_content?.retired?.[id]).toBeUndefined();
	resumed.transport.stop(); store.close(); store = await openStore();
	const restarted = peer(Y.encodeStateAsUpdate(resumed.doc)); await restarted.transport.flush();
	expect(restarted.transport.conflicts).toEqual(resumed.transport.conflicts);
	expect((await store.get(id)).baseline).toEqual(snapshot);
	expect((await content.read(id)).bytes).toEqual(newer);
}, 30_000);

integration("a replacement at a retired Bases path gets a fresh identity and cannot inherit or publish the old pending copy", async () => {
	const { content, seed, openStore } = await setup();
	const path = "Replaced.base", { client, id, snapshot } = await seed(path);
	const store = await openStore(); await store.adopt(id, 0, snapshot);
	const pending = await store.stage(id, (await store.get(id)).revision, snapshot.state, bytes("views: []\n# old unsent copy\n"));
	client.records.delete(path); await client.transport.flush();
	const replacement = crypto.randomUUID();
	expect(await client.transport.claim(path, { id: replacement, type: ItemKind.File, version: 0 } as ItemRecord)).toBe(true);
	const empty = await content.read(replacement); expect(empty.bytes).toBeNull();
	const next = bytes("views: []\n# replacement content\n");
	await content.publish(replacement, { operationId: crypto.randomUUID(), expected: empty.state, bytes: next });
	await expect(content.publish(id, pending)).rejects.toMatchObject({ action: "reject", code: "target_unavailable" });
	await client.transport.flush();
	expect(client.records.get(path)?.id).toBe(replacement);
	expect((await content.read(replacement)).bytes).toEqual(next);
	expect((await store.get(id)).pending).toEqual(pending);
	expect(await store.get(replacement)).toEqual({ entryId: replacement, revision: 0 });
	expect(client.transport.snapshot.deleted?.[path]).toContain(id);
}, 30_000);

integration("a new remote child prevents an offline folder deletion from retiring its synchronized Base", async () => {
	const { content, peer, seed } = await setup();
	const folderPath = "Offline-folder", path = folderPath + "/Planning.base";
	const { client, id, snapshot } = await seed(path);
	expect(await client.transport.claim(folderPath, { id: crypto.randomUUID(), type: ItemKind.Folder, version: 0 })).toBe(true);
	client.transport.stop();
	client.doc.transact(() => { client.records.delete(folderPath); client.records.delete(path); });
	const remote = peer(); await remote.transport.flush();
	const newPath = folderPath + "/New-note.md", newId = crypto.randomUUID();
	expect(await remote.transport.claim(newPath, { id: newId, type: ItemKind.Document, version: 0 })).toBe(true);
	remote.transport.stop();
	const resumed = peer(Y.encodeStateAsUpdate(client.doc)); await resumed.transport.flush();
	expect(resumed.transport.conflicts).toHaveLength(1);
	expect(resumed.transport.isBlocked(newPath, newId)).toBe(true);
	expect(resumed.transport.snapshot.records[path]?.id).toBe(id);
	expect(resumed.transport.snapshot.records[newPath]?.id).toBe(newId);
	expect(resumed.transport.snapshot.base_content?.retired?.[id]).toBeUndefined();
	expect(await content.read(id)).toEqual(snapshot);
	const reviewed = Object.fromEntries(Object.entries(resumed.transport.snapshot.records).filter(([key]) => key === folderPath || key.startsWith(folderPath + "/")));
	const prepare = jest.fn();
	await expect(resumed.transport.resolve(resumed.transport.conflicts[0].id, "local", reviewed, prepare)).rejects.toThrow("New server files");
	expect(prepare).not.toHaveBeenCalled();
	expect(await content.read(id)).toEqual(snapshot);
}, 30_000);

integration("an offline deletion cannot retire a Base another device moved, including its current bytes", async () => {
	const { content, peer, seed, openStore } = await setup();
	const path = "Before-move.base", moved = "After-move.base", { client, id, snapshot } = await seed(path);
	const store = await openStore(); await store.adopt(id, 0, snapshot);
	client.transport.stop(); client.records.delete(path);
	const remote = peer(); await remote.transport.flush();
	remote.doc.transact(() => { remote.records.set(moved, remote.records.get(path)!); remote.records.delete(path); });
	await remote.transport.flush(); remote.transport.stop();
	const resumed = peer(Y.encodeStateAsUpdate(client.doc)); await resumed.transport.flush();
	expect(resumed.transport.conflicts).toHaveLength(1);
	expect(resumed.transport.isBlocked(moved, id)).toBe(true);
	expect(resumed.transport.snapshot.records[moved]?.id).toBe(id);
	expect(resumed.transport.snapshot.base_content?.retired?.[id]).toBeUndefined();
	const current = await content.read(id);
	expect(current.bytes).toEqual(snapshot.bytes); expect(current.state.path).toBe(moved);
	expect(current.state.content_version).toBe(snapshot.state.content_version);
	expect((await store.get(id)).baseline).toEqual(snapshot);
}, 30_000);
