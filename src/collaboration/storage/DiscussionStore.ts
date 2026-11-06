/** Durable, account-isolated local state. No network or Obsidian imports. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface StoreIdentity { serverId: string; accountId: string; vaultId: string; shareId: string }
export interface Draft { id: string; scopeId: string; revision: number; body: Json }
export interface QueuedCommand {
	operationId: string;
	scopeId: string;
	type: "thread.create" | "reply.create" | "message.edit" | "reaction.set";
	payload: Json;
	dependsOn: string[];
}
export interface OutboxOperation extends QueuedCommand {
	state: "queued" | "sending" | "accepted" | "rejected";
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
		const open = factory.open("team-relay-discussions:" + JSON.stringify(parts), 4);
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

	async saveDraft(draft: Draft, expectedRevision?: number | null): Promise<void> {
		requiredId(draft.id); requiredId(draft.scopeId); boundedJson(draft.body);
		if (!Number.isSafeInteger(draft.revision) || draft.revision < 0) throw new Error("Invalid draft revision");
		draft = JSON.parse(boundedJson(draft as unknown as Json)) as Draft;
		await this.transaction(["drafts"], "readwrite", async tx => {
			const store = tx.objectStore("drafts"), current: Draft | undefined = await request(store.get(draft.id));
			if (expectedRevision !== undefined && (current?.revision ?? null) !== expectedRevision) throw new Error("Draft changed in another view");
			if (current && (current.scopeId !== draft.scopeId || current.revision >= draft.revision)) {
				if (canonical(current as unknown as Json) === canonical(draft as unknown as Json)) return;
				throw new Error("Draft changed in another view");
			}
			await request(store.put(draft));
		});
	}

	async getDraft(id: string): Promise<Draft | undefined> {
		return this.transaction(["drafts"], "readonly", tx => request(tx.objectStore("drafts").get(id)));
	}

	async preference(key: string): Promise<Json | undefined> {
		return this.transaction(["preferences"], "readonly", tx => request(tx.objectStore("preferences").get(key)));
	}
	async setPreference(key: string, value: Json): Promise<void> {
		requiredId(key); value = JSON.parse(boundedJson(value)) as Json;
		await this.transaction(["preferences"], "readwrite", async tx => { await request(tx.objectStore("preferences").put(value, key)); });
	}
	async removeDraft(id: string, revision: number): Promise<boolean> {
		return this.transaction(["drafts"], "readwrite", async tx => {
			const drafts = tx.objectStore("drafts"), current: Draft | undefined = await request(drafts.get(id));
			if (!current || current.revision !== revision) return false;
			await request(drafts.delete(id)); return true;
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
		await this.transaction(["drafts", "preferences"], "readwrite", async tx => {
			const preferences = tx.objectStore("preferences"), key = "online:" + draftId;
			const existing = await request(preferences.get(key)) as { operation: { operationId: string }; revision: number } | undefined;
			if (existing?.operation.operationId !== operationId || existing.revision !== revision) throw new Error("Online action changed");
			const drafts = tx.objectStore("drafts"), draft: Draft | undefined = await request(drafts.get(draftId));
			if (draft?.revision !== revision) throw new Error("Draft changed in another view");
			await request(drafts.delete(draftId)); await request(preferences.delete(key));
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
		const identity = boundedJson(command as unknown as Json);
		command = JSON.parse(identity) as QueuedCommand;
		return this.transaction(["outbox", "drafts", "preferences"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), previous: OutboxOperation | undefined = await request(store.get(command.operationId));
			if (previous) {
				const { operationId, scopeId, type, payload, dependsOn } = previous;
				if (identity !== canonical({ operationId, scopeId, type, payload, dependsOn })) throw new Error("Operation ID was already used for another command");
				return previous;
			}
			if (draft) {
				if (await request(tx.objectStore("preferences").get("online:" + draft.id))) throw new Error("Review the unconfirmed online action before sending this draft");
				const current: Draft | undefined = await request(tx.objectStore("drafts").get(draft.id));
				if (!current || current.scopeId !== command.scopeId || current.revision !== draft.revision) throw new Error("Draft changed in another view");
				await request(tx.objectStore("drafts").delete(draft.id));
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
	async nextWakeAt(): Promise<number | undefined> {
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
				const due = op.state === "sending" ? op.lease?.expiresAt : op.nextAttemptAt;
				if (due !== undefined && (earliest === undefined || due < earliest)) earliest = due;
			}
			return earliest;
		});
	}

	/** Remote authorization loss clears cached content, never pending local text. */
	async clearRemoteScope(scopeId: string, expected?: ScopeCheckpoint): Promise<boolean> {
		return this.transaction(["entities", "cursors", "generations", "preferences"], "readwrite", async tx => {
			const generations = tx.objectStore("generations");
			const generation: number = await request(generations.get(scopeId)) ?? 0;
			if (expected && (generation !== expected.generation ||
				await request(tx.objectStore("cursors").get(scopeId)) !== expected.cursor)) return false;
			const store = tx.objectStore("entities");
			for (const key of await request(store.index("scope").getAllKeys(scopeId))) await request(store.delete(key));
			await request(tx.objectStore("cursors").delete(scopeId));
			await request(tx.objectStore("preferences").delete("permission:" + scopeId));
			await request(tx.objectStore("preferences").delete("people:" + scopeId));
			await request(generations.put(generation + 1, scopeId));
			return true;
		});
	}

	/** Explicit local account cleanup; callers must stop workers first. */
	async clearAll(): Promise<void> {
		await this.transaction(["drafts", "outbox", "entities", "cursors", "generations", "preferences"], "readwrite", async tx => {
			for (const name of ["drafts", "outbox", "entities", "cursors", "generations", "preferences"]) await request(tx.objectStore(name).clear());
		});
	}

	/** Read/write transactions serialize claims even across two plugin windows. */
	async claimNext(owner: string, now = Date.now(), leaseMs = 30_000): Promise<OutboxOperation | undefined> {
		requiredId(owner);
		if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 300_000) throw new Error("Invalid lease");
		return this.transaction(["outbox"], "readwrite", async tx => {
			const store = tx.objectStore("outbox"), states = store.index("state");
			const queued: OutboxOperation[] = await request(states.getAll("queued"));
			const sending: OutboxOperation[] = await request(states.getAll("sending"));
			const eligible = [...queued.filter(op => op.nextAttemptAt <= now),
				...sending.filter(op => op.lease && op.lease.expiresAt <= now)]
				.sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId));
			for (const op of eligible) {
				let ready = true;
				for (const id of op.dependsOn) {
					const dependency: OutboxOperation | undefined = await request(store.get(id));
					if (!dependency || dependency.state !== "accepted") { ready = false; break; }
				}
				if (!ready) continue;
				op.attempt++; op.state = "sending";
				op.lease = { owner, attempt: op.attempt, expiresAt: now + leaseMs };
				await request(store.put(op)); return op;
			}
			return undefined;
		});
	}

	async accept(operationId: string, result: Json): Promise<void> {
		boundedJson(result);
		await this.transaction(["outbox"], "readwrite", tx => this.acceptInTransaction(tx, operationId, result));
	}

	private async acceptInTransaction(tx: IDBTransaction, operationId: string, result: Json): Promise<void> {
		const store = tx.objectStore("outbox"), op: OutboxOperation | undefined = await request(store.get(operationId));
		if (!op || op.state === "accepted") return;
		op.state = "accepted"; op.result = result; delete op.lease; delete op.error;
		await request(store.put(op));
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
		return this.transaction(["entities", "cursors", "outbox", "generations"], "readwrite", async tx => {
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
