import "fake-indexeddb/auto";
import * as Y from "yjs";
import { ProviderBacked } from "../src/ProviderBacked";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import type { AuthSession } from "../src/AuthSession";
import { RemoteFolderAddress, RemoteDocumentAddress, ResourceAddress } from "../src/ResourceAddress";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { assertSourceCacheBinding, openSourceInventoryCache, sourceInventoryCache, sourceDocumentCache, type SourceInventoryIdentity } from "../src/storage/source-document-cache";
import { readDocumentRecoverySnapshot } from "../src/storage/document-recovery-snapshot";
import { ManagedIndexTransport } from "../src/client/ManagedIndexTransport";
import { platformFetch } from "../src/platformFetch";
import { ItemKind } from "../src/ItemKinds";
import type { RestoreBinding } from "../src/collaboration/RestoreGeneration";

jest.mock("../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const fetchMock = jest.mocked(platformFetch);
const share = "11111111-1111-4111-8111-111111111111", generation = "a3333333-3333-4333-8333-333333333333";
const address = new RemoteFolderAddress("relay-onprem", share);
const identity = (): SourceInventoryIdentity => ({ hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
	s3rn: ResourceAddress.serialize(address), restoreGeneration: generation });
const snapshot = (restore_generation: string | null = generation) => ({ records: {}, activity: {}, permissions: {}, owner: true, restore_guard: true, restore_generation });
const response = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const note = () => ({ id: crypto.randomUUID(), type: ItemKind.Document, version: 0 });
const documents: Y.Doc[] = [], stores: LocalDocumentStore[] = [], transports: ManagedIndexTransport[] = [];
const doc = () => { const value = new Y.Doc(); documents.push(value); return value; };
const open = async (value: SourceInventoryIdentity) => { const store = await openSourceInventoryCache(value, doc()); stores.push(store); return store; };
const connect = (store: LocalDocumentStore, binding: RestoreBinding) => {
	const transport = new ManagedIndexTransport(store.doc, () => ({ endpoint: "https://fixture.test/v1/managed/index/" + share, token: "fixture" }), () => {}, () => {}, binding);
	transports.push(transport); return transport;
};
afterEach(async () => {
	transports.splice(0).forEach(transport => transport.destroy());
	await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined)));
	documents.splice(0).forEach(value => value.destroy()); jest.restoreAllMocks(); fetchMock.mockReset();
});

test("old, selected and subsequently restored inventories retain independent pending moves and pause records", async () => {
	const selected = identity(), legacy = new LocalDocumentStore(share, doc()); stores.push(legacy);
	legacy.doc.getMap("filemeta_v0").set("Original offline.md", note()); await legacy.close();
	const original = await readDocumentRecoverySnapshot(share);
	const first = await open(selected), transport = connect(first, selected);
	expect(first.doc.getMap("filemeta_v0").size).toBe(0);
	fetchMock.mockResolvedValueOnce(response(snapshot())); await transport.flush();
	const pending = note(); first.doc.getMap("filemeta_v0").set("Selected offline.md", pending);
	const next = { ...selected, restoreGeneration: crypto.randomUUID() };
	fetchMock.mockResolvedValueOnce(response(snapshot(next.restoreGeneration)));
	await expect(transport.flush()).rejects.toThrow("restored"); transport.destroy(); await first.close();
	const retained = await open(selected), reopened = connect(retained, selected);
	await expect(reopened.flush()).rejects.toThrow("restored");
	expect(retained.doc.getMap("filemeta_v0").get("Selected offline.md")).toEqual(pending);
	expect(reopened.restoreReview).toEqual(transport.restoreReview);
	const second = await open(next), current = connect(second, next);
	expect(second.doc.getMap("filemeta_v0").size).toBe(0);
	fetchMock.mockResolvedValueOnce(response(snapshot(next.restoreGeneration))); await current.flush();
	expect(current.owner).toBe(true); expect(current.restoreReview).toBeUndefined();
	expect(await readDocumentRecoverySnapshot(share)).toEqual(original);
});

test("inventory names separate every durable identity boundary and canonicalize equivalent endpoints", async () => {
	const selected = identity(), base = await sourceInventoryCache(selected);
	const variants = [ { ...selected, hostAppId: "other-vault" }, { ...selected, serverId: "other-server" },
		{ ...selected, controlPlaneUrl: "https://another.test" }, { ...selected, restoreGeneration: null },
		{ ...selected, restoreGeneration: crypto.randomUUID() },
		{ ...selected, s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())) } ];
	expect(new Set([base.name, ...await Promise.all(variants.map(async value => (await sourceInventoryCache(value)).name))]).size).toBe(variants.length + 1);
	expect(await sourceInventoryCache({ ...selected, controlPlaneUrl: "https://FIXTURE.test:443/", restoreGeneration: generation.toUpperCase() })).toEqual(base);
	expect(base.name).toMatch(/^relay-inventory-v1-[a-f0-9]{64}$/);
	assertSourceCacheBinding(base.identity, selected.s3rn, selected.serverId, selected.controlPlaneUrl, selected);
	for (const value of variants.filter(value => value.hostAppId === selected.hostAppId)) {
		expect(() => assertSourceCacheBinding(base.identity, value.s3rn, value.serverId, value.controlPlaneUrl, value)).toThrow();
	}
});

test("folder and document caches cannot be confused, including by relabeling the stored format", async () => {
	const selected = identity(), inventory = await sourceInventoryCache(selected);
	const source = { ...selected, s3rn: ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", share, crypto.randomUUID())) };
	await expect(sourceInventoryCache(source)).rejects.toThrow("folder");
	await expect(sourceDocumentCache(selected)).rejects.toThrow("document");
	const wrongFormat = JSON.stringify({ ...JSON.parse(inventory.identity), format: "team-relay-source-cache" });
	expect(() => assertSourceCacheBinding(wrongFormat, selected.s3rn, selected.serverId, selected.controlPlaneUrl, selected)).toThrow();
	expect(() => assertSourceCacheBinding(inventory.identity, source.s3rn, selected.serverId, selected.controlPlaneUrl, selected)).toThrow();
});

test("an occupied unidentified inventory is never claimed or replayed", async () => {
	const selected = identity(), descriptor = await sourceInventoryCache(selected);
	const unclaimed = new LocalDocumentStore(descriptor.name, doc()); stores.push(unclaimed);
	unclaimed.doc.getMap("filemeta_v0").set("Retain.md", note()); await unclaimed.close();
	const before = await readDocumentRecoverySnapshot(descriptor.name), target = doc();
	await expect(openSourceInventoryCache(selected, target)).rejects.toThrow("identity");
	expect(target.getMap("filemeta_v0").size).toBe(0);
	expect(await readDocumentRecoverySnapshot(descriptor.name)).toEqual(before);
});

class InventoryProvider extends ProviderBacked {
	attach(store: LocalDocumentStore) { this.retainRestoreReviewIn(store); }
}

test("an identified original-generation inventory cannot use the legacy automatic observer", async () => {
	const selected = { ...identity(), restoreGeneration: null };
	const credentials = { peekToken: () => undefined, dropFromQueue: jest.fn(), getToken: jest.fn() } as unknown as RelayCredentialCache;
	const provider = new InventoryProvider(share, address, credentials,
		{ getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession, selected.serverId);
	try {
		const store = await openSourceInventoryCache(selected, provider.crdtDoc); stores.push(store); provider.attach(store);
		await expect(provider.requestProviderToken()).rejects.toThrow("explicit generation selection");
		expect(credentials.getToken).not.toHaveBeenCalled(); await store.close();
	} finally { provider.dismantle(); provider.crdtDoc.destroy(); }
});

test("ProviderBacked carries the cache's fixed inventory selection through refreshed grants and reconnects", async () => {
	const selected = identity(), grant = { token: "cached", url: selected.controlPlaneUrl + "/v1/managed/index", docId: share, folder: share, expiryTime: Date.now() + 600_000 };
	const credentials = { peekToken: () => grant, dropFromQueue: jest.fn(),
		assertDocumentSourceCache: (metadata: string, s3rn: string, serverId: string, binding: RestoreBinding) => assertSourceCacheBinding(metadata, s3rn, serverId, selected.controlPlaneUrl, binding),
	} as unknown as RelayCredentialCache;
	const binding = { restoreGeneration: generation };
	const provider = new InventoryProvider(share, address, credentials,
		{ getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession, selected.serverId, binding);
	try {
		const store = await openSourceInventoryCache(selected, provider.crdtDoc); stores.push(store); provider.attach(store);
		binding.restoreGeneration = crypto.randomUUID();
		await provider.assertNoRestoreReview(); provider._liveProvider.connect();
		const transport = provider._liveProvider.managedIndex!;
		fetchMock.mockResolvedValueOnce(response(snapshot())); await transport.flush();
		provider.goOffline(); provider.applyRefreshedToken({ ...grant, token: "renewed" }); provider._liveProvider.connect();
		fetchMock.mockResolvedValueOnce(response(snapshot(binding.restoreGeneration)));
		await expect(transport.flush()).rejects.toThrow("restored");
		expect(transport.restoreReview?.before?.restore_generation).toBe(generation);
		expect(transport.snapshot.restore_generation).toBe(generation); expect(transport.owner).toBe(false);
		expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "GET"]);
		await store.close();
	} finally { provider.dismantle(); provider.crdtDoc.destroy(); }
});
