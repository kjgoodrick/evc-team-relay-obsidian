import "fake-indexeddb/auto";
import { ProviderBacked } from "../src/ProviderBacked";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { RemoteDocumentAddress } from "../src/ResourceAddress";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import type { AuthSession } from "../src/AuthSession";
import * as Y from "yjs";

const share = "11111111-1111-4111-8111-111111111111", note = "22222222-2222-4222-8222-222222222222";
const grant = { token: "cached", url: "ws://fixture/v1/managed/socket", docId: note, expiryTime: Date.now() + 600_000 };
function cache() { return { peekToken: () => grant, getToken: jest.fn(async () => grant), dropFromQueue: jest.fn() } as unknown as RelayCredentialCache; }
class PersistedDocument extends ProviderBacked {
	readonly store: LocalDocumentStore;
	constructor(name: string, credentials: RelayCredentialCache) {
		super(note, new RemoteDocumentAddress("relay-onprem", share, note), credentials,
			{ getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession, "fixture");
		this.store = new LocalDocumentStore(name, this.crdtDoc); this.retainRestoreReviewIn(this.store);
	}
	pause() { this.pauseForRestore(); }
	async close() { this.dismantle(); await this.store.close(); this.crdtDoc.destroy(); }
}

test("a document's own durable review blocks fresh and cached token paths before replay after reopening", async () => {
	const name = `document-review-${crypto.randomUUID()}`, first = new PersistedDocument(name, cache());
	first.crdtDoc.getText("contents").insert(0, "unsent original work"); first.pause();
	await first.close();
	const credentials = cache(), reopened = new PersistedDocument(name, credentials);
	try {
		const connect = jest.spyOn(reopened._liveProvider, "connect");
		jest.spyOn(reopened._liveProvider, "hasUrl").mockReturnValue(true);
		// Start before IndexedDB finishes: cached credentials cannot skip review.
		await expect(reopened.ensureActiveProvider()).rejects.toThrow("restore review");
		expect(await reopened.bringOnline()).toBe(false);
		await expect(reopened.requestProviderToken()).rejects.toThrow("restore review");
		expect(connect).not.toHaveBeenCalled(); expect(credentials.getToken).not.toHaveBeenCalled();
		expect(reopened.crdtDoc.getText("contents").toString()).toBe("unsent original work");
	} finally { await reopened.close(); }
});

test("a live cache rechecks another window's review before returning an otherwise valid grant", async () => {
	const name = `document-window-review-${crypto.randomUUID()}`, credentials = cache();
	const client = new PersistedDocument(name, credentials), other = new LocalDocumentStore(name, new Y.Doc());
	try {
		jest.spyOn(client._liveProvider, "hasUrl").mockReturnValue(true);
		await expect(client.ensureActiveProvider()).resolves.toBe(client);
		await other.markRestoreReview();
		await expect(client.ensureActiveProvider()).rejects.toThrow("restore review");
		expect(client.restoreReviewRequired).toBe(true); expect(credentials.getToken).not.toHaveBeenCalled();
	} finally { await client.close(); await other.close(); other.doc.destroy(); }
});

test("closing while a stored-review read is pending cannot acquire a credential afterward", async () => {
	const credentials = cache(), client = new PersistedDocument(`document-close-${crypto.randomUUID()}`, credentials);
	const pending = client.requestProviderToken(); await client.close();
	await expect(pending).rejects.toThrow("closed"); expect(credentials.getToken).not.toHaveBeenCalled();
});
