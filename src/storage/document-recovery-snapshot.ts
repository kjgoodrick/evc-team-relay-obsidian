import * as Y from "yjs";
import { SOURCE_CACHE_IDENTITY } from "./document-cache-binding";

export interface DocumentRecoverySnapshot {
	exists: boolean;
	version?: number;
	updateCount: number;
	update: Uint8Array;
	/** Raw, structured-cloned metadata; portable export must encode values explicitly. */
	custom: { key: IDBValidKey; value: unknown }[];
}

/** A missing cache is reported without committing a newly created database. */
function openExisting(name: string, signal?: AbortSignal): Promise<IDBDatabase | undefined> {
	return new Promise((resolve, reject) => {
		const cancelled = () => Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" });
		if (signal?.aborted) { reject(cancelled()); return; }
		let created = false, settled = false;
		const request = indexedDB.open(name);
		const timer = window.setTimeout(() => finish(new Error("Opening the recovery cache timed out")), 10_000);
		const finish = (error?: Error, db?: IDBDatabase) => {
			if (settled) { db?.close(); return; }
			settled = true; window.clearTimeout(timer); signal?.removeEventListener("abort", abort);
			if (error) reject(error); else resolve(db);
		};
		const abort = () => finish(cancelled());
		signal?.addEventListener("abort", abort, { once: true });
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

export interface DocumentComparisonSnapshot extends DocumentRecoveryIdentity { update: Uint8Array; updateCount: number }
export interface DocumentComparisonOptions { check?: () => void; signal?: AbortSignal; maxBytes?: number; maxRecords?: number; timeoutMs?: number }

/** Bounded inline review, distinct from a lossless recovery export. Reads only
 * association metadata and update rows in one readonly transaction. Unrelated
 * custom metadata is neither enumerated nor loaded for a text comparison. */
export async function readDocumentComparisonSnapshot(name: string, options: DocumentComparisonOptions = {}): Promise<DocumentComparisonSnapshot> {
	const maxBytes = options.maxBytes ?? 16 * 1024 * 1024, maxRecords = options.maxRecords ?? 50_000, timeoutMs = options.timeoutMs ?? 5_000;
	if (typeof name !== "string" || !name || name.length > 1024 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024
		|| !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 50_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid source comparison cache limits");
	const check = () => { if (options.signal?.aborted) throw Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" }); options.check?.(); };
	check(); const db = await openExisting(name, options.signal);
	try {
		check();
		if (!db) return { exists: false, updateCount: 0, update: Y.mergeUpdates([]) };
		if (!db.objectStoreNames.contains("updates") || !db.objectStoreNames.contains("custom")) throw new Error("Unsupported source comparison cache schema");
		const snapshot = await new Promise<{ updates: Uint8Array[]; appId?: unknown; s3rn?: unknown }>((resolve, reject) => {
			const tx = db.transaction(["updates", "custom"], "readonly"), updates: Uint8Array[] = [];
			let finished = false, total = 0;
			const finish = (error?: Error) => {
				if (finished) return; finished = true; window.clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
				if (error) { try { tx.abort(); } catch { /* Already complete. */ } reject(error); }
				else resolve({ updates, appId: appId.result, s3rn: s3rn.result });
			};
			const abort = () => finish(Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" }));
			const timer = window.setTimeout(() => finish(new Error("Reading the source comparison cache timed out")), timeoutMs);
			options.signal?.addEventListener("abort", abort, { once: true });
			db.onversionchange = () => { finish(new Error("The source comparison cache changed")); db.close(); };
			const custom = tx.objectStore("custom"), appId = custom.get("appId"), s3rn = custom.get("s3rn");
			for (const request of [appId, s3rn]) request.onsuccess = () => {
				if (request.result !== undefined && (typeof request.result !== "string" || request.result.length > 2048)) finish(new Error("The source comparison cache association is invalid"));
			};
			const cursor = tx.objectStore("updates").openCursor();
			cursor.onsuccess = () => {
				if (finished) return;
				try {
					check(); const row = cursor.result; if (!row) return;
					const value: unknown = row.value;
					const size = ArrayBuffer.isView(value) ? value.buffer.byteLength : Object.prototype.toString.call(value) === "[object ArrayBuffer]" ? (value as ArrayBuffer).byteLength : undefined;
					if (size === undefined || !size) throw new Error("The source comparison cache has an invalid update");
					if (updates.length >= maxRecords || (total += size) > maxBytes) throw new Error("The retained history is too large for an inline comparison. Save a recovery copy instead.");
					updates.push(updateBytes(value)); row.continue();
				} catch (error) { finish(error instanceof Error ? error : new Error("The source comparison cache could not be read")); }
			};
			tx.onabort = () => finish(tx.error ?? new Error("Reading the source comparison cache was interrupted"));
			tx.onerror = () => { /* onabort reports failure. */ };
			tx.oncomplete = () => { try { check(); finish(); } catch (error) { finish(error instanceof Error ? error : new Error("The source comparison context changed")); } };
		});
		check(); const update = Y.mergeUpdates(snapshot.updates); Y.decodeUpdate(update); check();
		return { exists: true, updateCount: snapshot.updates.length, update, appId: snapshot.appId, s3rn: snapshot.s3rn };
	} finally { db?.close(); }
}

function updateBytes(value: unknown): Uint8Array {
	if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value as ArrayBuffer).slice();
	throw new Error("Document recovery cache contains an unsupported update record");
}

export interface DocumentRecoveryIdentity { exists: boolean; appId?: unknown; s3rn?: unknown }

/** Namespace discovery reads identity only, never comparison text or updates. */
export async function readSourceDocumentRecoveryIdentity(name: string): Promise<{ exists: boolean; identity?: unknown }> {
	if (!/^relay-(?:source|inventory)-v1-[a-f0-9]{64}$/.test(name)) throw new Error("Invalid source cache name");
	const db = await openExisting(name);
	if (!db) return { exists: false };
	db.onversionchange = () => db.close();
	try {
		return await new Promise((resolve, reject) => {
			const tx = db.transaction("custom", "readonly"), identity = tx.objectStore("custom").get(SOURCE_CACHE_IDENTITY);
			tx.oncomplete = () => resolve({ exists: true, identity: identity.result });
			tx.onabort = () => reject(tx.error ?? new Error("Unable to read source cache identity"));
			tx.onerror = () => { /* onabort reports failure */ };
		});
	} finally { db.close(); }
}

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
