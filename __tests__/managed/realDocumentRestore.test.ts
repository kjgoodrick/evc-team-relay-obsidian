import "fake-indexeddb/auto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { ProviderBacked } from "../../src/ProviderBacked";
import { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../../src/auth/RelayOnPremTokenProvider";
import { RemoteCanvasAddress, RemoteDocumentAddress, ResourceAddress } from "../../src/ResourceAddress";
import { SystemClock } from "../../src/Clock";
import type { AuthSession } from "../../src/AuthSession";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { LocalDocumentStore } from "../../src/storage/local-document-store";
import { openSourceDocumentCache, type SourceDocumentIdentity } from "../../src/storage/source-document-cache";
import { readManagedSource } from "../../src/client/readManagedSource";
import { proveSourceInstallation } from "../mocks/sourceInstallationHttpProof";
import { RemoteFolderAddress } from "../../src/ResourceAddress";
import { Document } from "../../src/Document";
import { TransferQueue } from "../../src/TransferQueue";
import { CanvasDocument } from "../../src/CanvasDocument";
import type { CanvasNodeData } from "../../src/HostCanvasView";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
jest.mock("obsidian", () => ({ ...jest.requireActual("../mocks/obsidian"), FileSystemAdapter: class {} }));

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
	async function grant(mode: "read" | "write", generation?: string, expected = 200, documentId = f.note) {
		const response = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: `Bearer ${f.ownerToken}`,
			"Content-Type": "application/json", ...(generation ? { "X-Relay-Restore-Generation": generation } : {}) },
			body: JSON.stringify({ share_id: f.share, doc_id: documentId, mode }) });
		expect(response.status).toBe(expected);
		return response.json() as Promise<{ token: string; relay_url: string; restore_generation: string | null }>;
	}
	async function peer(auth: { relay_url: string; token: string }, documentId = f.note) {
		const doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, documentId, doc, { connect: false, disableBc: true, params: { token: auth.token } });
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
		const originalCanvas = await peer(await grant("write", undefined, 200, f.canvas), f.canvas);
		originalCanvas.doc.getMap("nodes").set("card", { id: "card", type: "text", text: "legacy fallback", x: 10, y: 20, width: 200, height: 100 });
		originalCanvas.doc.getText("card").insert(0, "Canvas before rotation\n");
		const canvasReader = await peer(await grant("read", undefined, 200, f.canvas), f.canvas);
		await until(() => canvasReader.doc.getText("card").toString() === "Canvas before rotation\n", "original Canvas content");
		const generation = crypto.randomUUID();
		fs.writeFileSync(path.join(f.restartDir, "rotate-request"), generation);
		await until(() => fs.existsSync(path.join(f.restartDir, "rotate-done")), "fixture generation rotation");
		await until(() => !writer.provider.wsconnected && !reader.provider.wsconnected, "active old sockets closed");
		await until(() => !originalCanvas.provider.wsconnected && !canvasReader.provider.wsconnected, "original Canvas sockets closed");
		originalCanvas.provider.disconnect(); canvasReader.provider.disconnect();
		originalCanvas.doc.getText("card").insert(0, "OLD OFFLINE CANVAS EDIT\n");
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
		const scoped = await writer.cache.getToken(ResourceAddress.serialize(address), "Note.md", () => {}, "fixture", { restoreGeneration: generation });
		expect(scoped.restoreGeneration).toBe(generation); expect(writer.backing.restoreReviewRequired).toBe(true);
		// A separately opened source cache consumes the explicitly selected
		// generation through the normal provider and credential paths. The old
		// automatic source client and its retained edits remain paused.
		const sourceIdentity: SourceDocumentIdentity = { hostAppId: "actual-restore-fixture", serverId: "fixture", controlPlaneUrl: f.base,
			s3rn: ResourceAddress.serialize(address), restoreGeneration: generation };
		async function restoredSource() {
			const backing = new StoredDocument(f.note, address, writer.cache, session, "fixture", { restoreGeneration: generation }); clients.push(backing);
			const store = await openSourceDocumentCache(sourceIdentity, backing.crdtDoc); stores.push(store); backing.attachStore(store);
			return { backing, store, provider: backing._liveProvider, text: backing.crdtDoc.getText("contents") };
		}
		const fresh = await restoredSource();
		expect(fresh.text.toString()).toBe(""); expect(fresh.store.name).not.toBe(writer.store.name);
		expect(await fresh.backing.bringOnline()).toBe(true);
		await until(() => fresh.provider.synced, "selected source generation synchronization");
		expect(fresh.text.toString()).toBe("content before rotation\n");
		fresh.text.insert(fresh.text.length, "bound edit\n");
		const currentReader = await peer(await grant("read", generation));
		await until(() => currentReader.text.toString() === fresh.text.toString(), "fresh bound write/read");
		const sourceBefore = Y.encodeStateAsUpdate(fresh.backing.crdtDoc);
		const preview = await readManagedSource(writer.cache, ResourceAddress.serialize(address), "Note.md", "fixture", { restoreGeneration: generation });
		const inspected = new Y.Doc({ gc: false }); docs.push(inspected); Y.applyUpdate(inspected, preview.update);
		expect(inspected.getText("contents").toString()).toBe("content before rotation\nbound edit\n");
		expect(Y.encodeStateAsUpdate(fresh.backing.crdtDoc)).toEqual(sourceBefore); expect(() => preview.check()).not.toThrow();
		expect(currentReader.text.toString()).not.toContain("OLD OFFLINE");
		expect(writer.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
		expect(cached.text.toString()).toBe("CACHED CLIENT EDIT MUST STAY LOCAL\n");
		expect(uncached.text.toString()).toBe("UNCACHED CLIENT EDIT MUST STAY LOCAL\n");
		fresh.backing.goOffline(); await fresh.store.close(); fresh.backing.dismantle();
		const restoredRestart = await restoredSource();
		expect(restoredRestart.text.toString()).toBe("content before rotation\nbound edit\n");
		expect(await restoredRestart.backing.bringOnline()).toBe(true);
		await until(() => restoredRestart.provider.synced, "selected source generation reconnect");
		expect(writer.backing.restoreReviewRequired).toBe(true);
		await writer.store.close();
		const restarted = client(writer.store.name);
		await expect(restarted.backing.ensureActiveProvider()).rejects.toThrow("restore review");
		expect(await restarted.backing.bringOnline()).toBe(false);
		expect(restarted.requests).not.toHaveBeenCalled();
		expect(restarted.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
		// Exercise the production read-only source download through a full
		// native/cache installation, using the member whose Budget.md is hidden.
		restoredRestart.backing.goOffline(); currentReader.provider.disconnect();
		const memberAuth = { getToken: () => f.bobToken, getValidToken: async () => f.bobToken } as IAuthProvider;
		const memberCache = new RelayCredentialCache(session, new SystemClock(), "disposable", 5,
			new Map([["fixture", new RelayOnPremTokenProvider({ controlPlaneUrl: f.base, authProvider: memberAuth })]])); caches.push(memberCache);
		const folderAddress = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", f.share));
		const inventoryGrant = await memberCache.requestInventoryInspectionToken(folderAddress, "fixture", { restoreGeneration: generation });
		let preparedText = "content before rotation\nbound edit\n";
		const canvasWriter = await peer(await grant("write", generation, 200, f.canvas), f.canvas);
		await until(() => canvasWriter.doc.getText("card").toString() === "Canvas before rotation\n", "Canvas history survives relay restart");
		for (const change of ["append", "clear"] as const) {
			const newerText = change === "append" ? preparedText + "edit after source preparation\n" : "";
			const preparedCanvas = CanvasDocument.exportData(canvasWriter.doc);
			const canvasText = canvasWriter.doc.getText("card");
			const newerCanvasText = change === "append" ? canvasText.toString() + "Canvas edit after preparation\n" : "";
			const newerCanvasX = preparedCanvas.nodes[0].x + 40;
			await proveSourceInstallation(memberCache, { ...f, generation }, inventoryGrant.grant.token, {
				expectedFiles: { "Note.md": preparedText, "Board.canvas": JSON.stringify(preparedCanvas, null, 2) },
				compareJsonFiles: ["Board.canvas"],
				afterPreparation: async () => {
					expect(await restoredRestart.backing.bringOnline()).toBe(true);
					await until(() => restoredRestart.provider.synced, "writer reconnects after source preparation");
					await until(() => restoredRestart.text.toString() === preparedText, "writer has the current document before changing it");
					if (change === "append") restoredRestart.text.insert(restoredRestart.text.length, "edit after source preparation\n");
					else restoredRestart.text.delete(0, restoredRestart.text.length);
					const observer = await peer(await grant("read", generation));
					await until(() => observer.text.toString() === newerText, "server receives edit after source preparation");
					observer.provider.disconnect(); restoredRestart.backing.goOffline();
					if (change === "append") canvasText.insert(canvasText.length, "Canvas edit after preparation\n");
					else canvasText.delete(0, canvasText.length);
					canvasWriter.doc.getMap<CanvasNodeData>("nodes").set("card", { ...preparedCanvas.nodes[0], x: newerCanvasX });
					const canvasObserver = await peer(await grant("read", generation, 200, f.canvas), f.canvas);
					await until(() => canvasObserver.doc.getText("card").toString() === newerCanvasText
						&& canvasObserver.doc.getMap<CanvasNodeData>("nodes").get("card")?.x === newerCanvasX, "server receives Canvas changes after preparation");
					canvasObserver.provider.disconnect();
				},
				verifySelected: async (identity, selected, directory) => {
					const backing = new StoredDocument(f.note, address, memberCache, session, "fixture", selected.binding, selected); clients.push(backing);
					const store = await openSourceDocumentCache({ ...identity, s3rn: ResourceAddress.serialize(address) }, backing.crdtDoc); stores.push(store); backing.attachStore(store);
					const text = backing.crdtDoc.getText("contents");
					expect(text.toString()).toBe(fs.readFileSync(path.join(directory, "Note.md"), "utf8"));
					expect(text.toString()).toBe(preparedText); expect(await store.loadSyncBase()).toBe(preparedText);
					expect(fs.existsSync(path.join(directory, "Budget.md"))).toBe(false);
					expect(await backing.bringOnline()).toBe(true); await until(() => backing._liveProvider.synced, "installed source provider admission");
					await until(() => text.toString() === newerText, "installed source merges the newer server edit");
					// Exercise actual transfer reconciliation with the seeded cache's
					// persistent sync base and real native bytes. Only the Obsidian
					// document host is narrowed; provider/CRDT/store/queue are real.
					const nativePath = path.join(directory, "Note.md"), nativeDoc = Object.create(Document.prototype) as Document;
					const conflictCopy = jest.fn(async () => { throw new Error("An unchanged installed file must not need a conflict copy"); });
					Object.defineProperties(nativeDoc, {
						path: { value: nativePath }, entryPath: { value: "Note.md" }, entityGuid: { value: f.note },
						crdtDoc: { value: backing.crdtDoc }, editLock: { value: false },
						content: { get: () => text.toString() }, restoreReviewRequired: { get: () => backing.restoreReviewRequired },
						awaitFirstSync: { value: async () => {} }, connectionIntent: { get: () => "connected" },
						bringOnline: { value: () => backing.bringOnline() }, _liveProvider: { get: () => backing._liveProvider },
						getSyncBase: { value: () => store.loadSyncBase() }, setSyncBase: { value: (value: string) => store.rememberSyncBase(value) },
						vaultShare: { value: { workspaceId: f.share, isDeletePending: () => false, writeConflictCopy: conflictCopy,
							readContents: () => fs.promises.readFile(nativePath, "utf8"),
							writeContents: (_doc: Document, value: string) => fs.promises.writeFile(nativePath, value) } },
					});
					const queue = new TransferQueue({} as never, new SystemClock(), {} as never);
					try { expect(await queue.uploadDocumentViaSocket(nativeDoc)).toBe(true); }
					finally { queue.shutdown(); }
					expect(fs.readFileSync(nativePath, "utf8")).toBe(newerText);
					expect(await store.loadSyncBase()).toBe(newerText); expect(text.toString()).toBe(newerText);
					expect(conflictCopy).not.toHaveBeenCalled();
					text.insert(text.length, "activated member edit\n");
					const observer = await peer(await grant("read", generation));
					await until(() => observer.text.toString() === text.toString(), "installed source writes through ordinary provider");
					expect(observer.text.toString()).not.toContain("OLD OFFLINE"); expect(observer.text.toString()).not.toContain("CACHED CLIENT");
					backing.goOffline(); await store.close();
					const canvasAddress = new RemoteCanvasAddress("relay-onprem", f.share, f.canvas);
					const canvas = new StoredDocument(f.canvas, canvasAddress, memberCache, session, "fixture", selected.binding, selected); clients.push(canvas);
					const canvasStore = await openSourceDocumentCache({ ...identity, s3rn: ResourceAddress.serialize(canvasAddress) }, canvas.crdtDoc); stores.push(canvasStore); canvas.attachStore(canvasStore);
					expect(CanvasDocument.exportData(canvas.crdtDoc)).toEqual(preparedCanvas);
					expect(JSON.parse(fs.readFileSync(path.join(directory, "Board.canvas"), "utf8"))).toEqual(preparedCanvas);
					expect(await canvas.bringOnline()).toBe(true);
					await until(() => canvas._liveProvider.synced && canvas.crdtDoc.getText("card").toString() === newerCanvasText, "installed Canvas merges newer editing history");
					const canvasData = CanvasDocument.exportData(canvas.crdtDoc);
					expect(canvasData.nodes[0]).toMatchObject({ text: newerCanvasText, x: newerCanvasX });
					expect(canvas.crdtDoc.getText("card").toString()).not.toContain("OLD OFFLINE");
					const canvasPath = path.join(directory, "Board.canvas"), nativeCanvas = Object.create(CanvasDocument.prototype) as CanvasDocument;
					Object.defineProperties(nativeCanvas, {
						entryPath: { value: "Board.canvas" }, entityGuid: { value: f.canvas }, crdtDoc: { value: canvas.crdtDoc },
						editLock: { value: false }, isLocallyPersisted: { value: true }, awaitFirstSync: { value: async () => {} },
						connectionIntent: { get: () => "connected" }, bringOnline: { value: () => canvas.bringOnline() },
						restoreReviewRequired: { get: () => canvas.restoreReviewRequired }, _liveProvider: { get: () => canvas._liveProvider },
						vaultShare: { value: { workspaceId: f.share, folderIndex: { tracks: () => true },
							readContents: () => fs.promises.readFile(canvasPath, "utf8"),
							writeContents: (_doc: CanvasDocument, value: string) => fs.promises.writeFile(canvasPath, value) } },
					});
					expect(nativeCanvas.textNodeSafe(preparedCanvas.nodes[0]).toString()).toBe(newerCanvasText);
					const canvasQueue = new TransferQueue({} as never, new SystemClock(), {} as never);
					try { await canvasQueue.fetchCanvas(nativeCanvas); } finally { canvasQueue.shutdown(); }
					expect(JSON.parse(fs.readFileSync(canvasPath, "utf8"))).toEqual(canvasData);
					const canvasObserver = await peer(await grant("read", generation, 200, f.canvas), f.canvas);
					await until(() => canvasObserver.doc.getMap<CanvasNodeData>("nodes").get("card")?.x === newerCanvasX, "independent Canvas observer receives current structure");
					expect(canvasObserver.doc.getText("card").toString()).toBe(newerCanvasText);
					canvasObserver.provider.disconnect();
					canvas.goOffline(); await canvasStore.close();
				},
			});
			preparedText = newerText + "activated member edit\n";
		}
		expect(writer.text.toString()).toContain("OLD OFFLINE EDIT MUST STAY LOCAL");
		expect(cached.text.toString()).toBe("CACHED CLIENT EDIT MUST STAY LOCAL\n");
		expect(originalCanvas.doc.getText("card").toString()).toContain("OLD OFFLINE CANVAS EDIT");
	} finally {
		clients.forEach(client => client.dismantle());
		await Promise.all(stores.map(store => store.close()));
		clients.forEach(client => client.crdtDoc.destroy()); caches.forEach(cache => cache.destroy());
		providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy());
	}
}, 30_000);
