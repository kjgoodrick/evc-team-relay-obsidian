/** Durable, account-isolated local state. No network or Obsidian imports. */
import { pictureIds, prepareLocalPicture, parsePictureRendition, pictureHash, type CachedPicture, type PictureRendition, type PictureVariant, type LocalPicture, type PictureUpload } from "../PictureProtocol";
import { PICTURE_STORES, commandPictures, putPictureSources, setPictureReferences } from "./PictureRecords";
import { isId, isRecord, parseBody, protocolJson, sourceAnchor } from "../DiscussionProtocol";
import { parseLocalDiscussionAnchor, parsePendingBaseGroupCommand, prepareBaseGroupCommand } from "../LocalDiscussionAnchor";
import { parseDiscussionScope } from "../DiscussionScope";
import { INBOX_KEY, parseInboxLocalState, forgetInboxScope, type InboxLocalState } from "./InboxRecords";
import { pictureCacheLimit, validPictureCacheLimit, type DiscussionStorageUsage } from "./CachePolicy";
import { LOCAL_WORK_STORE, captureLocalWork, releaseLocalWork, type LocalWorkSnapshot, type LocalWorkSummary } from "./LocalWorkRecords";
import { localDraftPage, waitingWorkPage, type WaitingCursor } from "./LocalWorkPage";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface StoreIdentity { serverId: string; accountId: string; vaultId: string; shareId: string }
export interface Draft { id: string; scopeId: string; revision: number; body: Json; target?: Json }
export interface QueuedCommand {
	operationId: string;
	scopeId: string;
	type: "thread.create" | "reply.create" | "message.edit" | "reaction.set" | "picture.upload" | "base.group.create";
	payload: Json;
	dependsOn: string[];
}
export interface OutboxOperation extends QueuedCommand {
	state: "queued" | "sending" | "accepted" | "rejected" | "review" | "withdrawn";
	replacementId?: string;
	reviewDraftId?: string;
	createdAt: number;
	attempt: number;
	nextAttemptAt: number;
	lease?: { owner: string; attempt: number; expiresAt: number };
	result?: Json;
	/** Persisted before the first thread send; original capture/body stay immutable. */
	preparedAnchor?: Json;
	error?: string;
}
export interface CachedEntity { id: string; revision: number; value: Json }
export interface ScopeCheckpoint { cursor?: string; generation: number }
export interface PreferenceVerification { token: string; generation: number; previous?: Json }
export interface CachePurge { prefix: string; throughRevision: number }
export interface ReviewedAbandonment { operationId: string; scopeId: string; operations: OutboxOperation[]; drafts: Draft[] }

function ordered(entity: CachedEntity): { collection: string; position: number } {
	const value = entity.value;
	const position = value && typeof value === "object" && !Array.isArray(value) ? value.created_sequence : undefined;
	const removed = value && typeof value === "object" && !Array.isArray(value) && value.removed === true;
	return { collection: entity.id.slice(0, entity.id.lastIndexOf(":") + 1),
		position: removed ? 0 : typeof position === "number" && Number.isSafeInteger(position) && position > 0 ? position : entity.revision };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function completed(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("Local save was aborted"));
		tx.onerror = () => { /* onabort provides the transaction's final failure */ };
	});
}

/** Reject non-JSON values rather than lose them silently during persistence. */
function canonical(value: Json, depth = 0): string {
	if (depth > 32) throw new Error("Local command nesting exceeds limit");
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(v => canonical(v, depth + 1)).join(",") + "]";
	// IndexedDB/another Obsidian window may return a different realm's plain
	// objects. Compare prototype shape, not Object.prototype reference identity.
	if (typeof value === "object" && (Object.getPrototypeOf(value) === null ||
		Object.getPrototypeOf(Object.getPrototypeOf(value)) === null)) {
		return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k], depth + 1)).join(",") + "}";
	}
	throw new Error("Local commands must contain JSON data only");
}

function boundedJson(value: Json): string {
	const result = canonical(value);
	if (result.length > 1024 * 1024) throw new Error("Local command exceeds size limit");
	return result;
}

function requiredId(value: string): void {
	if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error("Missing or invalid identity");
}

const commandTypes = new Set(["thread.create", "reply.create", "message.edit", "reaction.set", "base.group.create"]);

export class DiscussionStore {
	private constructor(private db: IDBDatabase, readonly identity: Readonly<StoreIdentity>) {}

	static async open(identity: StoreIdentity, factory: IDBFactory = indexedDB): Promise<DiscussionStore> {
		const parts = [identity.serverId, identity.accountId, identity.vaultId, identity.shareId];
		parts.forEach(requiredId);
		// Version 23 adds retained recovery captures and fences older cleanup code.
		// Preserve all stores while fencing older workers from rewriting this data.
		const open = factory.open("team-relay-discussions:" + JSON.stringify(parts), 23);
		open.onupgradeneeded = event => {
			const db = open.result;
			if (event.oldVersion < 1) {
				db.createObjectStore("drafts", { keyPath: "id" });
				const outbox = db.createObjectStore("outbox", { keyPath: "operationId" });
				outbox.createIndex("state", "state");
				outbox.createIndex("scope", "scopeId");
				db.createObjectStore("entities", { keyPath: ["scopeId", "id"] });
				db.createObjectStore("cursors");
			}
			if (event.oldVersion < 2) open.transaction!.objectStore("entities").createIndex("scope", "scopeId");
			if (event.oldVersion < 3) db.createObjectStore("generations");
			if (event.oldVersion < 4) {
				db.createObjectStore("preferences");
				open.transaction!.objectStore("outbox").createIndex("scopeState", ["scopeId", "state", "createdAt", "operationId"]);
				const entities = open.transaction!.objectStore("entities");
				entities.createIndex("ordered", ["scopeId", "collection", "position"]);
				const cursor = entities.openCursor();
				cursor.onsuccess = () => {
					const row = cursor.result;
					if (row) { row.update({ ...row.value, ...ordered(row.value as CachedEntity) }); row.continue(); }
				};
			}
			if (event.oldVersion < 5) open.transaction!.objectStore("drafts").createIndex("scopeId", ["scopeId", "id"]);
			if (event.oldVersion < 6) {
				db.createObjectStore("pictureSources", { keyPath: "id" }).createIndex("scope", "scopeId");
				const refs = db.createObjectStore("pictureReferences", { keyPath: ["pictureId", "kind", "ownerId"] });
				refs.createIndex("owner", ["kind", "ownerId"]); refs.createIndex("picture", "pictureId");
			}
			if (event.oldVersion < 7) {
				const cache = db.createObjectStore("pictureCache", { keyPath: ["scopeId", "id", "variant"] });
				cache.createIndex("scope", "scopeId"); cache.createIndex("usedAt", "usedAt");
			}
			if (event.oldVersion < 8) open.transaction!.objectStore("outbox").createIndex("dependency", "dependsOn", { multiEntry: true });
			// Existing previews used a fixed 50 MiB cache. Preserve that budget;
			// newly created databases use the agreed 100 MiB default.
			if (event.oldVersion > 0 && event.oldVersion < 22) open.transaction!.objectStore("preferences").put(50 * 1024 * 1024, "pictureCacheLimit");
			if (event.oldVersion < 23 && !db.objectStoreNames.contains(LOCAL_WORK_STORE)) db.createObjectStore(LOCAL_WORK_STORE);
		};
		const db = await request(open);
		db.onversionchange = () => db.close();
		return new DiscussionStore(db, Object.freeze({ ...identity }));
	}

	close(): void { this.db.close(); }

	async captureLocalWork(id: string, now = Date.now()): Promise<LocalWorkSnapshot> {
		if (!isId(id) || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid recovery capture identity");
		return this.transaction([LOCAL_WORK_STORE, "drafts", "outbox", ...PICTURE_STORES], "readwrite", tx => captureLocalWork(tx, this.identity, id, now));
	}
	async localWorkSummary(): Promise<LocalWorkSummary | undefined> {
		return this.transaction([LOCAL_WORK_STORE], "readonly", tx => request(tx.objectStore(LOCAL_WORK_STORE).get("summary")));
	}
	async localWorkSnapshot(id: string): Promise<LocalWorkSnapshot | undefined> {
		return this.transaction([LOCAL_WORK_STORE], "readonly", async tx => {
			const snapshot: LocalWorkSnapshot | undefined = await request(tx.objectStore(LOCAL_WORK_STORE).get("snapshot"));
			return snapshot?.id === id ? snapshot : undefined;
		});
	}
	async releaseLocalWork(id: string): Promise<boolean> {
		return this.transaction([LOCAL_WORK_STORE, ...PICTURE_STORES], "readwrite", tx => releaseLocalWork(tx, id));
	}

	private async transaction<T>(stores: string[], mode: IDBTransactionMode,
		work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
		const tx = this.db.transaction(stores, mode), done = completed(tx);
		// Attach immediately: a request failure may abort before work's rejection is handled.
		void done.catch(() => undefined);
		try {
			const value = await work(tx);
			await done;
			return value;
		} catch (error) {
			try { tx.abort(); } catch { /* already completed/aborted */ }
			await done.catch(() => undefined);
			throw error;
		}
	}

	async saveDraft(draft: Draft, expectedRevision?: number | null, pictures: LocalPicture[] = [], currentContext: () => boolean = () => true): Promise<void> {
		requiredId(draft.id); requiredId(draft.scopeId); boundedJson(draft.body);
		if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) throw new Error("Invalid draft revision");
		draft = JSON.parse(boundedJson(draft as unknown as Json)) as Draft;
		const ids = pictureIds(draft.body, true);
		if (pictures.length > 10) throw new Error("A comment can contain at most ten pictures");
		const sources = await Promise.all(pictures.map(async source => {
			const { sha256, size } = source, prepared = await prepareLocalPicture(source.id, source.scopeId, source.bytes);
			if (prepared.sha256 !== sha256 || prepared.size !== size) throw new Error("Picture changed before it was saved");
			return prepared;
		}));
		await this.transaction(["drafts", "outbox", ...PICTURE_STORES], "readwrite", async tx => {
			if (!currentContext()) throw new Error("The draft account changed.");
			if (await request(tx.objectStore("preferences").get("online:" + draft.id))) throw new Error("Review the unconfirmed online action before editing this draft");
			const store = tx.objectStore("drafts"), current: Draft | undefined = await request(store.get(draft.id));
			if (current && canonical(current.target ?? null) !== canonical(draft.target ?? null)) throw new Error("Draft target changed; preserve the original draft and start another selection");
			if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) throw new Error("Draft changed in another view");
			if (current && (current.scopeId !== draft.scopeId || current.revision >= draft.revision)) {
				if (canonical(current as unknown as Json) === canonical(draft as unknown as Json)) return;
				throw new Error("Draft changed in another view");
			}
			await request(store.put(draft));
			await setPictureReferences(tx, "draft", draft.id, draft.scopeId, ids);
			await putPictureSources(tx, sources, draft.scopeId, ids);
			if (!currentContext()) throw new Error("The draft account changed.");
		});
	}

	async pictureSource(id: string, scopeId: string): Promise<LocalPicture | undefined> {
		return this.transaction(["pictureSources"], "readonly", async tx => {
			const source: LocalPicture | undefined = await request(tx.objectStore("pictureSources").get(id));
			return source?.scopeId === scopeId ? source : undefined;
		});
	}

	async cachedPicture(scopeId: string, id: string, variant: PictureVariant): Promise<CachedPicture | undefined> {
		return this.transaction(["pictureCache"], "readwrite", async tx => {
			const cache = tx.objectStore("pictureCache"), row: CachedPicture | undefined = await request(cache.get([scopeId, id, variant]));
			if (row) { row.usedAt = Date.now(); await request(cache.put(row)); }
			return row;
		});
	}
	async pictureCacheEpoch(): Promise<number> {
		return (await this.pictureCachePolicy()).epoch;
	}
	async pictureCachePolicy(): Promise<{ epoch: number; limit: number }> {
		return this.transaction(["preferences"], "readonly", async tx => {
			const preferences = tx.objectStore("preferences"), value = await request(preferences.get("pictureCacheEpoch"));
			return { epoch: typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0,
				limit: pictureCacheLimit(await request(preferences.get("pictureCacheLimit"))) };
		});
	}
	/** Counts and byte ledgers avoid cloning picture blobs merely to display usage. */
	async storageUsage(): Promise<DiscussionStorageUsage> {
		return this.transaction(["drafts", "outbox", "entities", "pictureCache", "pictureSources", "preferences"], "readonly", async tx => {
			const states = tx.objectStore("outbox").index("state"), preferences = tx.objectStore("preferences");
			return { drafts: await request(tx.objectStore("drafts").count()), queued: await request(states.count("queued")),
				sending: await request(states.count("sending")), rejected: await request(states.count("rejected")), review: await request(states.count("review")),
				cachedRecords: await request(tx.objectStore("entities").count()), cachedPictures: await request(tx.objectStore("pictureCache").count()),
				cachedPictureBytes: await request(preferences.get("pictureCacheBytes")) ?? 0, pictureCacheLimit: pictureCacheLimit(await request(preferences.get("pictureCacheLimit"))),
				savedPictures: await request(tx.objectStore("pictureSources").count()), savedPictureBytes: await request(preferences.get("pictureSourceBytes")) ?? 0 };
		});
	}
	async setPictureCacheLimit(limit: number): Promise<void> {
		if (!validPictureCacheLimit(limit)) throw new Error("Choose a picture cache limit from 0 to 500 MiB.");
		await this.transaction(["pictureCache", "preferences"], "readwrite", async tx => {
			const cache = tx.objectStore("pictureCache"), preferences = tx.objectStore("preferences");
			let total: number = await request(preferences.get("pictureCacheBytes")) ?? 0;
			while (total > limit) {
				const oldest = await request(cache.index("usedAt").openCursor());
				if (!oldest) throw new Error("Picture cache accounting is inconsistent");
				total -= (oldest.value as CachedPicture).rendition.size; await request(oldest.delete());
			}
			await request(preferences.put(limit, "pictureCacheLimit")); await request(preferences.put(total, "pictureCacheBytes"));
			await request(preferences.put((await request(preferences.get("pictureCacheEpoch")) ?? 0) + 1, "pictureCacheEpoch"));
		});
	}
	/** Account/share-local downloaded bytes only. A global picture epoch also
	 * fences downloads for scopes that have not previously populated this cache. */
	async clearDownloadedPictures(): Promise<void> {
		await this.transaction(["pictureCache", "preferences"], "readwrite", async tx => {
			await request(tx.objectStore("pictureCache").clear());
			const preferences = tx.objectStore("preferences");
			await request(preferences.put(0, "pictureCacheBytes"));
			await request(preferences.put((await request(preferences.get("pictureCacheEpoch")) ?? 0) + 1, "pictureCacheEpoch"));
		});
	}
	/** Downloaded renditions are disposable LRU data, never original draft bytes.
	 * Generation fencing prevents an in-flight download repopulating a revoked scope.
	 */
	async cachePicture(scopeId: string, id: string, variant: PictureVariant, rendition: PictureRendition, bytes: ArrayBuffer, generation: number, cacheEpoch = 0): Promise<boolean> {
		const safe = parsePictureRendition(rendition, variant === "thumbnail"), copy = bytes.slice(0);
		if (copy.byteLength !== safe.size || await pictureHash(copy) !== safe.sha256) throw new Error("Invalid cached picture");
		return this.transaction(["pictureCache", "preferences", "generations"], "readwrite", async tx => {
			if ((await request(tx.objectStore("generations").get(scopeId)) ?? 0) !== generation) return false;
			const cache = tx.objectStore("pictureCache"), preferences = tx.objectStore("preferences"), key = [scopeId, id, variant];
			if ((await request(preferences.get("pictureCacheEpoch")) ?? 0) !== cacheEpoch) return false;
			const limit = pictureCacheLimit(await request(preferences.get("pictureCacheLimit")));
			if (safe.size > limit) return false;
			const previous: CachedPicture | undefined = await request(cache.get(key));
			let total = (await request(preferences.get("pictureCacheBytes")) ?? 0) - (previous?.rendition.size ?? 0);
			await request(cache.delete(key));
			while (total + safe.size > limit) {
				const oldest = await request(cache.index("usedAt").openCursor());
				if (!oldest) throw new Error("Picture cache accounting is inconsistent");
				total -= (oldest.value as CachedPicture).rendition.size; await request(oldest.delete());
			}
			await request(cache.put({ scopeId, id, variant, rendition: safe, bytes: copy, usedAt: Date.now() }));
			await request(preferences.put(total + safe.size, "pictureCacheBytes")); return true;
		});
	}
	async forgetPicture(scopeId: string, id: string): Promise<void> {
		await this.transaction(["pictureCache", "preferences", "generations"], "readwrite", async tx => {
			const cache = tx.objectStore("pictureCache"), preferences = tx.objectStore("preferences");
			let total: number = await request(preferences.get("pictureCacheBytes")) ?? 0;
			for (const variant of ["content", "thumbnail"]) {
				const key = [scopeId, id, variant], previous: CachedPicture | undefined = await request(cache.get(key));
				if (previous) { total -= previous.rendition.size; await request(cache.delete(key)); }
			}
			await request(preferences.put(total, "pictureCacheBytes"));
			const generations = tx.objectStore("generations");
			await request(generations.put((await request(generations.get(scopeId)) ?? 0) + 1, scopeId));
		});
	}

	localDraftPage(after?: string, limit = 10) {
		return this.transaction(["drafts", "preferences"], "readonly", tx => localDraftPage(tx, after, limit));
	}
	waitingWorkPage(after?: WaitingCursor, limit = 10) {
		return this.transaction(["outbox"], "readonly", tx => waitingWorkPage(tx, after, limit));
	}

	async getDraft(id: string): Promise<Draft | undefined> {
		return this.transaction(["drafts"], "readonly", tx => request(tx.objectStore("drafts").get(id)));
	}
	async selectionDrafts(scopeId: string, after?: string, limit = 25): Promise<{ drafts: Draft[]; hasMore: boolean }> {
		requiredId(scopeId);
		if (!Number.isInteger(limit) || limit < 1 || limit > 100 || after !== undefined && !after.startsWith("selection:" + scopeId + ":")) throw new Error("Invalid draft page");
		return this.transaction(["drafts"], "readonly", async tx => {
			const prefix = "selection:" + scopeId + ":";
			const range = IDBKeyRange.bound([scopeId, after ?? prefix], [scopeId, prefix + "\uffff"], after !== undefined, false);
			const drafts: Draft[] = await request(tx.objectStore("drafts").index("scopeId").getAll(range, limit + 1));
			return { drafts: drafts.slice(0, limit), hasMore: drafts.length > limit };
		});
	}

	async preference(key: string): Promise<Json | undefined> {
		return this.transaction(["preferences"], "readonly", tx => request(tx.objectStore("preferences").get(key)));
	}
	async setPreference(key: string, value: Json): Promise<void> {
		requiredId(key); value = JSON.parse(boundedJson(value)) as Json;
		await this.transaction(["preferences"], "readwrite", async tx => { await request(tx.objectStore("preferences").put(value, key)); });
	}
	async inboxState(): Promise<InboxLocalState> { return parseInboxLocalState(await this.preference(INBOX_KEY)); }
	/** Synchronous work inside one transaction serializes inbox windows/workers. */
	async updateInbox(work: (state: InboxLocalState) => void): Promise<InboxLocalState> {
		return this.transaction(["preferences"], "readwrite", async tx => {
			const prefs = tx.objectStore("preferences"), state = parseInboxLocalState(await request(prefs.get(INBOX_KEY)));
			work(state);
			state.revision++;
			const result = parseInboxLocalState(state);
			await request(prefs.put(JSON.parse(boundedJson(protocolJson(result))), INBOX_KEY));
			return result;
		});
	}
	/** Fence delayed verification responses across windows and remote-cache resets. */
	async beginPreferenceVerification(scopeId: string, key: string, token: string): Promise<PreferenceVerification> {
		requiredId(scopeId); requiredId(key); requiredId(token);
		return this.transaction(["preferences", "generations"], "readwrite", async tx => {
			const preferences = tx.objectStore("preferences");
			const previous: Json | undefined = await request(preferences.get(key));
			const generation: number = await request(tx.objectStore("generations").get(scopeId)) ?? 0;
			await request(preferences.put(token, "verification:" + key));
			return { token, generation, previous };
		});
	}
	async finishPreferenceVerification(scopeId: string, key: string, proof: PreferenceVerification, value: Json, current: () => boolean = () => true): Promise<boolean> {
		requiredId(scopeId); requiredId(key); value = JSON.parse(boundedJson(value)) as Json;
		return this.transaction(["preferences", "generations"], "readwrite", async tx => {
			if (!current()) return false;
			const preferences = tx.objectStore("preferences");
			if (await request(preferences.get("verification:" + key)) !== proof.token ||
				(await request(tx.objectStore("generations").get(scopeId)) ?? 0) !== proof.generation) return false;
			if (!current()) return false;
			await request(preferences.put(value, key));
			if (!current()) throw new Error("Target verification access changed");
			return true;
		});
	}
	/** Retiring a sent draft must not replace a newer choice in another pane. */
	async comparePreference(key: string, expected: Json | undefined, value: Json, live: () => boolean = () => true): Promise<boolean> {
		requiredId(key); const previous = expected === undefined ? undefined : boundedJson(expected);
		value = JSON.parse(boundedJson(value)) as Json;
		return this.transaction(["preferences"], "readwrite", async tx => {
			if (!live()) return false;
			const store = tx.objectStore("preferences"), current: Json | undefined = await request(store.get(key));
			if (!live() || (current === undefined ? undefined : canonical(current)) !== previous) return false;
			await request(store.put(value, key));
			if (!live()) throw new Error("The preference review is no longer active");
			return true;
		});
	}
	async removeDraft(id: string, revision: number, expected?: Draft, current: () => boolean = () => true): Promise<boolean> {
		const reviewed = expected === undefined ? undefined : canonical(expected as unknown as Json);
		return this.transaction(["drafts", ...PICTURE_STORES], "readwrite", async tx => {
			if (await request(tx.objectStore("preferences").get("online:" + id))) throw new Error("Review the unconfirmed online action before removing this draft");
			if (await request(tx.objectStore("preferences").get("recovery:" + id))) throw new Error("Review the saved change and its dependents before removing this draft");
			const drafts = tx.objectStore("drafts"), saved: Draft | undefined = await request(drafts.get(id));
			if (!saved || saved.revision !== revision || reviewed !== undefined && canonical(saved as unknown as Json) !== reviewed) return false;
			if (!current()) throw new Error("Draft review is no longer active");
			await request(drafts.delete(id));
			await setPictureReferences(tx, "draft", id, saved.scopeId, []);
			if (!current()) throw new Error("Draft review is no longer active");
			return true;
		});
	}

	/** A manual online action receipt is not an outbox item: no worker submits it.
	 * Retain its exact identity until response acceptance and draft removal commit.
	 */
	async prepareOnlineDraft(draftId: string, revision: number, operation: { operationId: string; scopeId: string; payload: Json }): Promise<{ operationId: string; scopeId: string; payload: Json }> {
		const saved = JSON.parse(boundedJson(operation as unknown as Json)) as typeof operation;
		return this.transaction(["drafts", "preferences"], "readwrite", async tx => {
			const draft: Draft | undefined = await request(tx.objectStore("drafts").get(draftId));
			if (!draft || draft.scopeId !== saved.scopeId || draft.revision !== revision) throw new Error("Draft changed in another view");
			const preferences = tx.objectStore("preferences"), key = "online:" + draftId;
			const existing = await request(preferences.get(key)) as { operation: typeof saved; revision: number } | undefined;
			if (existing) {
				if (existing.revision !== revision || existing.operation.scopeId !== saved.scopeId || canonical(existing.operation.payload) !== canonical(saved.payload)) {
					throw new Error("Review the unconfirmed online action before changing this draft");
				}
				return existing.operation;
			}
			await request(preferences.put({ operation: saved, revision }, key)); return saved;
		});
	}
	async completeOnlineDraft(draftId: string, revision: number, operationId: string): Promise<void> {
		await this.transaction(["drafts", ...PICTURE_STORES], "readwrite", async tx => {
			const preferences = tx.objectStore("preferences"), key = "online:" + draftId;
			const existing = await request(preferences.get(key)) as { operation: { operationId: string }; revision: number } | undefined;
			if (existing?.operation.operationId !== operationId || existing.revision !== revision) throw new Error("Online action changed");
			const drafts = tx.objectStore("drafts"), draft: Draft | undefined = await request(drafts.get(draftId));
			if (draft?.revision !== revision) throw new Error("Draft changed in another view");
			await request(drafts.delete(draftId)); await request(preferences.delete(key));
			await setPictureReferences(tx, "draft", draftId, draft!.scopeId, []);
		});
	}

	/** Only after authenticated withdrawal: invalidate every stale send/editor
	 * before unlocking the unchanged draft. Never enqueue the online action.
	 */
	async withdrawOnlineDraft(draftId: string, revision: number, operation: { operationId: string; scopeId: string; payload: Json }): Promise<Draft> {
		const expected = boundedJson(operation as unknown as Json);
		return this.transaction(["drafts", "preferences"], "readwrite", async tx => {
			const preferences = tx.objectStore("preferences"), key = "online:" + draftId;
			const existing = await request(preferences.get(key)) as { operation: typeof operation; revision: number } | undefined;
			if (!existing || existing.revision !== revision || canonical(existing.operation as unknown as Json) !== expected) throw new Error("Online action changed in another view");
			const drafts = tx.objectStore("drafts"), draft: Draft | undefined = await request(drafts.get(draftId));
			if (!draft || draft.scopeId !== operation.scopeId || draft.revision !== revision || !Number.isSafeInteger(revision + 1)) throw new Error("Draft changed in another view");
			draft.revision++;
			await request(drafts.put(draft)); await request(preferences.delete(key)); return draft;
		});
	}

	/** Unsent drafts may rotate local picture identities, including offline.
	 * No bytes are uploaded here. Preserve shared originals and the entire draft.
	 */
	async refreshDraftPictures(draftId: string, revision: number, replacements: { oldId: string; newId: string }[]): Promise<Draft> {
		replacements = replacements.map(item => ({ ...item }));
		if (!replacements.length || replacements.length > 100 || !Number.isSafeInteger(revision + 1) ||
			new Set(replacements.map(item => item.oldId)).size !== replacements.length ||
			new Set(replacements.map(item => item.newId)).size !== replacements.length ||
			replacements.some(item => !isId(item.newId))) throw new Error("Invalid picture recovery");
		return this.transaction(["drafts", "outbox", ...PICTURE_STORES], "readwrite", async tx => {
			if (await request(tx.objectStore("preferences").get("online:" + draftId))) throw new Error("Review the unconfirmed online action before editing this draft");
			const drafts = tx.objectStore("drafts"), draft: Draft | undefined = await request(drafts.get(draftId));
			if (!draft || draft.revision !== revision || !isRecord(draft.body) || !Array.isArray(draft.body.pictures)) throw new Error("Draft changed in another view");
			const ids = pictureIds(draft.body, true), sources = tx.objectStore("pictureSources"), outbox = tx.objectStore("outbox");
			for (const { oldId, newId } of replacements) {
				if (!ids.includes(oldId) || ids.includes(newId) || await request(sources.getKey(newId)) || await request(outbox.getKey(newId))) throw new Error("Picture identity was already used");
			}
			const map = new Map(replacements.map(item => [item.oldId, item.newId]));
			const remap = (block: Json): Json => isRecord(block) && block.type === "picture" && map.has(String(block.picture_id)) ? { ...block, picture_id: map.get(String(block.picture_id))! } as Json : block;
			draft.body.pictures = draft.body.pictures.map(remap);
			if (Array.isArray(draft.body.undoPictures)) draft.body.undoPictures = draft.body.undoPictures.map(remap);
			if (isRecord(draft.body.rich) && Array.isArray(draft.body.rich.blocks)) draft.body.rich.blocks = draft.body.rich.blocks.map(remap);
			draft.revision++;
			const nextIds = pictureIds(draft.body, true);
			let transferring = [...nextIds, ...map.keys()];
			await setPictureReferences(tx, "draft", draft.id, draft.scopeId, transferring);
			// At most one original is cloned at a time. Removing each obsolete
			// reference first allows a full quota to rotate unshared bytes in place.
			for (const { oldId, newId } of replacements) {
				const source: LocalPicture | undefined = await request(sources.get(oldId));
				if (!source || source.scopeId !== draft.scopeId || source.bytes.byteLength !== source.size) throw new Error("Saved picture changed during recovery");
				transferring = transferring.filter(id => id !== oldId);
				await setPictureReferences(tx, "draft", draft.id, draft.scopeId, transferring);
				await putPictureSources(tx, [{ ...source, id: newId }], draft.scopeId, nextIds);
			}
			await request(drafts.put(draft)); return draft;
		});
	}

	/** Only queueable user actions are accepted; moderation never enters the outbox. */
	async enqueue(command: QueuedCommand, now = Date.now(), draft?: { id: string; revision: number }): Promise<OutboxOperation> {
		requiredId(command.operationId); requiredId(command.scopeId);
		if (!commandTypes.has(command.type) || !Number.isFinite(now) || command.dependsOn.length > 100 ||
			new Set(command.dependsOn).size !== command.dependsOn.length || command.dependsOn.includes(command.operationId)) {
			throw new Error("Invalid queued command");
		}
		command.dependsOn.forEach(requiredId);
		if (command.type === "reply.create" && command.payload !== null && typeof command.payload === "object" &&
			!Array.isArray(command.payload) && (command.payload.reopen === true || command.payload.expected_state_revision != null)) {
			throw new Error("Send and reopen requires an online command");
		}
		command = JSON.parse(boundedJson(command as unknown as Json)) as QueuedCommand;
		if (command.type === "base.group.create") parsePendingBaseGroupCommand(command);
		return this.transaction(["outbox", "drafts", ...PICTURE_STORES], "readwrite", async tx => {
			const recoveryId = draft ? await request(tx.objectStore("preferences").get("recovery:" + draft.id)) : undefined;
			let original: OutboxOperation | undefined;
			if (recoveryId !== undefined) {
				original = await request(tx.objectStore("outbox").get(recoveryId));
				if (!original || original.state !== "review" || original.reviewDraftId !== draft?.id || original.scopeId !== command.scopeId ||
					original.operationId === command.operationId || !isRecord(original.payload) || !isRecord(command.payload) ||
					original.payload.thread_id !== command.payload.thread_id || original.payload.message_id !== command.payload.message_id ||
					(command.type !== original.type && !(["thread.create", "base.group.create"].includes(command.type) && ["thread.create", "base.group.create"].includes(original.type)))) {
					throw new Error("Recovered command changed identity or scope");
				}
				if (command.dependsOn.some(id => !original!.dependsOn.includes(id) && !commandPictures(command.payload).includes(id))) throw new Error("Recovered command introduced an unrelated dependency");
				// Keep ordering against non-picture predecessors. Pictures removed or
				// refreshed in the review draft must not retain a failed old upload.
				for (const id of original.dependsOn) {
					const dependency: OutboxOperation | undefined = await request(tx.objectStore("outbox").get(id));
					if (!dependency || dependency.scopeId !== command.scopeId) throw new Error("Missing or cross-scope dependency");
					if (dependency.type !== "picture.upload") command.dependsOn = [...new Set([...command.dependsOn, id])];
				}
			}
			const ids = commandPictures(command.payload), uploads = tx.objectStore("outbox");
			for (const id of ids) {
				const source: LocalPicture | undefined = await request(tx.objectStore("pictureSources").get(id));
				const upload: OutboxOperation | undefined = await request(uploads.get(id));
				if (source && source.scopeId !== command.scopeId || upload && (upload.type !== "picture.upload" || upload.scopeId !== command.scopeId)) throw new Error("Picture dependency changed scope or identity");
				if (source && !upload) {
					const payload: PictureUpload = { type: "picture.upload", picture_id: id, sha256: source.sha256, size: source.size };
					await request(uploads.add({ operationId: id, scopeId: command.scopeId, type: "picture.upload", payload, dependsOn: [],
						state: "queued", createdAt: now, attempt: 0, nextAttemptAt: now } satisfies OutboxOperation));
					await setPictureReferences(tx, "outbox", id, command.scopeId, [id]);
				}
				if (source || upload) command.dependsOn = [...new Set([...command.dependsOn, id])];
			}
			if (command.dependsOn.includes(command.operationId) || command.dependsOn.length > 100) throw new Error("Invalid picture dependency");
			const identity = boundedJson(command as unknown as Json);
			const store = tx.objectStore("outbox"), previous: OutboxOperation | undefined = await request(store.get(command.operationId));
			if (previous) {
				const { operationId, scopeId, type, payload, dependsOn } = previous;
				if (identity !== canonical({ operationId, scopeId, type, payload, dependsOn })) throw new Error("Operation ID was already used for another command");
				return previous;
			}
			await setPictureReferences(tx, "outbox", command.operationId, command.scopeId, ids);
			if (draft) {
				if (await request(tx.objectStore("preferences").get("online:" + draft.id))) throw new Error("Review the unconfirmed online action before sending this draft");
				const current: Draft | undefined = await request(tx.objectStore("drafts").get(draft.id));
				if (!current || current.scopeId !== command.scopeId || current.revision !== draft.revision) throw new Error("Draft changed in another view");
				await request(tx.objectStore("drafts").delete(draft.id));
				await setPictureReferences(tx, "draft", draft.id, command.scopeId, []);
			}
			for (const id of command.dependsOn) {
				const dependency: OutboxOperation | undefined = await request(store.get(id));
				if (!dependency || dependency.scopeId !== command.scopeId) throw new Error("Missing or cross-scope dependency");
			}
			const op: OutboxOperation = { ...command, state: "queued", createdAt: now, attempt: 0, nextAttemptAt: now };
			await request(store.add(op));
			if (original && draft) {
				const dependents: OutboxOperation[] = await request(store.index("dependency").getAll(original.operationId, 101));
				if (dependents.length > 100) throw new Error("Too many dependent changes for this review");
				for (const dependent of dependents) {
					if (dependent.state === "accepted" || dependent.state === "withdrawn") continue;
					if (dependent.scopeId !== command.scopeId || (dependent.state !== "review" && (dependent.attempt !== 0 || dependent.state !== "queued")) || dependent.operationId === command.operationId) throw new Error("A dependent change needs separate review");
					dependent.dependsOn = dependent.dependsOn.map(id => id === original!.operationId ? command.operationId : id);
					await request(store.put(dependent));
				}
				original.state = "withdrawn"; original.replacementId = command.operationId;
				await request(store.put(original));
				await request(tx.objectStore("preferences").delete("recovery:" + draft.id));
				await setPictureReferences(tx, "outbox", original.operationId, command.scopeId, []);
				for (const oldId of commandPictures(original.payload).filter(id => !ids.includes(id))) {
					// A removed/refreshed picture must not keep an abandoned upload and
					// its original bytes forever. Shared drafts/commands keep ownership.
					const references = await request(tx.objectStore("pictureReferences").index("picture").getAll(oldId, 101)) as { kind: string; ownerId: string }[];
					const dependencies: OutboxOperation[] = await request(store.index("dependency").getAll(oldId, 101));
					const upload: OutboxOperation | undefined = await request(store.get(oldId));
					if (upload?.type === "picture.upload" && upload.scopeId === command.scopeId && references.length <= 100 && dependencies.length <= 100 &&
						!references.some(ref => ref.kind !== "export" && (ref.kind !== "outbox" || ref.ownerId !== oldId)) &&
						!dependencies.some(op => op.state !== "accepted" && op.state !== "withdrawn")) {
						if (upload.state !== "accepted") { upload.state = "withdrawn"; delete upload.lease; delete upload.error; await request(store.put(upload)); }
						await setPictureReferences(tx, "outbox", oldId, command.scopeId, []);
					}
				}
			}
			return op;
		});
	}

	/** Cancel only a standalone reaction. Never infer nondelivery from a retry or
	 * rejected state; attempted work needs an exact authenticated withdrawal. */
	async retireReaction(original: QueuedCommand, serverWithdrawn = false, current: () => boolean = () => true): Promise<"withdrawn" | "accepted" | "uncertain"> {
		const identity = (op: QueuedCommand) => canonical({ operationId: op.operationId, scopeId: op.scopeId, type: op.type, payload: op.payload, dependsOn: op.dependsOn });
		if (original.type !== "reaction.set") throw new Error("Choose a saved reaction to cancel.");
		const expected = identity(original);
		return this.transaction(["outbox"], "readwrite", async tx => {
			if (!current()) throw new Error("This reaction review is no longer current.");
			const outbox = tx.objectStore("outbox"), saved: OutboxOperation | undefined = await request(outbox.get(original.operationId));
			if (!saved || identity(saved) !== expected || saved.replacementId) throw new Error("The saved reaction changed. Review it again.");
			if (saved.state === "accepted") return "accepted";
			if (saved.state === "withdrawn") return "withdrawn";
			const dependents: OutboxOperation[] = await request(outbox.index("dependency").getAll(saved.operationId, 101));
			if (dependents.length > 100 || dependents.some(op => op.state !== "accepted" && op.state !== "withdrawn")) throw new Error("Other saved work depends on this reaction. Review those changes first.");
			if (!serverWithdrawn && (saved.state !== "queued" || saved.attempt !== 0 || saved.lease)) return "uncertain";
			saved.state = "withdrawn"; delete saved.lease; delete saved.error;
			await request(outbox.put(saved));
			if (!current()) throw new Error("This reaction review is no longer current.");
			return "withdrawn";
		});
	}

	async getOperation(id: string): Promise<OutboxOperation | undefined> {
		return this.transaction(["outbox"], "readonly", tx => request(tx.objectStore("outbox").get(id)));
	}
	/** A reviewed root has already been fenced on the server. Only never-attempted
	 * or independently fenced dependents may be discarded with it. */
	private async abandonmentInTransaction(tx: IDBTransaction, operationId: string): Promise<ReviewedAbandonment> {
		const outbox = tx.objectStore("outbox"), drafts = tx.objectStore("drafts"), preferences = tx.objectStore("preferences");
		const root: OutboxOperation | undefined = await request(outbox.get(operationId));
		if (!root || root.state !== "review") throw new Error("Check delivery and cancel the original send before discarding this change");
		const result: ReviewedAbandonment = { operationId, scopeId: root.scopeId, operations: [], drafts: [] }, queue = [root], seen = new Set<string>(), discovered = new Set([operationId]);
		let reviewSize = 0;
		const account = (value: unknown) => {
			reviewSize += canonical(value as Json).length;
			if (reviewSize > 8 * 1024 * 1024) throw new Error("Saved changes exceed the review limit; review smaller groups first");
		};
		account(root);
		while (queue.length) {
			const operation = queue.shift()!; if (seen.has(operation.operationId)) continue;
			seen.add(operation.operationId);
			if (seen.size > 100) throw new Error("Too many dependent changes; review and discard smaller groups first");
			if (operation.scopeId !== root.scopeId || operation.type === "picture.upload" ||
				(operation.state !== "review" && (operation.state !== "queued" || operation.attempt !== 0 || operation.lease !== undefined))) throw new Error("A dependent change needs its own delivery review before discarding");
			result.operations.push(operation);
			if (operation.state === "review") {
				const draft: Draft | undefined = operation.reviewDraftId ? await request(drafts.get(operation.reviewDraftId)) : undefined;
				if (!draft || draft.scopeId !== root.scopeId || await request(preferences.get("recovery:" + draft.id)) !== operation.operationId ||
					await request(preferences.get("online:" + draft.id))) throw new Error("A recovered draft changed; review its delivery before discarding");
				account(draft); result.drafts.push(draft);
			}
			// Read only active dependents. Terminal receipts can be numerous over
			// time; bound the traversal without cloning an unbounded history.
			const dependents = outbox.index("dependency").openCursor(IDBKeyRange.only(operation.operationId));
			await new Promise<void>((resolve, reject) => {
				dependents.onerror = () => reject(dependents.error);
				dependents.onsuccess = () => {
					try {
						const cursor = dependents.result; if (!cursor) { resolve(); return; }
						const dependent = cursor.value as OutboxOperation;
						if (dependent.state !== "accepted" && dependent.state !== "withdrawn" && !discovered.has(dependent.operationId)) {
							account(dependent); discovered.add(dependent.operationId); queue.push(dependent);
						}
						if (discovered.size > 100) throw new Error("Too many dependent changes; review smaller groups first");
						cursor.continue();
					} catch (error) { reject(error); }
				};
			});
		}
		result.operations.sort((a, b) => a.operationId.localeCompare(b.operationId)); result.drafts.sort((a, b) => a.id.localeCompare(b.id));
		if (canonical(result as unknown as Json).length > 8 * 1024 * 1024) throw new Error("Saved changes exceed the review limit; review smaller groups first");
		return result;
	}
	async reviewAbandonment(operationId: string): Promise<ReviewedAbandonment> {
		requiredId(operationId);
		return this.transaction(["outbox", "drafts", "preferences"], "readonly", tx => this.abandonmentInTransaction(tx, operationId));
	}
	async abandonReviewedWork(review: ReviewedAbandonment, current: () => boolean = () => true): Promise<void> {
		const expected = canonical(review as unknown as Json);
		if (expected.length > 8 * 1024 * 1024) throw new Error("Saved changes exceed the review limit");
		await this.transaction(["outbox", "drafts", ...PICTURE_STORES], "readwrite", async tx => {
			const actual = await this.abandonmentInTransaction(tx, review.operationId);
			if (!current() || canonical(actual as unknown as Json) !== expected) throw new Error("Saved work changed after review. Nothing was discarded; review it again");
			const outbox = tx.objectStore("outbox"), preferences = tx.objectStore("preferences"), pictures = new Set<string>();
			for (const draft of actual.drafts) {
				for (const id of pictureIds(draft.body, true)) pictures.add(id);
				await request(tx.objectStore("drafts").delete(draft.id)); await request(preferences.delete("recovery:" + draft.id));
				await setPictureReferences(tx, "draft", draft.id, actual.scopeId, []);
			}
			for (const operation of actual.operations) {
				for (const id of commandPictures(operation.payload)) pictures.add(id);
				operation.state = "withdrawn"; delete operation.reviewDraftId; delete operation.lease; delete operation.error;
				await request(outbox.put(operation)); await setPictureReferences(tx, "outbox", operation.operationId, actual.scopeId, []);
			}
			for (const id of pictures) {
				const upload: OutboxOperation | undefined = await request(outbox.get(id));
				if (!upload || upload.type !== "picture.upload" || upload.scopeId !== actual.scopeId) continue;
				const refs = await request(tx.objectStore("pictureReferences").index("picture").getAll(id, 101)) as { kind: string; ownerId: string }[];
				const dependents: OutboxOperation[] = await request(outbox.index("dependency").getAll(id, 101));
				if (refs.length > 100 || dependents.length > 100 || refs.some(ref => ref.kind !== "export" && (ref.kind !== "outbox" || ref.ownerId !== id)) ||
					dependents.some(op => op.state !== "accepted" && op.state !== "withdrawn")) continue;
				if (upload.state !== "accepted") { upload.state = "withdrawn"; delete upload.lease; delete upload.error; await request(outbox.put(upload)); }
				await setPictureReferences(tx, "outbox", id, actual.scopeId, []);
			}
			if (!current()) throw new Error("The review window changed. Nothing was discarded");
		});
	}

	/** Call only after server withdrawal of the exact wire command. An unprepared
	 * group is the exception: the lease-CAS check below proves it was never sent.
	 * The original payload stays immutable; no worker sends the review draft.
	 */
	async restoreCommandForReview(original: OutboxOperation, body: Json, onlyUnpreparedGroup = false): Promise<Draft> {
		original = JSON.parse(boundedJson(original as unknown as Json)) as OutboxOperation;
		body = JSON.parse(boundedJson(body)) as Json;
		if (!["thread.create", "base.group.create", "reply.create", "message.edit"].includes(original.type) ||
			!isRecord(original.payload) || !isRecord(body) || canonical(protocolJson(parseBody(original.payload.body))) !== canonical(protocolJson(parseBody(body.rich)))) throw new Error("Invalid recovered draft");
		const draftId = "recovery:" + original.operationId;
		return this.transaction(["outbox", "drafts", ...PICTURE_STORES], "readwrite", async tx => {
			const outbox = tx.objectStore("outbox"), drafts = tx.objectStore("drafts"), preferences = tx.objectStore("preferences");
			const current: OutboxOperation | undefined = await request(outbox.get(original.operationId));
			if (!current || current.scopeId !== original.scopeId || current.type !== original.type || canonical(current.payload) !== canonical(original.payload)) throw new Error("Saved command changed during recovery");
			if (current.state === "review" && current.reviewDraftId === draftId) {
				const saved: Draft | undefined = await request(drafts.get(draftId));
				if (!saved || saved.scopeId !== current.scopeId || await request(preferences.get("recovery:" + draftId)) !== current.operationId) throw new Error("Recovered draft is unavailable");
				return saved;
			}
			if (current.state === "accepted" || current.state === "withdrawn" || current.state === "review") throw new Error("Saved command was already completed");
			if (onlyUnpreparedGroup) {
				if (current.type !== "base.group.create" || current.preparedAnchor !== undefined) throw new Error("Group capture advanced; check delivery before recovery");
			} else if (canonical(current.preparedAnchor ?? null) !== canonical(original.preparedAnchor ?? null)) throw new Error("Group capture changed during recovery");
			if (await request(drafts.get(draftId)) || await request(preferences.get("recovery:" + draftId))) throw new Error("Recovery identity was already used");
			const payload = current.payload as Record<string, Json>;
			const draft: Draft = { id: draftId, scopeId: current.scopeId, revision: 0, body,
				...(payload.anchor !== undefined ? { target: payload.anchor } : {}) };
			await request(drafts.add(draft));
			await setPictureReferences(tx, "draft", draftId, current.scopeId, pictureIds(body, true));
			await request(preferences.put(current.operationId, "recovery:" + draftId));
			current.state = "review"; current.reviewDraftId = draftId; delete current.lease;
			await request(outbox.put(current));
			return draft;
		});
	}
	/** Ordinary selection drafts are immutable. Only a withdrawn creation under
	 * explicit review may replace its target, preserving its body and identities. */
	async retargetRecoveredDraft(id: string, revision: number, target: Json): Promise<Draft> {
		const anchor = parseLocalDiscussionAnchor(target), safe = JSON.parse(boundedJson(protocolJson(anchor))) as Json;
		return this.transaction(["drafts", "outbox", "preferences"], "readwrite", async tx => {
			const drafts = tx.objectStore("drafts"), draft: Draft | undefined = await request(drafts.get(id));
			if (!draft || draft.revision !== revision || !Number.isSafeInteger(revision + 1)) throw new Error("Draft changed in another view");
			const operationId = await request(tx.objectStore("preferences").get("recovery:" + id));
			const operation: OutboxOperation | undefined = operationId ? await request(tx.objectStore("outbox").get(operationId)) : undefined;
			if (!operation || operation.state !== "review" || operation.reviewDraftId !== id || operation.scopeId !== draft.scopeId ||
				!["thread.create", "base.group.create"].includes(operation.type) || !isRecord(operation.payload)) throw new Error("Only a recovered new discussion can change target");
			const scope = parseDiscussionScope(draft.scopeId), source = anchor.type === "base_group_pending" ? undefined : sourceAnchor(anchor);
			const imageFile = isRecord(operation.payload.anchor) && operation.payload.anchor.type === "image_file";
			if (!scope || (anchor.type === "base" || anchor.type === "base_group_pending") !== !!scope.viewId ||
				(anchor.type === "base" && anchor.view_id !== scope.viewId) ||
				(anchor.type === "base_group_pending" && (anchor.capture.view_id !== scope.viewId || anchor.entry_id !== scope.entryId)) ||
				(source && source.document_id !== scope.entryId) || (anchor.type === "image_file") !== imageFile ||
				(anchor.type === "image_file" && anchor.asset.entry_id !== scope.entryId)) throw new Error("Choose a target in the same note or saved view");
			const updated = { ...draft, revision: revision + 1, target: safe }; boundedJson(updated as unknown as Json);
			await request(drafts.put(updated)); return updated;
		});
	}

	/** Atomically replace pictures after the server has fenced the original request. */
	async replacePicturesAfterWithdrawal(original: QueuedCommand, replacementId: string,
		replacements: { oldId: string; newId: string }[], now = Date.now(), onlyUnpreparedGroup = false): Promise<string> {
		// Call only after an authenticated withdrawal. Never change a submitted
		// payload; keep the original as a tombstone and create a separate request.
		requiredId(replacementId);
		original = JSON.parse(boundedJson(original as unknown as Json)) as QueuedCommand;
		if (!commandTypes.has(original.type) || original.type === "reaction.set" || !isRecord(original.payload) ||
			!Number.isFinite(now) || !replacements.length || replacements.length > 10) throw new Error("Invalid picture recovery");
		const body = parseBody(original.payload.body), ids = commandPictures(original.payload);
		const prepared = replacements.map(({ oldId, newId }) => {
			requiredId(newId);
			if (!isId(newId) || !ids.includes(oldId) || ids.includes(newId)) throw new Error("Invalid replacement picture identity");
			return { oldId, newId };
		});
		if (new Set(prepared.map(item => item.oldId)).size !== prepared.length || new Set(prepared.map(item => item.newId)).size !== prepared.length) throw new Error("Duplicate replacement picture");
		return this.transaction(["outbox", ...PICTURE_STORES], "readwrite", async tx => {
			const outbox = tx.objectStore("outbox"), sources = tx.objectStore("pictureSources");
			const previous: OutboxOperation | undefined = await request(outbox.get(original.operationId));
			if (!previous || previous.scopeId !== original.scopeId || previous.type !== original.type || canonical(previous.payload) !== canonical(original.payload)) throw new Error("Saved command changed during recovery");
			if (previous.state === "withdrawn" && previous.replacementId) return previous.replacementId;
			if (previous.state === "accepted" || previous.state === "withdrawn" || previous.state === "review") throw new Error("Saved command was already completed or is being reviewed");
			// An unprepared local group intent cannot have sent a thread. Fence it
			// in this same transaction; a concurrent capture cannot prepare afterward.
			if (onlyUnpreparedGroup && (previous.type !== "base.group.create" || previous.preparedAnchor !== undefined)) throw new Error("Group capture advanced during recovery; retry after checking delivery");
			if (await request(outbox.get(replacementId))) throw new Error("Replacement identity was already used");
			const map = new Map(prepared.map(item => [item.oldId, item.newId]));
			for (const { newId } of prepared) {
				if (await request(sources.getKey(newId)) || await request(outbox.get(newId))) throw new Error("Picture identity was already used");
			}
			const dependents: OutboxOperation[] = await request(outbox.index("dependency").getAll(original.operationId));
			for (const dependent of dependents) {
				if (dependent.state === "accepted" || dependent.state === "withdrawn") continue;
				if (dependent.scopeId !== original.scopeId || dependent.attempt !== 0 || dependent.state !== "queued") throw new Error("A dependent change needs separate review");
				dependent.dependsOn = dependent.dependsOn.map(id => id === original.operationId ? replacementId : id);
				await request(outbox.put(dependent));
			}
			const payload = { ...original.payload as Record<string, Json>, body: protocolJson({ ...body, blocks: body.blocks.map(block =>
				block.type === "picture" && map.has(block.picture_id) ? { ...block, picture_id: map.get(block.picture_id)! } : block) }) };
			const nextIds = commandPictures(payload);
			const next: OutboxOperation = { operationId: replacementId, scopeId: original.scopeId, type: original.type,
				payload, dependsOn: [...new Set([...previous.dependsOn.map(id => map.get(id) ?? id), ...map.values()])],
				state: "queued", createdAt: now, attempt: 0, nextAttemptAt: now };
			if (next.dependsOn.length > 100 || next.dependsOn.includes(replacementId)) throw new Error("Invalid replacement dependency");
			previous.state = "withdrawn"; previous.replacementId = replacementId; delete previous.lease; delete previous.error;
			await request(outbox.put(previous)); await request(outbox.add(next));
			// Temporary references retain old blobs until each is transferred. Read
			// one original at a time, rather than cloning the 100 MiB pool in RAM.
			let transferring = [...nextIds, ...map.keys()];
			await setPictureReferences(tx, "outbox", replacementId, original.scopeId, transferring);
			await setPictureReferences(tx, "outbox", original.operationId, original.scopeId, []);
			for (const { oldId } of prepared) {
				const refs = await request(tx.objectStore("pictureReferences").index("picture").getAll(oldId)) as { kind: string; ownerId: string }[];
				const dependencies: OutboxOperation[] = await request(outbox.index("dependency").getAll(oldId));
				const upload: OutboxOperation | undefined = await request(outbox.get(oldId));
				if (upload?.type === "picture.upload" && upload.scopeId === original.scopeId &&
					!refs.some(ref => ref.kind !== "export" && (ref.kind !== "outbox" || ![oldId, replacementId].includes(ref.ownerId))) &&
					!dependencies.some(op => op.state !== "accepted" && op.state !== "withdrawn")) {
					if (upload.state !== "accepted") { upload.state = "withdrawn"; delete upload.lease; delete upload.error; await request(outbox.put(upload)); }
					await setPictureReferences(tx, "outbox", oldId, original.scopeId, []);
				}
			}
			for (const { oldId, newId } of prepared) {
				const saved: LocalPicture | undefined = await request(sources.get(oldId));
				if (!saved || saved.scopeId !== original.scopeId || saved.bytes.byteLength !== saved.size) throw new Error("Saved picture changed during recovery");
				const source = { ...saved, id: newId };
				transferring = transferring.filter(id => id !== oldId);
				await setPictureReferences(tx, "outbox", replacementId, original.scopeId, transferring);
				await putPictureSources(tx, [source], original.scopeId, nextIds);
				const upload: OutboxOperation = { operationId: source.id, scopeId: original.scopeId, type: "picture.upload",
					payload: { type: "picture.upload", picture_id: source.id, sha256: source.sha256, size: source.size }, dependsOn: [],
					state: "queued", createdAt: now, attempt: 0, nextAttemptAt: now };
				await request(outbox.add(upload)); await setPictureReferences(tx, "outbox", source.id, original.scopeId, [source.id]);
			}
			return replacementId;
		});
	}

	/** Explicit retry preserves every immutable field and checks the latest attempt. */
	async retryRejected(operationId: string, scopeId: string, attempt: number, now = Date.now()): Promise<boolean> {
		requiredId(operationId); requiredId(scopeId);
		if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isFinite(now)) throw new Error("Invalid retry");
		return this.transaction(["outbox"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
			if (!op || op.scopeId !== scopeId || op.state !== "rejected" || op.attempt !== attempt) return false;
			op.state = "queued"; op.nextAttemptAt = now; delete op.error; delete op.lease;
			await request(store.put(op)); return true;
		});
	}

	/** Pending/rejected local work only; accepted history does not grow this view. */
	async pending(scopeId: string, limit = 100): Promise<OutboxOperation[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid pending page");
		return this.transaction(["outbox"], "readonly", async tx => {
			const index = tx.objectStore("outbox").index("scopeState"), result: OutboxOperation[] = [];
			for (const state of ["queued", "sending", "rejected", "review"]) {
				const range = IDBKeyRange.bound([scopeId, state], [scopeId, state, []]);
				result.push(...await request(index.getAll(range, limit)) as OutboxOperation[]);
			}
			return result.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId)).slice(0, limit);
		});
	}

	/** Earliest runnable retry/lease; rejected dependencies do not cause polling. */
	async nextWakeAt(picturesNotBefore = 0): Promise<number | undefined> {
		if (!Number.isFinite(picturesNotBefore) || picturesNotBefore < 0) throw new Error("Invalid picture retry time");
		return this.transaction(["outbox"], "readonly", async tx => {
			const store = tx.objectStore("outbox"), states = store.index("state");
			const ops: OutboxOperation[] = [...await request(states.getAll("queued")), ...await request(states.getAll("sending"))];
			let earliest: number | undefined;
			for (const op of ops) {
				let ready = true;
				for (const id of op.dependsOn) {
					const dependency: OutboxOperation | undefined = await request(store.get(id));
					if (dependency?.state !== "accepted") { ready = false; break; }
				}
				if (!ready) continue;
				let due = op.state === "sending" ? op.lease?.expiresAt : op.nextAttemptAt;
				if (due !== undefined && op.type === "picture.upload") due = Math.max(due, picturesNotBefore);
				if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
			}
			return earliest;
		});
	}

	/** Remote authorization loss clears cached content, never pending local text. */
	async clearRemoteScope(scopeId: string, expected?: ScopeCheckpoint): Promise<boolean> {
		return this.transaction(["entities", "cursors", "generations", "preferences", "pictureCache"], "readwrite", async tx => {
			const generations = tx.objectStore("generations");
			const generation: number = await request(generations.get(scopeId)) ?? 0;
			if (expected && (generation !== expected.generation ||
				await request(tx.objectStore("cursors").get(scopeId)) !== expected.cursor)) return false;
			const store = tx.objectStore("entities");
			for (const key of await request(store.index("scope").getAllKeys(scopeId))) await request(store.delete(key));
			await request(tx.objectStore("cursors").delete(scopeId));
			await request(tx.objectStore("preferences").delete("permission:" + scopeId));
			await request(tx.objectStore("preferences").delete("people:" + scopeId));
			await request(tx.objectStore("preferences").delete("documentGeneration:" + scopeId));
			await request(tx.objectStore("preferences").delete("timelineMarkers:" + scopeId));
			const inbox = await request(tx.objectStore("preferences").get(INBOX_KEY));
			if (inbox !== undefined) {
				try {
					const state = parseInboxLocalState(inbox); forgetInboxScope(state, scopeId); state.revision++;
					await request(tx.objectStore("preferences").put(state, INBOX_KEY));
				} catch {
					await request(tx.objectStore("preferences").put(inbox, "inbox:recovery"));
					await request(tx.objectStore("preferences").delete(INBOX_KEY));
				}
			}
			const cache = tx.objectStore("pictureCache");
			let cachedBytes: number = await request(tx.objectStore("preferences").get("pictureCacheBytes")) ?? 0;
			for (const key of await request(cache.index("scope").getAllKeys(scopeId))) {
				cachedBytes -= (await request(cache.get(key)) as CachedPicture).rendition.size; await request(cache.delete(key));
			}
			await request(tx.objectStore("preferences").put(cachedBytes, "pictureCacheBytes"));
			await request(generations.put(generation + 1, scopeId));
			return true;
		});
	}

	/** Explicit local account cleanup; callers must stop workers first. */
	async clearAll(): Promise<void> {
		await this.transaction([LOCAL_WORK_STORE, "drafts", "outbox", "entities", "cursors", "generations", "pictureCache", "preferences", ...PICTURE_STORES], "readwrite", async tx => {
			for (const name of [LOCAL_WORK_STORE, "drafts", "outbox", "entities", "cursors", "generations", "pictureCache", ...PICTURE_STORES]) await request(tx.objectStore(name).clear());
			await request(tx.objectStore("preferences").delete(INBOX_KEY));
			await request(tx.objectStore("preferences").delete("inbox:recovery"));
		});
	}

	/** Read/write transactions serialize claims even across two plugin windows. */
	async claimNext(owner: string, now = Date.now(), leaseMs = 30_000, picturesNotBefore = 0): Promise<OutboxOperation | undefined> {
		requiredId(owner);
		if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 300_000 || !Number.isFinite(picturesNotBefore) || picturesNotBefore < 0) throw new Error("Invalid lease");
		return this.transaction(["outbox"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), states = store.index("state");
			const queued: OutboxOperation[] = await request(states.getAll("queued"));
			const sending: OutboxOperation[] = await request(states.getAll("sending"));
			const eligible = [...queued.filter(op => op.nextAttemptAt <= now),
				...sending.filter(op => op.lease && op.lease.expiresAt <= now)]
				.filter(op => op.type !== "picture.upload" || now >= picturesNotBefore)
				.sort((a, b) => Number(a.type === "picture.upload") - Number(b.type === "picture.upload") || a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
			for (const op of eligible) {
				let ready = true;
				for (const id of op.dependsOn) {
					const dependency: OutboxOperation | undefined = await request(store.get(id));
					if (!dependency || dependency.state !== "accepted") { ready = false; break; }
				}
				if (!ready) continue;
				op.attempt++; op.state = "sending";
				op.lease = { owner, attempt: op.attempt, expiresAt: now + (op.type === "picture.upload" ? Math.max(leaseMs, 120_000) : leaseMs) };
				await request(store.put(op)); return op;
			}
			return undefined;
		});
	}

	/** Lease CAS separates capture from delivery. A stopped/expired worker cannot
	 * prepare or resume a comment after another window has claimed its operation.
	 * The original local target remains available for recovery and explanation. */
	async prepareBaseGroup(operationId: string, lease: { owner: string; attempt: number }, anchor?: Json,
		now = Date.now()): Promise<OutboxOperation | undefined> {
		if (anchor !== undefined) anchor = JSON.parse(boundedJson(anchor)) as Json;
		if (!Number.isFinite(now)) throw new Error("Invalid capture time");
		return this.transaction(["outbox"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
			if (!op || op.type !== "base.group.create" || op.state !== "sending" || op.lease?.owner !== lease.owner ||
				op.lease.attempt !== lease.attempt || op.lease.expiresAt <= now) return undefined;
			parsePendingBaseGroupCommand(op);
			if (op.preparedAnchor !== undefined) {
				prepareBaseGroupCommand(op, op.preparedAnchor);
				if (anchor !== undefined && canonical(anchor) !== canonical(op.preparedAnchor)) throw new Error("Group capture receipt changed");
			} else if (anchor !== undefined) {
				prepareBaseGroupCommand(op, anchor);
				op.preparedAnchor = anchor;
				await request(store.put(op));
			}
			return op;
		});
	}

	async accept(operationId: string, result: Json): Promise<void> {
		boundedJson(result);
		await this.transaction(["outbox", ...PICTURE_STORES], "readwrite", tx => this.acceptInTransaction(tx, operationId, result));
	}

	private async acceptInTransaction(tx: IDBTransaction, operationId: string, result: Json): Promise<void> {
		const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
		if (!op || op.state === "accepted" || op.state === "withdrawn" || op.state === "review") return;
		op.state = "accepted"; op.result = result; delete op.lease; delete op.error;
		await request(store.put(op));
		await setPictureReferences(tx, "outbox", operationId, op.scopeId, []);
	}

	async fail(operationId: string, lease: { owner: string; attempt: number }, error: string,
		retryAt?: number): Promise<void> {
		if (retryAt !== undefined && !Number.isFinite(retryAt)) throw new Error("Invalid retry time");
		await this.transaction(["outbox"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
			if (!op || op.state !== "sending" || op.lease?.owner !== lease.owner || op.lease.attempt !== lease.attempt) return;
			op.state = retryAt === undefined ? "rejected" : "queued";
			op.nextAttemptAt = retryAt ?? op.nextAttemptAt; op.error = error.slice(0, 512); delete op.lease;
			await request(store.put(op));
		});
	}

	async cursor(scopeId: string): Promise<string | undefined> {
		return this.transaction(["cursors"], "readonly", tx => request(tx.objectStore("cursors").get(scopeId)));
	}

	/** A generation fences in-flight reads even when invalidation clears an empty cursor. */
	async checkpoint(scopeId: string): Promise<ScopeCheckpoint> {
		return this.transaction(["cursors", "generations"], "readonly", async tx => ({
			cursor: await request(tx.objectStore("cursors").get(scopeId)),
			generation: await request(tx.objectStore("generations").get(scopeId)) ?? 0,
		}));
	}

	async entity(scopeId: string, id: string): Promise<CachedEntity | undefined> {
		return this.transaction(["entities"], "readonly", tx => request(tx.objectStore("entities").get([scopeId, id])));
	}
	/** Targeted authorized reads do not advance or invent an event cursor. */
	async cacheRemoteRead(scopeId: string, generation: number, rows: CachedEntity[]): Promise<boolean> {
		requiredId(scopeId);
		if (!Number.isSafeInteger(generation) || generation < 0 || rows.length > 100) throw new Error("Invalid remote read");
		const copies = rows.map(row => {
			requiredId(row.id);
			if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error("Invalid remote revision");
			return { ...row, value: JSON.parse(boundedJson(row.value)) as Json };
		});
		return this.transaction(["entities", "generations"], "readwrite", async tx => {
			if ((await request(tx.objectStore("generations").get(scopeId)) ?? 0) !== generation) return false;
			const entities = tx.objectStore("entities");
			for (const row of copies) {
				const old: CachedEntity | undefined = await request(entities.get([scopeId, row.id]));
				if (!old || old.revision < row.revision) await request(entities.put({ ...row, ...ordered(row), scopeId }));
			}
			return true;
		});
	}

	/** Bounded local browsing; a page's absence never implies a remote deletion. */
	async entities(scopeId: string, prefix: string, after = "", limit = 100): Promise<CachedEntity[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (after && !after.startsWith(prefix))) throw new Error("Invalid cache page");
		return this.transaction(["entities"], "readonly", async tx => {
			const range = IDBKeyRange.bound([scopeId, after || prefix], [scopeId, prefix + "\uffff"], !!after, false);
			return request(tx.objectStore("entities").getAll(range, limit));
		});
	}

	async orderedEntities(scopeId: string, collection: string, after = 0, limit = 50): Promise<CachedEntity[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0) throw new Error("Invalid cache page");
		return this.transaction(["entities"], "readonly", tx => request(tx.objectStore("entities").index("ordered").getAll(
			IDBKeyRange.bound([scopeId, collection, after], [scopeId, collection, Number.MAX_SAFE_INTEGER], true), limit)));
	}

	/** Cache, acknowledgments and cursor advance together; stale streams cannot rewind it. */
	async applyRemoteBatch(scopeId: string, expectedCursor: string | undefined, nextCursor: string,
		entities: CachedEntity[], accepted: { operationId: string; result: Json }[] = [], expectedGeneration?: number,
		purges: CachePurge[] = []): Promise<boolean> {
		requiredId(scopeId);
		if (typeof nextCursor !== "string" || nextCursor.length < 1 || nextCursor.length > 2048) throw new Error("Invalid checkpoint cursor");
		if (entities.length > 500 || accepted.length > 500) throw new Error("Event batch exceeds limit");
		for (const entity of entities) {
			requiredId(entity.id); boundedJson(entity.value);
			if (!Number.isSafeInteger(entity.revision) || entity.revision < 1) throw new Error("Invalid entity revision");
		}
		accepted.forEach(ack => boundedJson(ack.result));
		if (purges.length > 100 || purges.some(p => !p.prefix || p.prefix.length > 512 || !Number.isSafeInteger(p.throughRevision) || p.throughRevision < 1)) throw new Error("Invalid cache purge");
		return this.transaction(["entities", "cursors", "outbox", "generations", ...PICTURE_STORES], "readwrite", async tx => {
			const cursors = tx.objectStore("cursors"), store = tx.objectStore("entities");
			if (await request(cursors.get(scopeId)) !== expectedCursor) return false;
			if (expectedGeneration !== undefined && (await request(tx.objectStore("generations").get(scopeId)) ?? 0) !== expectedGeneration) return false;
			for (const entity of entities) {
				const old: CachedEntity | undefined = await request(store.get([scopeId, entity.id]));
				if (!old || old.revision < entity.revision) await request(store.put({ ...entity, ...ordered(entity), scopeId }));
			}
			for (const purge of purges) {
				const range = IDBKeyRange.bound([scopeId, purge.prefix], [scopeId, purge.prefix + "\uffff"]);
				await new Promise<void>((resolve, reject) => {
					const cursor = store.openCursor(range);
					cursor.onerror = () => reject(cursor.error);
					cursor.onsuccess = () => {
						const row = cursor.result;
						if (!row) { resolve(); return; }
						if ((row.value as CachedEntity).revision <= purge.throughRevision) row.delete();
						row.continue();
					};
				});
			}
			for (const ack of accepted) {
				const op: OutboxOperation | undefined = await request(tx.objectStore("outbox").get(ack.operationId));
				if (op && op.scopeId !== scopeId) throw new Error("Cross-scope acknowledgment");
				await this.acceptInTransaction(tx, ack.operationId, ack.result);
			}
			await request(cursors.put(nextCursor, scopeId)); return true;
		});
	}
}
