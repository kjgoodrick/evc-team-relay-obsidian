export const SOURCE_CACHE_IDENTITY = "sourceCacheIdentity";

/** Claim only a completely empty database, atomically with identity storage.
 * A missing identity on populated storage is ambiguous, never an invitation
 * to relabel existing history. Validate before any replay or accepted write. */
export function bindDocumentCache(db: IDBDatabase, expected?: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(["custom", "updates"], expected === undefined ? "readonly" : "readwrite");
		const custom = tx.objectStore("custom"), identity = custom.get(SOURCE_CACHE_IDENTITY), present = custom.count(SOURCE_CACHE_IDENTITY);
		let failure: Error | undefined;
		const refuse = () => { failure = new Error("Document cache identity does not match. Retained history was not loaded or changed."); tx.abort(); };
		present.onsuccess = () => {
			if (present.result) { if (expected === undefined || identity.result !== expected) refuse(); return; }
			if (expected === undefined) return;
			const updates = tx.objectStore("updates").count(), metadata = custom.count();
			metadata.onsuccess = () => {
				if (updates.result !== 0 || metadata.result !== 0) { refuse(); return; }
				custom.add(expected, SOURCE_CACHE_IDENTITY);
			};
		};
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(failure ?? tx.error ?? new Error("Unable to validate document cache identity"));
		tx.onerror = () => { /* onabort reports the transaction failure */ };
	});
}
