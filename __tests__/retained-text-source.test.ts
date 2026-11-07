import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import * as Y from "yjs";
import { LocalDocumentStore } from "../src/storage/local-document-store";
import { readRetainedTextSource } from "../src/storage/retained-text-source";

const request = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
	request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const complete = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
	transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
});
async function seed(factory: IDBFactory, rows: unknown[], custom: Record<string, unknown> = { serverSync: 1 }) {
	const opening = factory.open("retained", 1);
	opening.onupgradeneeded = () => {
		opening.result.createObjectStore("updates", { autoIncrement: true }); opening.result.createObjectStore("custom");
	};
	const db = await request(opening), tx = db.transaction(["updates", "custom"], "readwrite");
	for (const row of rows) tx.objectStore("updates").add(row);
	for (const [key, value] of Object.entries(custom)) tx.objectStore("custom").put(value, key);
	await complete(tx); db.close();
}
async function inspect(factory: IDBFactory, name = "retained") {
	const db = await request(factory.open(name)), tx = db.transaction(["updates", "custom"], "readonly");
	const result = await Promise.all([request(tx.objectStore("updates").getAll()), request(tx.objectStore("updates").getAllKeys()),
		request(tx.objectStore("custom").getAll()), request(tx.objectStore("custom").getAllKeys())]);
	db.close(); return result;
}
function history() {
	const doc = new Y.Doc(), updates: Uint8Array[] = [], text = doc.getText("contents");
	doc.on("update", update => updates.push(update)); text.insert(0, "---\nstatus: Done\n---\nBody");
	text.insert(text.length, " deleted"); text.delete(text.length - 8, 8);
	return { doc, updates, text };
}

test("reads an actual LocalDocumentStore after close without compacting, writing metadata, or retaining a writer", async () => {
	const name = `retained-${crypto.randomUUID()}`, doc = new Y.Doc(), store = new LocalDocumentStore(name, doc);
	await store.whenSynced; const text = doc.getText("contents");
	text.insert(0, "---\nstatus: Done\n---\nBody"); text.insert(text.length, " remove"); text.delete(text.length - 7, 7);
	await store.rememberServerSync(); await store.rememberSyncBase(text.toString()); await store.close();
	const before = await inspect(indexedDB, name), source = await readRetainedTextSource(name);
	expect(source?.text.toString()).toBe(text.toString());
	expect(Y.equalSnapshots(Y.snapshot(source!.text.doc!), Y.snapshot(doc))).toBe(true);
	source!.text.insert(0, "temporary only"); source!.dispose();
	expect(source!.text.doc!.isDestroyed).toBe(true);
	expect(await inspect(indexedDB, name)).toEqual(before);
	doc.destroy();
});

test("missing caches stay absent, including without database enumeration", async () => {
	const factory = new IDBFactory();
	expect(await readRetainedTextSource("absent", { factory })).toBeUndefined();
	expect(await factory.databases()).toEqual([]);
});

test.each([{ origin: "remote" }, { serverSync: true }, {}])("does not interpret uninitialized remote content as an authorized source: %o", async custom => {
	const factory = new IDBFactory(), h = history(); await seed(factory, h.updates, custom);
	expect(await readRetainedTextSource("retained", { factory })).toBeUndefined(); h.doc.destroy();
});

test("locally originated notes and synchronized empty notes remain usable", async () => {
	const factory = new IDBFactory(), h = history(); await seed(factory, h.updates, { origin: "local" });
	const source = await readRetainedTextSource("retained", { factory }); expect(source!.text.toString()).toBe(h.text.toString()); source!.dispose();
	const empty = new IDBFactory(); await seed(empty, [], { serverSync: 1 });
	const blank = await readRetainedTextSource("retained", { factory: empty }); expect(blank!.text.length).toBe(0); blank!.dispose(); h.doc.destroy();
});

test("accepts reordered complete history but refuses missing structures and delete-only dependencies", async () => {
	const h = history(), completeFactory = new IDBFactory();
	await seed(completeFactory, [...h.updates].reverse());
	const source = await readRetainedTextSource("retained", { factory: completeFactory });
	expect(Y.equalSnapshots(Y.snapshot(source!.text.doc!), Y.snapshot(h.doc))).toBe(true); source!.dispose();
	for (const updates of [[h.updates[1]], [h.updates[2]]]) {
		const factory = new IDBFactory(); await seed(factory, updates);
		await expect(readRetainedTextSource("retained", { factory })).rejects.toThrow("incomplete");
	}
	h.doc.destroy();
});

test("bounds update bytes, backing buffers, records, malformed updates and note length", async () => {
	const h = history();
	for (const item of [
		{ rows: h.updates, options: { maxRecords: 1 } },
		{ rows: h.updates, options: { maxBytes: 5 } },
		{ rows: [new Uint8Array(new ArrayBuffer(1024), 0, 2)], options: { maxBytes: 50 } },
		{ rows: [new Uint8Array(8 * 1024 * 1024 + 1)], options: {} },
		{ rows: [new Uint8Array()], options: {} },
		{ rows: ["not an update"], options: {} },
		{ rows: [new Uint8Array([255])], options: {} },
	]) {
		const factory = new IDBFactory(); await seed(factory, item.rows);
		await expect(readRetainedTextSource("retained", { factory, ...item.options })).rejects.toThrow();
	}
	const factory = new IDBFactory(), large = new Y.Doc(); large.getText("contents").insert(0, "a".repeat(2 * 1024 * 1024 + 1));
	await seed(factory, [Y.encodeStateAsUpdate(large)]);
	await expect(readRetainedTextSource("retained", { factory })).rejects.toThrow("note exceeds");
	large.destroy(); h.doc.destroy();
});

test("cancels access changes before open and during a cursor scan without changing retained data", async () => {
	const factory = new IDBFactory(), h = history(); await seed(factory, h.updates);
	const before = await inspect(factory), opening = jest.spyOn(factory, "open");
	await expect(readRetainedTextSource("retained", { factory, current: () => false })).rejects.toThrow("access changed");
	expect(opening).not.toHaveBeenCalled();
	let reads = 0;
	await expect(readRetainedTextSource("retained", { factory, current: () => ++reads < 4 })).rejects.toThrow("access changed");
	expect(await inspect(factory)).toEqual(before); h.doc.destroy();
});

test("times out a blocked open and closes a late connection without starting a transaction", async () => {
	const close = jest.fn(), transaction = jest.fn(), opening = { result: { close, transaction } } as unknown as IDBOpenDBRequest;
	const factory = { open: () => opening } as unknown as IDBFactory;
	await expect(readRetainedTextSource("retained", { factory, timeoutMs: 5 })).rejects.toThrow("timed out");
	opening.onsuccess!.call(opening, new Event("success"));
	expect(close).toHaveBeenCalledTimes(1); expect(transaction).not.toHaveBeenCalled();
});

test("fails unsupported schemas without creating stores or upgrading the database", async () => {
	const factory = new IDBFactory(), db = await request(factory.open("retained", 3)); db.close();
	await expect(readRetainedTextSource("retained", { factory })).rejects.toThrow("schema");
	const after = await request(factory.open("retained")); expect(after.version).toBe(3); expect(after.objectStoreNames.length).toBe(0); after.close();
});
