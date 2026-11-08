import * as Y from "yjs";

export interface DocumentRecoverySnapshot {
	exists: boolean;
	version?: number;
	updateCount: number;
	update: Uint8Array;
	/** Raw, structured-cloned metadata; portable export must encode values explicitly. */
	custom: { key: IDBValidKey; value: unknown }[];
}

/** A missing cache is reported without committing a newly created database. */
function openExisting(name: string): Promise<IDBDatabase | undefined> {
	return new Promise((resolve, reject) => {
		let created = false, settled = false;
		const request = indexedDB.open(name);
		const timer = window.setTimeout(() => finish(new Error("Opening the recovery cache timed out")), 10_000);
		const finish = (error?: Error, db?: IDBDatabase) => {
			if (settled) { db?.close(); return; }
			settled = true; window.clearTimeout(timer);
			if (error) reject(error); else resolve(db);
		};
		request.onupgradeneeded = () => { created = true; request.transaction!.abort(); };
		request.onblocked = () => finish(new Error("Another window is changing the document cache; retry after it finishes"));
		request.onerror = event => {
			event.preventDefault();
			if (created && request.error?.name === "AbortError") finish();
			else finish(request.error ?? new Error("Unable to open the document recovery cache"));
		};
		request.onsuccess = () => finish(undefined, request.result);
	});
}

function updateBytes(value: unknown): Uint8Array {
	if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer).slice();
	throw new Error("Document recovery cache contains an unsupported update record");
}

export interface DocumentRecoveryIdentity { exists: boolean; appId?: unknown; s3rn?: unknown }

/** Read only association fields while looking for histories absent from the
 * inventory. Do not load another share's update log or comparison text. */
export async function readDocumentRecoveryIdentity(name: string): Promise<DocumentRecoveryIdentity> {
	if (typeof name !== "string" || !name || name.length > 1024) throw new Error("Invalid document cache name");
	const db = await openExisting(name);
	if (!db) return { exists: false };
	db.onversionchange = () => db.close();
	try {
		if (!db.objectStoreNames.contains("custom")) throw new Error("Unsupported document recovery cache schema");
		return await new Promise<DocumentRecoveryIdentity>((resolve, reject) => {
			const tx = db.transaction("custom", "readonly"), store = tx.objectStore("custom");
			const appId = store.get("appId"), s3rn = store.get("s3rn");
			tx.oncomplete = () => resolve({ exists: true, appId: appId.result, s3rn: s3rn.result });
			tx.onabort = () => reject(tx.error ?? new Error("Unable to read the document cache identity"));
			tx.onerror = () => { /* onabort reports the read failure */ };
		});
	} finally { db.close(); }
}

/**
 * Take one readonly transaction snapshot. Unlike opening LocalDocumentStore,
 * this never subscribes to a Y.Doc, appends live edits, or compacts the cache.
 * Merging encoded updates directly retains updates with missing dependencies.
 */
export async function readDocumentRecoverySnapshot(name: string): Promise<DocumentRecoverySnapshot> {
	if (typeof name !== "string" || !name || name.length > 1024) throw new Error("Invalid document cache name");
	const db = await openExisting(name);
	if (!db) return { exists: false, updateCount: 0, update: Y.mergeUpdates([]), custom: [] };
	db.onversionchange = () => db.close();
	try {
		if (!db.objectStoreNames.contains("updates") || !db.objectStoreNames.contains("custom")) throw new Error("Unsupported document recovery cache schema");
		const snapshot = await new Promise<{ records: unknown[]; keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
			const tx = db.transaction(["updates", "custom"], "readonly");
			const updates = tx.objectStore("updates").getAll();
			const custom = tx.objectStore("custom"), keys = custom.getAllKeys(), values = custom.getAll();
			tx.oncomplete = () => resolve({ records: updates.result, keys: keys.result, values: values.result });
			tx.onabort = () => reject(tx.error ?? new Error("Unable to read the document recovery cache"));
			tx.onerror = () => { /* onabort reports the read failure */ };
		});
		const update = Y.mergeUpdates(snapshot.records.map(updateBytes));
		// mergeUpdates returns its sole input directly, so validate even a
		// one-record cache instead of treating a truncated payload as usable.
		Y.decodeUpdate(update);
		return { exists: true, version: db.version, updateCount: snapshot.records.length, update,
			custom: snapshot.keys.map((key, i) => ({ key, value: snapshot.values[i] })) };
	} finally { db.close(); }
}
