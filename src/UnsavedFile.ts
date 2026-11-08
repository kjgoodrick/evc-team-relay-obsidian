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
			request.onupgradeneeded = (event) => {
				const db = (event.target as IDBOpenDBRequest).result;
				db.createObjectStore(UnsavedFileStore.STORE_NAME, { keyPath: "guid" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error ?? new Error("Failed to open database"));
		});
	}

	private async database(): Promise<IDBDatabase> {
		if (!this.pendingDatabase) {
			this.pendingDatabase = this.initDatabase();
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
		return result ? result.contents : null;
	}

	async discardUnsaved(guid: string): Promise<void> {
		await this.withStore(
			"readwrite",
			(store) => store.delete(guid),
			"Failed to remove disk buffer",
		);
	}
}
