import "fake-indexeddb/auto";
import * as Y from "yjs";
import { LocalDocumentStore } from "../src/storage/local-document-store";

// Regression for: a freshly-opened store's own constructor read
// `this.get(KEY_SERVER_SYNC)`/`this.get(KEY_ORIGIN)` -- and `get()` awaits
// `this._dbref`, the very promise whose `.then()` callback was running that
// statement. A promise cannot settle before its own callback returns, so
// this was a deterministic deadlock, not a timing race: `synced` never
// became `true`, `emit("synced")` never fired, and every caller gated on
// `awaitSynced()` (a new folder share's whole adopt-local-files path, among
// others) hung forever. Reproduced identically on every construction --
// fresh AND reopening an existing on-disk database -- since this store
// replaced the vendored y-indexeddb implementation (867e818, 2026-09-07).
describe("LocalDocumentStore", () => {
	function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			p,
			new Promise<T>((_, reject) =>
				window.setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms),
			),
		]);
	}

	test("a fresh store (no prior on-disk data) reaches synced", async () => {
		const doc = new Y.Doc();
		const store = new LocalDocumentStore(`fresh-${Math.random()}`, doc);

		await withTimeout(store.whenSynced, 2000, "whenSynced");

		expect(store.synced).toBe(true);
	});

	test("reopening an existing on-disk database also reaches synced, with prior content and server-sync flag intact", async () => {
		const name = `reopen-${Math.random()}`;

		const doc1 = new Y.Doc();
		const store1 = new LocalDocumentStore(name, doc1);
		await withTimeout(store1.whenSynced, 2000, "first open");
		doc1.getText("t").insert(0, "hello");
		// The doc's own "update" event handler persists to IDB asynchronously;
		// give it a tick before asserting the second store sees it.
		await new Promise((r) => window.setTimeout(r, 50));
		await store1.rememberServerSync();

		const doc2 = new Y.Doc();
		const store2 = new LocalDocumentStore(name, doc2);
		await withTimeout(store2.whenSynced, 2000, "reopen");

		expect(store2.synced).toBe(true);
		expect(store2.serverSyncKnown).toBe(true);
		expect(doc2.getText("t").toString()).toBe("hello");
	});

	// A background pull reads the sync base right before writing a
	// peer's edit. Under a bulk import that IndexedDB read queued for 18-38 s,
	// so an open store answers it from memory.
	test("the sync base survives a reopen and is then read without touching IndexedDB", async () => {
		const name = `sync-base-${Math.random()}`;
		const store1 = new LocalDocumentStore(name, new Y.Doc());
		await withTimeout(store1.whenSynced, 2000, "first open");
		expect(await store1.loadSyncBase()).toBeUndefined();
		await store1.rememberSyncBase("agreed text");
		expect(await store1.loadSyncBase()).toBe("agreed text");
		await store1.destroy();

		const store2 = new LocalDocumentStore(name, new Y.Doc());
		await withTimeout(store2.whenSynced, 2000, "reopen");
		const reads = jest.spyOn(IDBObjectStore.prototype, "get");
		try {
			expect(await store2.loadSyncBase()).toBe("agreed text");
			await store2.rememberSyncBase("newer text");
			expect(await store2.loadSyncBase()).toBe("newer text");
			expect(reads).not.toHaveBeenCalled();
		} finally {
			reads.mockRestore();
		}
		expect(await store2.get("syncBase")).toBe("newer text");
	});

	test("a sync base set while the store is still opening is not replaced by the stored one", async () => {
		const name = `sync-base-early-${Math.random()}`;
		const store1 = new LocalDocumentStore(name, new Y.Doc());
		await withTimeout(store1.whenSynced, 2000, "first open");
		await store1.rememberSyncBase("old");
		await store1.destroy();

		const store2 = new LocalDocumentStore(name, new Y.Doc());
		await store2.rememberSyncBase("new");

		expect(await store2.loadSyncBase()).toBe("new");
		expect(await store2.get("syncBase")).toBe("new");
	});

	test("get()/set() work correctly once a store is open", async () => {
		const doc = new Y.Doc();
		const store = new LocalDocumentStore(`getset-${Math.random()}`, doc);
		await withTimeout(store.whenSynced, 2000, "whenSynced");

		expect(await store.get("missing-key")).toBeUndefined();
		await store.set("k", "v");
		expect(await store.get("k")).toBe("v");
	});

	test("detached close remains awaitable and closes the database after clearing listeners", async () => {
		const doc = new Y.Doc();
		const store = new LocalDocumentStore(`destroy-${Math.random()}`, doc);
		await store.whenSynced;
		const db = await store._dbref;
		const dbClose = jest.spyOn(db, "close");
		const listener = jest.fn();
		store.on("synced", listener);

		const detachedClose = store.close;
		await detachedClose();

		expect(dbClose).toHaveBeenCalledTimes(1);
		expect(store._destroyed).toBe(true);
		store.emit("synced", [store]);
		expect(listener).not.toHaveBeenCalled();
		doc.destroy();
		await Promise.resolve();
		expect(dbClose).toHaveBeenCalledTimes(1);
	});

	test("destroying the document also closes its persistence database", async () => {
		const doc = new Y.Doc();
		const store = new LocalDocumentStore(`doc-destroy-${Math.random()}`, doc);
		await store.whenSynced;
		const db = await store._dbref;
		const close = jest.spyOn(db, "close");

		doc.destroy();
		await Promise.resolve();

		expect(store._destroyed).toBe(true);
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("emits the typed synced event with the store as payload", async () => {
		const doc = new Y.Doc();
		const store = new LocalDocumentStore(`event-${Math.random()}`, doc);
		const received: LocalDocumentStore[] = [];
		store.on("synced", (s) => received.push(s));

		await withTimeout(store.whenSynced, 2000, "whenSynced");

		expect(received).toEqual([store]);
	});
});

test("closing immediately after an edit drains the accepted write before restart", async () => {
	const name = `close-with-edit-${crypto.randomUUID()}`;
	const doc = new Y.Doc(), store = new LocalDocumentStore(name, doc);
	await store.whenSynced;
	doc.getText("contents").insert(0, "last offline edit");
	await store.close(); doc.destroy();
	const restored = new Y.Doc(), reopened = new LocalDocumentStore(name, restored);
	await reopened.whenSynced;
	expect(restored.getText("contents").toString()).toBe("last offline edit");
	await reopened.close(); restored.destroy();
});
