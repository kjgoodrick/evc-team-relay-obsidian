import { TFile, Vault } from "obsidian";

interface PathParts {
	name: string;
	extension: string;
	basename: string;
}

function splitPath(path: string): PathParts {
	const name = path.split("/").pop() || "";
	const extension = name.includes(".") ? (name.split(".").pop() ?? "") : "";
	const basename = name.replace(`.${extension}`, "");
	return { name, extension, basename };
}

/**
 * An in-memory stand-in for a vault TFile, used while a document's real file
 * hasn't been (re)created on disk yet. `delete()` is a no-op by design — there
 * is nothing on disk to remove.
 */
export class UnsavedFile implements TFile {
	path: string;
	name: string;
	extension: string;
	basename: string;
	parent: null = null;
	stat: {
		ctime: number;
		mtime: number;
		size: number;
	};

	constructor(
		public vault: Vault,
		path: string,
		public unsavedText: string,
		private readonly saveContents?: (contents: string) => Promise<void>,
	) {
		this.path = path;
		const parts = splitPath(path);
		this.name = parts.name;
		this.extension = parts.extension;
		this.basename = parts.basename;
		this.stat = {
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
	}

	delete(): Promise<void> {
		return Promise.resolve();
	}
	async writeContents(contents: string): Promise<void> {
		if (this.saveContents) await this.saveContents(contents);
		else this.unsavedText = contents;
	}

	moveTo(newPath: string): Promise<void> {
		this.path = newPath;
		const parts = splitPath(newPath);
		this.name = parts.name;
		this.extension = parts.extension;
		this.basename = parts.basename;
		return Promise.resolve();
	}

	parentPath(): string {
		return this.path.substring(0, this.path.lastIndexOf("/"));
	}
}

/**
 * Persists UnsavedFile contents to IndexedDB, keyed by document guid, so an
 * unsaved edit survives an Obsidian reload before the real file exists.
 *
 * Database/store names and the "guid" keyPath are the on-disk wire format —
 * changing them would orphan buffers already saved by earlier plugin
 * versions, so they're kept byte-identical to before this rewrite.
 */
export class UnsavedFileStore {
	private static readonly DB_NAME = "RelayDiskBuffer";
	private static readonly STORE_NAME = "diskBuffers";

	private pendingDatabase: Promise<IDBDatabase> | null = null;

	private initDatabase(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(UnsavedFileStore.DB_NAME, 1);
			let finished = false;
			const fail = (error: unknown) => { if (finished) return; finished = true; window.clearTimeout(timer); reject(error); };
			const timer = window.setTimeout(() => fail(new Error("Opening the local buffer store timed out")), 5000);
			request.onupgradeneeded = (event) => {
				if (finished) { request.transaction!.abort(); return; }
				const db = (event.target as IDBOpenDBRequest).result;
				db.createObjectStore(UnsavedFileStore.STORE_NAME, { keyPath: "guid" });
			};
			request.onsuccess = () => {
				if (finished) { request.result.close(); return; }
				finished = true; window.clearTimeout(timer);
				const db = request.result, pending = this.pendingDatabase;
				db.onversionchange = () => { db.close(); if (this.pendingDatabase === pending) this.pendingDatabase = null; };
				resolve(db);
			};
			request.onblocked = () => fail(new Error("The local buffer store is blocked by another window"));
			request.onerror = () => fail(request.error ?? new Error("Failed to open database"));
		});
	}

	private async database(): Promise<IDBDatabase> {
		if (!this.pendingDatabase) {
			const pending = this.initDatabase(); this.pendingDatabase = pending;
			void pending.catch(() => { if (this.pendingDatabase === pending) this.pendingDatabase = null; });
		}
		return this.pendingDatabase;
	}

	private async withStore<T>(
		mode: IDBTransactionMode,
		run: (store: IDBObjectStore) => IDBRequest<T>,
		errorMessage: string,
	): Promise<T> {
		const db = await this.database();
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(UnsavedFileStore.STORE_NAME, mode);
			let request: IDBRequest<T>;
			try { request = run(tx.objectStore(UnsavedFileStore.STORE_NAME)); }
			catch (error) { tx.abort(); reject(error instanceof Error ? error : new Error(String(error))); return; }
			// Request success only means the operation was admitted. A quota,
			// storage or explicit abort may still roll back the transaction.
			tx.oncomplete = () => resolve(request.result);
			tx.onabort = () => reject(tx.error ?? request.error ?? new Error(errorMessage));
			tx.onerror = () => { /* onabort reports the final transaction outcome */ };
		});
	}

	async persistUnsaved(guid: string, contents: string): Promise<void> {
		await this.withStore(
			"readwrite",
			(store) => store.put({ guid, contents }),
			"Failed to save disk buffer",
		);
	}

	async readUnsaved(guid: string): Promise<string | null> {
		const result = await this.withStore<{ contents: string } | undefined>(
			"readonly",
			(store) => store.get(guid) as IDBRequest<{ contents: string } | undefined>,
			"Failed to load disk buffer",
		);
		if (result !== undefined && (!result || typeof result.contents !== "string")) throw new Error("The saved document buffer is invalid. Retain it for recovery before continuing.");
		return result === undefined ? null : result.contents;
	}

	/** Inspect only selected keys, without loading their potentially large text
	 * or touching other generations' buffers. Activation must refuse any saved
	 * destination work rather than treating an empty source cache as consent. */
	async countSavedBuffers(input: readonly string[], options: { check: () => void; signal?: AbortSignal; timeoutMs?: number }): Promise<number> {
		if (!Array.isArray(input) || input.length > 10_000 || input.some(key => typeof key !== "string" || !key || key.length > 512)) throw new Error("Invalid saved-buffer inspection keys");
		const keys = [...new Set(input)], checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 5000;
		if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid saved-buffer inspection timeout");
		const cancelled = () => Object.assign(new Error("Saved-buffer inspection was cancelled"), { name: "AbortError" });
		const check = () => { if (signal?.aborted) throw cancelled(); checkContext(); };
		check(); if (!keys.length) return 0;
		const db = await this.database(); check();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(UnsavedFileStore.STORE_NAME, "readonly"), store = tx.objectStore(UnsavedFileStore.STORE_NAME);
			let count = 0, failure: unknown;
			const abort = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* A completed readonly transaction is still rechecked. */ } };
			const onAbort = () => abort(cancelled());
			const timer = window.setTimeout(() => abort(new Error("Saved-buffer inspection timed out")), timeout);
			signal?.addEventListener("abort", onAbort, { once: true });
			const cleanup = () => { window.clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
			tx.oncomplete = () => { cleanup(); try { if (failure !== undefined) throw failure; check(); resolve(count); } catch (error) { reject(error); } };
			tx.onabort = () => { cleanup(); reject(failure ?? tx.error ?? new Error("Unable to inspect saved buffers")); };
			tx.onerror = () => { /* onabort reports the failure */ };
			try {
				check(); if (store.keyPath !== "guid" || store.autoIncrement) throw new Error("The saved-buffer store has an unsupported schema");
				for (const key of keys) {
					const request = store.count(key);
					request.onsuccess = () => { try { check(); if (![0, 1].includes(request.result)) throw new Error("Invalid saved-buffer count"); count += request.result; } catch (error) { abort(error); } };
				}
			} catch (error) { abort(error); }
		});
	}

	async discardUnsaved(guid: string): Promise<void> {
		await this.withStore(
			"readwrite",
			(store) => store.delete(guid),
			"Failed to remove disk buffer",
		);
	}

	/** Compare and delete in one transaction, so a different document/window's
	 * newer buffer cannot be removed by an older merge confirmation. */
	async discardUnsavedIfContents(guid: string, expected: string): Promise<boolean> {
		return this.replaceUnsavedIfContents(guid, expected, null);
	}
	async persistUnsavedIfContents(guid: string, expected: string | null, contents: string): Promise<boolean> {
		return this.replaceUnsavedIfContents(guid, expected, contents);
	}
	private async replaceUnsavedIfContents(guid: string, expected: string | null, contents: string | null): Promise<boolean> {
		const db = await this.database();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(UnsavedFileStore.STORE_NAME, "readwrite"), store = tx.objectStore(UnsavedFileStore.STORE_NAME);
			let matched = false;
			const request = store.get(guid) as IDBRequest<{ contents: string } | undefined>;
			request.onsuccess = () => {
				if (request.result !== undefined && (!request.result || typeof request.result.contents !== "string")) { tx.abort(); return; }
				if ((request.result === undefined ? null : request.result.contents) !== expected) return;
				matched = true;
				if (contents === null) store.delete(guid);
				else store.put({ guid, contents });
			};
			tx.oncomplete = () => resolve(matched);
			tx.onabort = () => reject(tx.error ?? request.error ?? new Error("Failed to remove disk buffer"));
			tx.onerror = () => { /* onabort reports the final transaction outcome */ };
		});
	}
}
