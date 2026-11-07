import * as Y from "yjs";

export interface RetainedTextSource { text: Y.Text; dispose(): void }
export interface RetainedTextOptions {
	factory?: IDBFactory;
	current?: () => boolean;
	/** Lower limits are useful for constrained hosts and deterministic tests. */
	maxBytes?: number;
	maxRecords?: number;
	timeoutMs?: number;
}
const MAX_BYTES = 32 * 1024 * 1024, MAX_UPDATE_BYTES = 8 * 1024 * 1024, MAX_RECORDS = 50_000;

/** Read retained Markdown CRDT state without attaching a writer/provider,
 * creating a database, compacting history, or changing any metadata. The caller
 * must authorize the record first, compare source bytes, and dispose the result.
 */
export async function readRetainedTextSource(name: string, options: RetainedTextOptions = {}): Promise<RetainedTextSource | undefined> {
	const factory = options.factory ?? indexedDB, current = options.current ?? (() => true);
	const maxBytes = options.maxBytes ?? MAX_BYTES, maxRecords = options.maxRecords ?? MAX_RECORDS, timeoutMs = options.timeoutMs ?? 5000;
	if (!name || name.length > 1024 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
		!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS ||
		!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid retained source request");
	const active = () => { if (!current()) throw new Error("Retained source access changed"); };
	active();
	const rows = await new Promise<{ updates: Uint8Array[]; initialized: boolean } | undefined>((resolve, reject) => {
		let database: IDBDatabase | undefined, transaction: IDBTransaction | undefined, finished = false, missing = false;
		const finish = (error?: Error, value?: { updates: Uint8Array[]; initialized: boolean }) => {
			if (finished) return; finished = true; window.clearTimeout(timer);
			if (error) { try { transaction?.abort(); } catch { /* Already complete. */ } }
			database?.close(); if (error) reject(error); else resolve(value);
		};
		const timer = window.setTimeout(() => finish(new Error("Retained source read timed out")), timeoutMs);
		let open: IDBOpenDBRequest;
		try { open = factory.open(name); } catch (error) { finish(error instanceof Error ? error : new Error("Retained source unavailable")); return; }
		// open(name) has no read-only option. Aborting a first creation leaves no
		// database behind, including on hosts without IDBFactory.databases().
		open.onupgradeneeded = () => { missing = true; open.transaction?.abort(); };
		open.onerror = () => { if (missing) finish(); else finish(new Error("Retained source could not be opened")); };
		open.onsuccess = () => {
			database = open.result; if (finished) { database.close(); return; }
			try {
				active();
				if (!database.objectStoreNames.contains("updates") || !database.objectStoreNames.contains("custom")) throw new Error("Retained source schema is unavailable");
				transaction = database.transaction(["updates", "custom"], "readonly");
				database.onversionchange = () => finish(new Error("Retained source storage changed"));
				const updates: Uint8Array[] = []; let total = 0, initialized = false;
				const custom = transaction.objectStore("custom"), synced = custom.get("serverSync"), origin = custom.get("origin");
				synced.onsuccess = () => { initialized ||= synced.result === 1; };
				origin.onsuccess = () => { initialized ||= origin.result === "local"; };
				const cursor = transaction.objectStore("updates").openCursor();
				cursor.onsuccess = () => {
					if (finished) return;
					try {
						active(); const row = cursor.result; if (!row) return;
						const value: unknown = row.value, tag = Object.prototype.toString.call(value);
						const bytes = tag === "[object Uint8Array]" ? value as Uint8Array : tag === "[object ArrayBuffer]" ? new Uint8Array(value as ArrayBuffer) : undefined;
						if (!bytes || !bytes.byteLength || bytes.byteLength > MAX_UPDATE_BYTES || updates.length >= maxRecords ||
							(total += bytes.buffer.byteLength) > maxBytes) throw new Error("Retained source history exceeds capture limits or is invalid");
						updates.push(bytes); row.continue();
					} catch (error) { finish(error instanceof Error ? error : new Error("Retained source could not be read")); }
				};
				transaction.onabort = () => finish(new Error("Retained source read was interrupted"));
				transaction.onerror = () => { /* onabort reports the final result. */ };
				transaction.oncomplete = () => finish(undefined, { updates, initialized });
			} catch (error) { finish(error instanceof Error ? error : new Error("Retained source unavailable")); }
		};
	});
	active();
	if (!rows?.initialized) return undefined; // Never treat an uninitialized cache as an empty note.
	const doc = new Y.Doc(); let sliceStarted = Date.now();
	try {
		for (const update of rows.updates) {
			active(); Y.applyUpdate(doc, update);
			if (Date.now() - sliceStarted >= 8) { await new Promise<void>(resolve => window.setTimeout(resolve, 0)); sliceStarted = Date.now(); }
		}
		active();
		if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) throw new Error("Retained source history is incomplete; synchronize the note before capturing it");
		const text = doc.getText("contents");
		if (text.length > 2 * 1024 * 1024) throw new Error("Retained source note exceeds capture limits");
		return { text, dispose: () => doc.destroy() };
	} catch (error) { doc.destroy(); throw error; }
}
