import "fake-indexeddb/auto";
import * as Y from "yjs";
import { RemoteDocumentAddress, RemoteCanvasAddress, ResourceAddress } from "../src/ResourceAddress";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { SOURCE_CACHE_IDENTITY } from "../src/storage/document-cache-binding";
import { openSourceDocumentCache, sourceDocumentCache, type SourceDocumentIdentity } from "../src/storage/source-document-cache";
import { readDocumentRecoverySnapshot } from "../src/storage/document-recovery-snapshot";
import { UnsavedFileStore } from "../src/UnsavedFile";

const share = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222";
const generation = "a3333333-3333-4333-8333-333333333333";
const identity = (): SourceDocumentIdentity => ({ hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
	s3rn: ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", share, note)), restoreGeneration: generation });
const stores: LocalDocumentStore[] = [];
const docs: Y.Doc[] = [];
const document = () => { const doc = new Y.Doc({ gc: false }); docs.push(doc); return doc; };
async function open(value: SourceDocumentIdentity) { const store = await openSourceDocumentCache(value, document()); stores.push(store); return store; }
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close().catch(() => undefined))); docs.splice(0).forEach(doc => doc.destroy()); jest.restoreAllMocks(); });

test("a restored source opens empty beside the intact original history and buffer", async () => {
	const value = identity(), legacyName = `${value.hostAppId}-relay-doc-${note}`;
	const legacy = new LocalDocumentStore(legacyName, document()); stores.push(legacy);
	legacy.doc.getText("contents").insert(0, "original offline edits"); await legacy.markRestoreReview(); await legacy.close();
	const before = await readDocumentRecoverySnapshot(legacyName), buffers = new UnsavedFileStore();
	await buffers.persistUnsaved(note, "original unsaved buffer");
	const fresh = await open(value), descriptor = await sourceDocumentCache(value);
	expect(fresh.doc.getText("contents").toString()).toBe(""); expect(fresh.restoreReviewRequired).toBe(false);
	expect(await buffers.readUnsaved(descriptor.bufferKey)).toBeNull();
	fresh.doc.getText("contents").insert(0, "restored generation edits");
	await buffers.persistUnsaved(descriptor.bufferKey, "restored buffer"); await fresh.close();
	const reopened = await open(value);
	expect(reopened.doc.getText("contents").toString()).toBe("restored generation edits");
	expect(await buffers.readUnsaved(note)).toBe("original unsaved buffer");
	expect(await buffers.readUnsaved(descriptor.bufferKey)).toBe("restored buffer");
	expect(await readDocumentRecoverySnapshot(legacyName)).toEqual(before);
});

test("every durable identity boundary separates history; equivalent endpoints and generation case reuse it", async () => {
	const value = identity(), base = await sourceDocumentCache(value);
	const variants: SourceDocumentIdentity[] = [
		{ ...value, hostAppId: "another-vault" }, { ...value, serverId: "another-server" },
		{ ...value, controlPlaneUrl: "https://another.test" }, { ...value, controlPlaneUrl: "https://fixture.test/another" },
		{ ...value, s3rn: ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", crypto.randomUUID(), note)) },
		{ ...value, s3rn: ResourceAddress.serialize(new RemoteCanvasAddress("relay-onprem", share, note)) },
		{ ...value, restoreGeneration: null }, { ...value, restoreGeneration: crypto.randomUUID() },
	];
	const names = await Promise.all(variants.map(async next => (await sourceDocumentCache(next)).name));
	expect(new Set([base.name, ...names]).size).toBe(variants.length + 1);
	expect(await sourceDocumentCache({ ...value, controlPlaneUrl: "https://FIXTURE.test:443/", restoreGeneration: generation.toUpperCase() })).toEqual(base);
	expect(base.name.length).toBeLessThan(100); expect(base.bufferKey).toBe(base.name);
	expect(await sourceDocumentCache({ ...value, restoreGeneration: undefined })).toEqual(await sourceDocumentCache({ ...value, restoreGeneration: null }));
});

test.each(["https://user:secret@fixture.test", "https://fixture.test?token=secret", "https://fixture.test#secret", "file:///tmp/source"])("rejects credential-bearing or unsupported endpoint %s", async controlPlaneUrl => {
	await expect(sourceDocumentCache({ ...identity(), controlPlaneUrl })).rejects.toThrow("endpoint");
});

test.each(["s3rn:relay:folder:" + share, "ignored:relay:folder:" + share + ":doc:" + note,
	"s3rn:relay:folder:" + share + ":doc:" + note + ":junk:tail"])("rejects ambiguous or non-document address %s", async s3rn => {
	await expect(sourceDocumentCache({ ...identity(), s3rn })).rejects.toThrow();
});

test("a missing identity cannot claim a populated cache or replay it into the requesting document", async () => {
	const value = identity(), descriptor = await sourceDocumentCache(value);
	const unclaimed = new LocalDocumentStore(descriptor.name, document()); stores.push(unclaimed);
	unclaimed.doc.getText("contents").insert(0, "unassociated retained work"); await unclaimed.close();
	const before = await readDocumentRecoverySnapshot(descriptor.name), target = document();
	await expect(openSourceDocumentCache(value, target)).rejects.toThrow("identity");
	expect(target.getText("contents").toString()).toBe("");
	expect(await readDocumentRecoverySnapshot(descriptor.name)).toEqual(before);
});

test("metadata-only populated caches are not adopted either", async () => {
	const value = identity(), descriptor = await sourceDocumentCache(value);
	const unclaimed = new LocalDocumentStore(descriptor.name, document()); stores.push(unclaimed);
	await unclaimed.set("unknown-history", "retained"); await unclaimed.close();
	await expect(open(value)).rejects.toThrow("identity");
});

test("mismatched and unbound opens reject before replay or accepting queued writes", async () => {
	const value = identity(), first = await open(value), descriptor = await sourceDocumentCache(value);
	first.doc.getText("contents").insert(0, "bound work"); await first.close();
	const before = await readDocumentRecoverySnapshot(descriptor.name);
	for (const expected of [undefined, "different identity"]) {
		const doc = document(), wrong = new LocalDocumentStore(descriptor.name, doc, expected); stores.push(wrong);
		doc.getText("contents").insert(0, "must not persist");
		await expect(wrong.whenSynced).rejects.toThrow("identity");
		await expect(wrong.close()).rejects.toThrow("identity");
		expect(doc.getText("contents").toString()).toBe("must not persist");
		expect(await readDocumentRecoverySnapshot(descriptor.name)).toEqual(before);
	}
});

test("concurrent matching opens share one atomic identity and retain both editors", async () => {
	const value = identity(), [first, second] = await Promise.all([open(value), open(value)]);
	first.doc.getText("contents").insert(0, "first"); second.doc.getText("contents").insert(0, "second");
	await Promise.all([first.close(), second.close()]);
	const reopened = await open(value), text = reopened.doc.getText("contents").toString();
	expect(text).toContain("first"); expect(text).toContain("second");
	await expect(reopened.set(SOURCE_CACHE_IDENTITY, "replacement")).rejects.toThrow("immutable");
	await expect(reopened.del(SOURCE_CACHE_IDENTITY)).rejects.toThrow("immutable");
});

test("competing identities cannot both claim the same empty database", async () => {
	const name = `claim-race-${crypto.randomUUID()}`;
	const first = new LocalDocumentStore(name, document(), "first"), second = new LocalDocumentStore(name, document(), "second");
	stores.push(first, second);
	const results = await Promise.allSettled([first.whenSynced, second.whenSynced]);
	expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
});

test("a pause remains durable in its selected generation without pausing the next cache", async () => {
	const value = identity(), first = await open(value); await first.markRestoreReview(); await first.close();
	expect((await open(value)).restoreReviewRequired).toBe(true);
	expect((await open({ ...value, restoreGeneration: crypto.randomUUID() })).restoreReviewRequired).toBe(false);
});
