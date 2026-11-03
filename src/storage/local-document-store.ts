/**
 * Local persistence for a Yjs document, backed by IndexedDB.
 *
 * Written for Team Relay. Two object stores per document database:
 *
 *   `updates`  autoIncrement — one Yjs update per record, appended as the
 *              document changes and periodically collapsed into a single
 *              record so the store does not grow without bound.
 *   `custom`   plain key/value — our own metadata (server-sync flag, origin,
 *              sync base).
 *
 * Store names, the autoIncrement flag and the metadata keys are load-bearing:
 * they address data already written on users' machines. Renaming any of them
 * silently orphans an existing vault, which looks exactly like data loss.
 */

import * as Y from "yjs";
import * as idb from "lib0/indexeddb";
import { ObservableV2 } from "lib0/observable";

const CUSTOM_STORE = "custom";
const UPDATES_STORE = "updates";

/** Metadata keys inside the `custom` store. Values are what is on disk today. */
const KEY_SERVER_SYNC = "serverSync";
const KEY_ORIGIN = "origin";
/** Text this client and the relay last agreed on; see `Document.getSyncBase()`. */
const KEY_SYNC_BASE = "syncBase";

/**
 * Collapse thresholds. The first pass after opening the database tolerates a
 * longer tail: collapsing on startup competes with the very work the user is
 * waiting for. Once the document is live, a much smaller number keeps the
 * store lean.
 */
export const COLD_START_COLLAPSE_AT = 500;
export const LIVE_COLLAPSE_AT = 50;

/**
 * How many records the store may hold before `holdsContent()` calls it real
 * content rather than the handful of records a freshly created document
 * writes on its own.
 */
const METADATA_RECORD_ALLOWANCE = 3;

export type DocumentOrigin = "local" | "remote";

type UpdateStore = IDBObjectStore;

/**
 * Read every stored update into the document, then collapse the store if it
 * has grown past the startup threshold.
 *
 * The callbacks exist so a caller can observe the boundary around applying a
 * batch — for example to suppress its own update handler while replaying
 * history that is already persisted.
 */
export const replayStoredUpdates = (
	persistence: LocalDocumentStore,
	beforeApplyUpdates: () => void = () => undefined,
	afterApplyUpdates: () => void = () => undefined,
): Promise<UpdateStore> => {
	const [updates] = idb.transact(
		/** @type {IDBDatabase} */ persistence.db as IDBDatabase,
		[UPDATES_STORE],
	);
	return idb
		.getAll(updates, idb.createIDBKeyRangeLowerBound(persistence._lastKey, true))
		.then((records) => {
			if (persistence._destroyed) return updates;
			beforeApplyUpdates();
			Y.transact(
				persistence.doc,
				() => {
					for (const record of records) {
						Y.applyUpdate(persistence.doc, record as Uint8Array);
					}
				},
				persistence,
				false,
			);
			afterApplyUpdates();
			return updates;
		})
		.then((store) =>
			idb.getLastKey(store).then((lastKey) => {
				if (typeof lastKey === "number") persistence._lastKey = lastKey;
				return store;
			}),
		)
		.then((store) =>
			idb.count(store).then((count) => {
				persistence._dbsize = count;
				return store;
			}),
		);
};

/**
 * Read one key from the `custom` store given an already-open `IDBDatabase`
 * handle directly -- the raw counterpart of `LocalDocumentStore.get()`, which
 * instead awaits `this._dbref` to obtain that same handle.
 *
 * Callers that already hold `db` (the constructor's own `_dbref` resolution,
 * for instance) MUST use this instead of `get()`: `get()` awaits `_dbref`,
 * and calling it from inside `_dbref`'s own `.then()` callback awaits a
 * promise that cannot settle until that very callback returns -- a
 * deterministic deadlock, not a timing race.
 */
function getFromDb(
	db: IDBDatabase,
	key: string | number | ArrayBuffer | Date,
): Promise<unknown> {
	const [custom] = idb.transact(db, [CUSTOM_STORE], "readonly");
	return idb.get(custom, key);
}

/**
 * Append the document's whole current state as one record, then drop every
 * record that preceded it. Called when the update count crosses a threshold,
 * and unconditionally when `force` is set.
 */
export const collapseStoredHistory = (
	persistence: LocalDocumentStore,
	force = true,
): Promise<void> =>
	replayStoredUpdates(persistence).then((updates) => {
		if (!force && persistence._dbsize < LIVE_COLLAPSE_AT) return;
		return idb
			// lib0 types addAutoKey's value as a key type; IndexedDB stores binary
			// values natively, so the cast stays at this one boundary.
			.addAutoKey(
				updates,
				Y.encodeStateAsUpdate(persistence.doc) as unknown as ArrayBuffer,
			)
			.then((newKey) =>
				idb
					.del(
						updates,
						idb.createIDBKeyRangeUpperBound(newKey, true),
					)
					.then(() => idb.count(updates))
					.then((count) => {
						persistence._dbsize = count;
						if (typeof newKey === "number") persistence._lastKey = newKey;
					}),
			);
	});

/** Remove a document's database entirely. */
export const dropStoredDocument = async (name: string): Promise<void> => {
	await idb.deleteDB(name);
};

type LocalDocumentStoreEvents = {
	synced: (store: LocalDocumentStore) => void;
};

export class LocalDocumentStore extends ObservableV2<LocalDocumentStoreEvents> {
	readonly doc: Y.Doc;
	readonly name: string;

	/** Resolves to the open database; also the value of `db` once ready. */
	readonly _dbref: Promise<IDBDatabase>;
	db: IDBDatabase | null = null;

	/** True once everything already on disk has been applied to the doc. */
	synced = false;
	/** Resolves when `synced` first becomes true. */
	readonly whenSynced: Promise<LocalDocumentStore>;

	_destroyed = false;
	_dbsize = 0;
	_lastKey = 0;
	_serverSynced = false;
	_origin: DocumentOrigin | undefined = undefined;
	/**
	 * In-memory copy of the stored sync base, loaded with the other metadata
	 * and written through by `rememberSyncBase()`. A background pull reads it
	 * right before writing a peer's edit; under a bulk import the IndexedDB
	 * queue held that read for 18-38 s, so it is not read from
	 * disk again once the store is open.
	 */
	private _syncBase: string | undefined = undefined;

	private _trimSize = COLD_START_COLLAPSE_AT;
	/**
	 * State the doc already held when this store attached (the provider seeds
	 * the user mapping before a document opens its store). Yjs integrates a
	 * client's updates only in clock order, so if the first stored update
	 * starts past these clocks, every later local edit stays pending after an
	 * offline restart and the text reads as empty. Written together with the
	 * first update; dropped unwritten if nothing follows it.
	 */
	private _attachState: Uint8Array | null = null;
	private _storeTimeoutId: number | null = null;
	private readonly _storeDebounceMs = 1000;
	private readonly pendingWrites = new Set<Promise<unknown>>();
	private readonly _updateHandler: (update: Uint8Array, origin: unknown) => void;
	private readonly _destroyHandler = (): void => {
		this.destroy();
	};

	constructor(name: string, doc: Y.Doc) {
		super();
		this.doc = doc;
		this.name = name;
		if (doc.store.clients.size > 0) this._attachState = Y.encodeStateAsUpdate(doc);

		this.whenSynced = new Promise((resolve) => {
			this.once("synced", () => resolve(this));
		});

		this._dbref = idb
			.openDB(name, (db) =>
				idb.createStores(db, [
					[UPDATES_STORE, { autoIncrement: true }],
					[CUSTOM_STORE],
				]),
			)
			.then(async (db) => {
				this.db = db;
				await replayStoredUpdates(this);
				// Metadata is read once here so the synchronous accessors
				// (`serverSyncKnown`, `canRender`) have an answer without awaiting.
				//
				// Read via `db` directly, NOT `this.get()` -- `get()` awaits
				// `this._dbref` to obtain the database handle, and we are
				// still INSIDE that same promise's own `.then()` callback.
				// `this._dbref` cannot settle until this callback returns, so
				// awaiting it here awaits a promise that is waiting on this
				// very statement to finish: a deterministic deadlock. Every
				// freshly constructed store hung here forever -- `synced`
				// never became true, `emit("synced")` never fired, and every
				// caller of `awaitSynced()`/`hasPendingUpdates()` (a new
				// share's whole adopt-local-files path) hung with it.
				this._serverSynced = (await getFromDb(db, KEY_SERVER_SYNC)) === 1;
				this._origin = (await getFromDb(db, KEY_ORIGIN)) as
					| DocumentOrigin
					| undefined;
				const syncBase = await getFromDb(db, KEY_SYNC_BASE);
				this._syncBase = typeof syncBase === "string" ? syncBase : undefined;
				if (this._destroyed) return db;
				this._trimSize = LIVE_COLLAPSE_AT;
				this.synced = true;
				this.emit("synced", [this]);
				return db;
			});

		this._updateHandler = (update: Uint8Array, origin: unknown) => {
			// Updates we replayed ourselves are already on disk.
			if (this._destroyed || origin === this) return;
			if (this._attachState) {
				update = Y.mergeUpdates([this._attachState, update]);
				this._attachState = null;
			}
			const pending = this._dbref.then(() => {
				// This update was accepted before close(). Drain it even if teardown
				// began before the database-open promise's microtask ran.
				if (!this.db) return;
				const [updates] = idb.transact(this.db, [UPDATES_STORE]);
				return idb
					.addAutoKey(updates, update as unknown as ArrayBuffer)
					.then((key) => {
						if (typeof key === "number") this._lastKey = key;
						if (++this._dbsize >= this._trimSize && !this._destroyed) this._scheduleCollapse();
					});
			});
			this.pendingWrites.add(pending);
			void pending.then(() => this.pendingWrites.delete(pending), () => { /* close() reports failed persistence */ });
		};
		doc.on("update", this._updateHandler);
		this.close = this.close.bind(this);
		doc.on("destroy", this._destroyHandler);
	}

	/** Collapse soon, not on every crossing — bursts of edits are normal. */
	private _scheduleCollapse(): void {
		if (this._storeTimeoutId !== null) window.clearTimeout(this._storeTimeoutId);
		this._storeTimeoutId = window.setTimeout(() => {
			this._storeTimeoutId = null;
			void collapseStoredHistory(this, false);
		}, this._storeDebounceMs);
	}

	/**
	 * Register a one-shot listener, tolerating an event that already fired.
	 * `whenSynced` and callers that attach late both depend on this: without
	 * it, subscribing after the load finished waits forever.
	 */
	once<NAME extends keyof LocalDocumentStoreEvents>(
		name: NAME,
		f: LocalDocumentStoreEvents[NAME],
	): void {
		if (name === "synced" && this.synced) {
			f(this);
			return;
		}
		super.once(name, f);
	}

	/**
	 * Fire-and-forget teardown, matching the void `destroy()` of the
	 * observable base class. Use `close()` to wait for the database to close.
	 */
	destroy(): void {
		void this.close();
	}

	/** Stop persisting, drop all listeners and close the database. */
	close(): Promise<void> {
		if (this._storeTimeoutId !== null) {
			window.clearTimeout(this._storeTimeoutId);
			this._storeTimeoutId = null;
		}
		this.doc.off("update", this._updateHandler);
		this.doc.off("destroy", this._destroyHandler);
		this._destroyed = true;
		return this._dbref.then(async (db) => {
			if (this.pendingWrites.size) await Promise.all(this.pendingWrites);
			db.close();
			return super.destroy();
		});
	}

	/** Destroy this instance and delete everything it stored. */
	async dropAll(): Promise<void> {
		await this.close();
		await dropStoredDocument(this.name);
	}

	async get(
		key: string | number | ArrayBuffer | Date,
	): Promise<unknown> {
		const db = await this._dbref;
		return getFromDb(db, key);
	}

	async set(
		key: string | number | ArrayBuffer | Date,
		value: string | number | ArrayBuffer | Date,
	): Promise<unknown> {
		const db = await this._dbref;
		const [custom] = idb.transact(db, [CUSTOM_STORE]);
		return idb.put(custom, value, key);
	}

	async del(key: string | number | ArrayBuffer | Date): Promise<void> {
		const db = await this._dbref;
		const [custom] = idb.transact(db, [CUSTOM_STORE]);
		await idb.del(custom, key);
	}

	/**
	 * Whether the store holds actual content rather than just the few records
	 * a new document writes for itself.
	 */
	holdsContent(): boolean {
		return this._dbsize > METADATA_RECORD_ALLOWANCE;
	}

	async rememberServerSync(): Promise<unknown> {
		this._serverSynced = true;
		return this.set(KEY_SERVER_SYNC, 1);
	}

	async loadServerSyncFlag(): Promise<boolean> {
		return (await this.get(KEY_SERVER_SYNC)) === 1;
	}

	/** Synchronous counterpart of `loadServerSyncFlag`, for render paths. */
	get serverSyncKnown(): boolean {
		return this._serverSynced === true;
	}

	async rememberOrigin(origin: DocumentOrigin): Promise<unknown> {
		this._origin = origin;
		return this.set(KEY_ORIGIN, origin);
	}

	/** The stored sync base, served from memory once the store is open. */
	async loadSyncBase(): Promise<string | undefined> {
		await this._dbref;
		return this._syncBase;
	}

	async rememberSyncBase(text: string): Promise<unknown> {
		// After the open, which loads the stored value into `_syncBase`:
		// setting it earlier would be overwritten by that older value.
		await this._dbref;
		this._syncBase = text;
		return this.set(KEY_SYNC_BASE, text);
	}

	async loadOrigin(): Promise<DocumentOrigin | undefined> {
		this._origin = (await this.get(KEY_ORIGIN)) as DocumentOrigin | undefined;
		return this._origin;
	}

	/**
	 * Whether the document can be shown.
	 *
	 * Local storage having loaded is necessary but not sufficient: a document
	 * that came from the server and has never synced would render as empty,
	 * which reads as data loss. So we also require one of — the provider is
	 * synced now, the server synced at some point, or the document was created
	 * here and never had a server copy to wait for.
	 */
	canRender(providerSynced = false): boolean {
		return (
			this.synced &&
			(providerSynced || this.serverSyncKnown || this._origin === "local")
		);
	}

	/** Whether we are still expecting a first payload from the server. */
	async awaitsFirstServerCopy(): Promise<boolean> {
		const serverSynced = await this.loadServerSyncFlag();
		const origin = await this.loadOrigin();
		return !serverSynced && origin !== "local" && !this.holdsContent();
	}
}
