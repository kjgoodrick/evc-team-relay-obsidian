/** Durable, account-isolated local state. No network or Obsidian imports. */
import { pictureIds, prepareLocalPicture, parsePictureRendition, pictureHash, PICTURE_CACHE_QUOTA, type CachedPicture, type PictureRendition, type PictureVariant, type LocalPicture, type PictureUpload } from "../PictureProtocol";
import { PICTURE_STORES, commandPictures, putPictureSources, setPictureReferences } from "./PictureRecords";
import { isId, isRecord, parseBody, protocolJson } from "../DiscussionProtocol";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface StoreIdentity { serverId: string; accountId: string; vaultId: string; shareId: string }
export interface Draft { id: string; scopeId: string; revision: number; body: Json; target?: Json }
export interface QueuedCommand {
	operationId: string;
	scopeId: string;
	type: "thread.create" | "reply.create" | "message.edit" | "reaction.set" | "picture.upload";
	payload: Json;
	dependsOn: string[];
}
export interface OutboxOperation extends QueuedCommand {
	state: "queued" | "sending" | "accepted" | "rejected" | "withdrawn";
	replacementId?: string;
	createdAt: number;
	attempt: number;
	nextAttemptAt: number;
	lease?: { owner: string; attempt: number; expiresAt: number };
	result?: Json;
	error?: string;
}
export interface CachedEntity { id: string; revision: number; value: Json }
export interface ScopeCheckpoint { cursor?: string; generation: number }
export interface CachePurge { prefix: string; throughRevision: number }

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

const commandTypes = new Set(["thread.create", "reply.create", "message.edit", "reaction.set"]);

export class DiscussionStore {
	private constructor(private db: IDBDatabase, readonly identity: Readonly<StoreIdentity>) {}

	static async open(identity: StoreIdentity, factory: IDBFactory = indexedDB): Promise<DiscussionStore> {
		const parts = [identity.serverId, identity.accountId, identity.vaultId, identity.shareId];
		parts.forEach(requiredId);
		const open = factory.open("team-relay-discussions:" + JSON.stringify(parts), 8);
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
		};
		const db = await request(open);
		db.onversionchange = () => db.close();
		return new DiscussionStore(db, Object.freeze({ ...identity }));
	}

	close(): void { this.db.close(); }

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

	async saveDraft(draft: Draft, expectedRevision?: number | null, pictures: LocalPicture[] = []): Promise<void> {
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
	/** Downloaded renditions are disposable LRU data, never original draft bytes.
	 * Generation fencing prevents an in-flight download repopulating a revoked scope.
	 */
	async cachePicture(scopeId: string, id: string, variant: PictureVariant, rendition: PictureRendition, bytes: ArrayBuffer, generation: number): Promise<boolean> {
		const safe = parsePictureRendition(rendition, variant === "thumbnail"), copy = bytes.slice(0);
		if (copy.byteLength !== safe.size || await pictureHash(copy) !== safe.sha256) throw new Error("Invalid cached picture");
		return this.transaction(["pictureCache", "preferences", "generations"], "readwrite", async tx => {
			if ((await request(tx.objectStore("generations").get(scopeId)) ?? 0) !== generation) return false;
			const cache = tx.objectStore("pictureCache"), preferences = tx.objectStore("preferences"), key = [scopeId, id, variant];
			const previous: CachedPicture | undefined = await request(cache.get(key));
			let total = (await request(preferences.get("pictureCacheBytes")) ?? 0) - (previous?.rendition.size ?? 0);
			await request(cache.delete(key));
			while (total + safe.size > PICTURE_CACHE_QUOTA) {
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
	/** Retiring a sent draft must not replace a newer choice in another pane. */
	async comparePreference(key: string, expected: Json | undefined, value: Json): Promise<boolean> {
		requiredId(key); const previous = expected === undefined ? undefined : boundedJson(expected);
		value = JSON.parse(boundedJson(value)) as Json;
		return this.transaction(["preferences"], "readwrite", async tx => {
			const store = tx.objectStore("preferences"), current: Json | undefined = await request(store.get(key));
			if ((current === undefined ? undefined : canonical(current)) !== previous) return false;
			await request(store.put(value, key)); return true;
		});
	}
	async removeDraft(id: string, revision: number): Promise<boolean> {
		return this.transaction(["drafts", ...PICTURE_STORES], "readwrite", async tx => {
			if (await request(tx.objectStore("preferences").get("online:" + id))) throw new Error("Review the unconfirmed online action before removing this draft");
			const drafts = tx.objectStore("drafts"), current: Draft | undefined = await request(drafts.get(id));
			if (!current || current.revision !== revision) return false;
			await request(drafts.delete(id));
			await setPictureReferences(tx, "draft", id, current.scopeId, []); return true;
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
		if (!replacements.length || replacements.length > 10 || !Number.isSafeInteger(revision + 1) ||
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
			draft.body.pictures = draft.body.pictures.map(block => isRecord(block) && map.has(String(block.picture_id)) ? { ...block, picture_id: map.get(String(block.picture_id))! } : block);
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
		return this.transaction(["outbox", "drafts", ...PICTURE_STORES], "readwrite", async tx => {
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
			return op;
		});
	}

	async getOperation(id: string): Promise<OutboxOperation | undefined> {
		return this.transaction(["outbox"], "readonly", tx => request(tx.objectStore("outbox").get(id)));
	}

	/** Atomically replace pictures after the server has fenced the original request. */
	async replacePicturesAfterWithdrawal(original: QueuedCommand, replacementId: string,
		replacements: { oldId: string; newId: string }[], now = Date.now()): Promise<string> {
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
			if (previous.state === "accepted" || previous.state === "withdrawn") throw new Error("Saved command was already completed");
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
					!refs.some(ref => ref.kind !== "outbox" || ![oldId, replacementId].includes(ref.ownerId)) &&
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
			for (const state of ["queued", "sending", "rejected"]) {
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
		await this.transaction(["drafts", "outbox", "entities", "cursors", "generations", "pictureCache", ...PICTURE_STORES], "readwrite", async tx => {
			for (const name of ["drafts", "outbox", "entities", "cursors", "generations", "pictureCache", ...PICTURE_STORES]) await request(tx.objectStore(name).clear());
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

	async accept(operationId: string, result: Json): Promise<void> {
		boundedJson(result);
		await this.transaction(["outbox", ...PICTURE_STORES], "readwrite", tx => this.acceptInTransaction(tx, operationId, result));
	}

	private async acceptInTransaction(tx: IDBTransaction, operationId: string, result: Json): Promise<void> {
		const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
		if (!op || op.state === "accepted" || op.state === "withdrawn") return;
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
