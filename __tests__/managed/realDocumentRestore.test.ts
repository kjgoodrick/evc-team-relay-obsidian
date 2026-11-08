import "fake-indexeddb/auto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { ProviderBacked } from "../../src/ProviderBacked";
import { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../../src/auth/RelayOnPremTokenProvider";
import { RemoteDocumentAddress, ResourceAddress } from "../../src/ResourceAddress";
import { SystemClock } from "../../src/Clock";
import type { AuthSession } from "../../src/AuthSession";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { LocalDocumentStore } from "../../src/storage/local-document-store";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));

const fixturePath = process.env.EVC_DOCUMENT_RESTORE_FIXTURE;
const integration = fixturePath ? test : test.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class StoredDocument extends ProviderBacked {
	attachStore(store: LocalDocumentStore) { this.retainRestoreReviewIn(store); }
}
async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) { if (check()) return; await delay(20); }
	throw new Error("Timed out: " + message);
}

integration("managed document sockets reject original grants after generation rotation and never replay their queued edits", async () => {
	const f = JSON.parse(fs.readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1" || !f.restartDir.includes("evc-managed-integration-")) throw new Error("Only a disposable fixture is allowed");
	const providers: YSweetProvider[] = [], docs: Y.Doc[] = [];
	const clients: ProviderBacked[] = [], caches: RelayCredentialCache[] = [];
	const stores: LocalDocumentStore[] = [];
	const address = new RemoteDocumentAddress("relay-onprem", f.share, f.note);
	const auth = { getToken: () => f.ownerToken, getValidToken: async () => f.ownerToken } as IAuthProvider;
	const session = { getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession;
	function client(storeName = `actual-restore-${crypto.randomUUID()}`) {
		const tokenProvider = new RelayOnPremTokenProvider({ controlPlaneUrl: f.base, authProvider: auth });
		const requests = jest.spyOn(tokenProvider, "requestToken");
		const cache = new RelayCredentialCache(session, new SystemClock(), "disposable", 5, new Map([["fixture", tokenProvider]]));
		const backing = new StoredDocument(f.note, address, cache, session, "fixture");
		const store = new LocalDocumentStore(storeName, backing.crdtDoc); stores.push(store); backing.attachStore(store);
		clients.push(backing); caches.push(cache);
		return { backing, cache, requests, store, provider: backing._liveProvider, text: backing.crdtDoc.getText("contents") };
	}
	async function grant(mode: "read" | "write", generation?: string, expected = 200) {
		const response = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: `Bearer ${f.ownerToken}`,
			"Content-Type": "application/json", ...(generation ? { "X-Relay-Restore-Generation": generation } : {}) },
			body: JSON.stringify({ share_id: f.share, doc_id: f.note, mode }) });
		expect(response.status).toBe(expected);
		return response.json() as Promise<{ token: string; relay_url: string; restore_generation: string | null }>;
	}
	async function peer(auth: { relay_url: string; token: string }) {
		const doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect();
		await until(() => provider.synced, "fresh document synchronization");
		return { doc, provider, text: doc.getText("contents") };
	}
	try {
		const original = await grant("write"); expect(original.restore_generation).toBeNull();
		const writer = client(), cached = client(), uncached = client();
		expect(await writer.backing.bringOnline()).toBe(true);
		await until(() => writer.provider.synced, "actual document client synchronized");
		// An offline client may hold a valid, unexpired grant when the restore happens.
		await cached.cache.getToken(ResourceAddress.serialize(address), "Note.md", () => {}, "fixture");
		const reader = await peer(await grant("read"));
		writer.text.insert(0, "content before rotation\n");
		await until(() => reader.text.toString() === writer.text.toString(), "original content");
		const generation = crypto.randomUUID();
		fs.writeFileSync(path.join(f.restartDir, "rotate-request"), generation);
		await until(() => fs.existsSync(path.join(f.restartDir, "rotate-done")), "fixture generation rotation");
		await until(() => !writer.provider.wsconnected && !reader.provider.wsconnected, "active old sockets closed");
		await until(() => writer.backing.restoreReviewRequired, "active client pauses for review");
		reader.provider.disconnect();
		writer.text.insert(writer.text.length, "OLD OFFLINE EDIT MUST STAY LOCAL\n");
		expect(await writer.backing.bringOnline()).toBe(false);
		cached.text.insert(0, "CACHED CLIENT EDIT MUST STAY LOCAL\n");
		expect(await cached.backing.bringOnline()).toBe(true);
		await until(() => cached.backing.restoreReviewRequired, "cached grant receives restore close on admission");
		uncached.text.insert(0, "UNCACHED CLIENT EDIT MUST STAY LOCAL\n");
		expect(await uncached.backing.bringOnline()).toBe(false);
		expect(uncached.backing.restoreReviewRequired).toBe(true);
		await delay(1500);
		for (const peer of [writer, cached, uncached]) {
			expect(peer.provider.shouldConnect).toBe(false); expect(peer.provider.wsconnected).toBe(false);
			expect(peer.requests).toHaveBeenCalledTimes(1);
			expect(await peer.backing.bringOnline()).toBe(false);
		}
		await grant("write", undefined, 409); await grant("read", undefined, 409);
		await grant("write", crypto.randomUUID(), 409);
		const bound = await grant("write", generation); expect(bound.restore_generation).toBe(generation);
		const fresh = await peer(bound);
		expect(fresh.text.toString()).toBe("content before rotation\n");
		fresh.text.insert(fresh.text.length, "bound edit\n");
		const currentReader = await peer(await grant("read", generation));
		await until(() => currentReader.text.toString() === fresh.text.toString(), "fresh bound write/read");
		expect(currentReader.text.toString()).not.toContain("OLD OFFLINE");
		expect(writer.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
		expect(cached.text.toString()).toBe("CACHED CLIENT EDIT MUST STAY LOCAL\n");
		expect(uncached.text.toString()).toBe("UNCACHED CLIENT EDIT MUST STAY LOCAL\n");
		await writer.store.close();
		const restarted = client(writer.store.name);
		await expect(restarted.backing.ensureActiveProvider()).rejects.toThrow("restore review");
		expect(await restarted.backing.bringOnline()).toBe(false);
		expect(restarted.requests).not.toHaveBeenCalled();
		expect(restarted.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
	} finally {
		clients.forEach(client => client.dismantle());
		await Promise.all(stores.map(store => store.close()));
		clients.forEach(client => client.crdtDoc.destroy()); caches.forEach(cache => cache.destroy());
		providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy());
	}
}, 30_000);
