import * as Y from "yjs";
import { platformFetch } from "../platformFetch";
import type { ItemRecord } from "../ItemKinds";
import { parseBaseState, type BaseContentState } from "../bases/BaseContentProtocol";
import { restoreContext, restoreGeneration, restoreMetadata, type RestoreBinding } from "../collaboration/RestoreGeneration";
import { CONFLICTS, diff, groups, makeConflict, overlay, rebase, same, scope, select, touches, type Records, type StructuralConflict } from "./managedRecovery";

export interface ManagedManifest {
	records: Record<string, ItemRecord>;
	permissions: Record<string, "read" | "write">;
	activity: Record<string, string>;
	owner: boolean;
	deleted?: Record<string, string[]>;
	base_content?: { protocol_version: number; enabled: boolean; recovery: boolean; versions: Record<string, string>; retired?: Record<string, string> };
	restore_guard?: boolean; restore_generation?: string | null;
}

export interface ManagedRestoreReview {
	id: string; createdAt: string; before?: ManagedManifest; observed: ManagedManifest;
	local: Records; activity: Record<string, string>;
}

export interface ManagedRestoreInspection {
	reviewId: string; checkedAt: string; local: Records; server: ManagedManifest;
	/** Transient view validity; never serialized into an archive or decision. */
	check?: () => void;
}

const restoreBinding = (value: Pick<ManagedManifest, "restore_guard" | "restore_generation">): RestoreBinding => {
	const context = restoreContext(value.restore_guard, value.restore_generation);
	if (context?.generation && !context.supported) throw new Error("The server cannot safely synchronize this restored share. Local work is retained.");
	return context ? { restoreGeneration: context.generation } : {};
};
const restoreMessage = "This share was restored. Synchronization is paused; local files and saved inventory changes are retained for restore review.";

const BASE = "managed_base_v1";
/** Only JSON metadata crosses this connection. The local Y.Doc is a private
 * adapter for EVC's existing reconciliation code, never a shared CRDT index. */
export class ManagedIndexTransport {
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<unknown>;
	private stopped = false;
	private destroyed = false;
	private connected = false;
	private generation = 0;
	private readonly changed = (_update: Uint8Array, origin: unknown) => {
		if (origin !== this && this.connected) this.schedule(100);
	};
	permissions: Record<string, "read" | "write"> = {};
	owner = false;

	constructor(
		private doc: Y.Doc,
		private credentials: () => { endpoint: string; token: string },
		private status: (connected: boolean) => void,
		private failed: (error: Error) => void,
	) { this.doc.on("update", this.changed); }

	start(): void {
		this.stopped = false;
		if (this.restoreReview) { this.connected = false; this.status(false); this.failed(new Error(restoreMessage)); return; }
		this.schedule(0);
	}
	stop(): void {
		this.stopped = true;
		this.generation++;
		clearTimeout(this.timer);
		this.connected = false;
		this.status(false);
	}
	destroy(): void { this.destroyed = true; this.stop(); this.doc.off("update", this.changed); }

	registered(path: string, id: string): boolean {
		return !this.restoreReview && this.doc.getMap<ManagedManifest>(BASE).get("snapshot")?.records[path]?.id === id;
	}

	async claim(path: string, record: ItemRecord): Promise<boolean> {
		const binding = restoreBinding(this.snapshot), generation = this.generation;
		const body = JSON.stringify({ path, record });
		return this.exclusive(() => this.claimNow(path, JSON.parse(body).record as ItemRecord, body, binding, generation));
	}

	private async claimNow(path: string, record: ItemRecord, body: string, binding: RestoreBinding, generation: number): Promise<boolean> {
		this.check(generation, binding);
		if (!this.doc.getMap(BASE).has("snapshot")) throw new Error("Wait for the shared file inventory before reserving a file");
		const base = this.snapshot;
		if (binding.restoreGeneration) this.observe(await this.manifest(await this.request()), base, true, generation);
		if (this.isBlocked(path, record.id)) throw new Error("Resolve the structural conflict before publishing this file. Local edits are retained.");
		const { endpoint, token } = this.credentials();
		const response = await platformFetch(endpoint + "/claim", {
			method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...this.restoreHeader(binding) }, body,
		});
		this.check(generation, binding);
		if (!response.ok) throw new Error(`Cannot reserve the file (${response.status}). Local files have been retained.`);
		const result = JSON.parse(await response.text()) as { won: boolean; record: ItemRecord; permission: "read" | "write" } & Pick<ManagedManifest, "restore_guard" | "restore_generation">;
		this.check(generation, binding);
		if (restoreGeneration(restoreBinding(result).restoreGeneration) !== restoreGeneration(binding.restoreGeneration)) throw new Error(restoreMessage);
		Y.transact(this.doc, () => {
			const persisted = this.doc.getMap<ManagedManifest>(BASE);
			const snapshot = persisted.get("snapshot")!;
			persisted.set("snapshot", { ...snapshot, records: { ...snapshot.records, [path]: result.record }, permissions: { ...snapshot.permissions, [path]: result.permission } });
			this.doc.getMap<ItemRecord>("filemeta_v0").set(path, result.record);
			if (result.record.type === "markdown") this.doc.getMap<string>("docs").set(path, result.record.id);
		}, this);
		this.permissions = { ...this.permissions, [path]: result.permission };
		return result.won;
	}

	/** Keep unrelated or revoked local files out of the metadata outbox. */
	async publishablePaths(paths: string[]): Promise<Set<string>> {
		this.check();
		const generation = this.generation, binding = restoreBinding(this.snapshot);
		const snapshot = this.doc.getMap<ManagedManifest>(BASE).get("snapshot");
		if (!snapshot) throw new Error("Wait for the shared file inventory before adding files");
		paths = paths.filter(path => !this.isBlocked(path));
		if (snapshot.owner) return new Set(paths);
		const allowed = new Set(paths.filter(path => snapshot.records[path]));
		const unknown = paths.filter(path => !allowed.has(path));
		const { endpoint, token } = this.credentials();
		for (let i = 0; i < unknown.length; i += 1000) {
			const response = await platformFetch(endpoint + "/access", {
				method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				body: JSON.stringify({ paths: unknown.slice(i, i + 1000) }),
			});
			if (!response.ok) throw new Error(`Could not check new-file permissions (${response.status})`);
			const permissions = JSON.parse(await response.text()) as Record<string, string>;
			this.check(generation, binding);
			for (const path of unknown.slice(i, i + 1000)) if (permissions[path] === "write") allowed.add(path);
		}
		return allowed;
	}

	private schedule(ms: number): void {
		if (this.stopped) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, ms);
	}

	get conflicts(): StructuralConflict[] { return [...this.doc.getMap<StructuralConflict>(CONFLICTS).values()]; }
	get restoreReview(): ManagedRestoreReview | undefined { return this.doc.getMap<ManagedRestoreReview>(BASE).get("restoreReview"); }
	/** Read current visible inventory without applying it, adopting its lineage,
	 * restarting the exchange loop or publishing any retained local work. */
	async inspectRestore(checkContext = () => {}): Promise<ManagedRestoreInspection> {
		const review = this.restoreReview;
		if (!review) throw new Error("This shared folder has no restore review to inspect");
		const reviewText = JSON.stringify(review), localText = JSON.stringify(this.doc.getMap<ItemRecord>("filemeta_v0").toJSON());
		const credentials = this.credentials(), generation = this.generation;
		const check = () => {
			checkContext();
			const current = this.credentials();
			if (this.destroyed || this.doc.isDestroyed || generation !== this.generation
				|| current.endpoint !== credentials.endpoint || current.token !== credentials.token
				|| JSON.stringify(this.restoreReview) !== reviewText || JSON.stringify(this.doc.getMap("filemeta_v0").toJSON()) !== localText) {
				throw new Error("The restore review or connection changed. Refresh the comparison; local work is retained.");
			}
		};
		check();
		const response = await platformFetch(credentials.endpoint, { method: "GET", sensitive: true, headers: { Authorization: `Bearer ${credentials.token}` } });
		check();
		const server = await this.manifest(response); check();
		return { reviewId: review.id, checkedAt: new Date().toISOString(), local: JSON.parse(localText) as Records, server, check };
	}
	/** Bind a source transfer before its first asynchronous read. */
	captureContentContext(path: string, id: string): { binding: RestoreBinding; check: () => void } {
		if (!this.doc.getMap(BASE).has("snapshot")) throw new Error("Wait for the shared file inventory before transferring a file");
		const binding = restoreMetadata(restoreBinding(this.snapshot)), generation = this.generation;
		const check = () => {
			this.check(generation, binding);
			if (this.isBlocked(path, id)) throw new Error("File synchronization is paused. Local content is retained.");
		};
		check();
		return { binding, check };
	}
	private check(generation = this.generation, binding?: RestoreBinding): void {
		if (this.stopped || generation !== this.generation) throw new Error("File inventory context changed. Local work is retained.");
		if (this.restoreReview) throw new Error(restoreMessage);
		if (binding && restoreGeneration(binding.restoreGeneration) !== restoreGeneration(restoreBinding(this.snapshot).restoreGeneration)) throw new Error(restoreMessage);
	}
	private restoreHeader(binding: RestoreBinding): Record<string, string> {
		const generation = restoreGeneration(binding.restoreGeneration);
		return generation === null ? {} : { "X-Relay-Restore-Generation": generation };
	}
	/** Keep the last inventory and local view intact. Reconciliation of the whole
	 * restored share must precede adopting new authority or resending old work. */
	private observe(snapshot: ManagedManifest, base: ManagedManifest, hadSnapshot: boolean, generation: number): void {
		this.check(generation, restoreBinding(base));
		const prior = restoreGeneration(restoreBinding(base).restoreGeneration), next = restoreGeneration(restoreBinding(snapshot).restoreGeneration);
		if (prior === next) return;
		if (!hadSnapshot && !this.doc.getMap("filemeta_v0").size && !this.doc.getMap("docactivity_v0").size && !this.conflicts.length) return;
		const review: ManagedRestoreReview = { id: crypto.randomUUID(), createdAt: new Date().toISOString(),
			...(hadSnapshot ? { before: base } : {}), observed: snapshot,
			local: this.doc.getMap<ItemRecord>("filemeta_v0").toJSON() as Records,
			activity: this.doc.getMap<string>("docactivity_v0").toJSON() as Record<string, string> };
		this.doc.transact(() => this.doc.getMap(BASE).set("restoreReview", review), this);
		this.connected = false; this.permissions = {}; this.owner = false; this.status(false); clearTimeout(this.timer);
		throw new Error(restoreMessage);
	}

	isBlocked(path: string, id?: string): boolean {
		if (this.restoreReview) return true;
		const record = id ? { id } as ItemRecord : this.doc.getMap<ItemRecord>("filemeta_v0").get(path) ?? this.snapshot.records[path];
		return this.conflicts.some(c => touches(c, path, record) || !!select(this.snapshot.records, c)[path]);
	}

	get snapshot(): ManagedManifest {
		const snapshot = this.doc.getMap<ManagedManifest>(BASE).get("snapshot") ?? { records: {}, permissions: {}, activity: {}, owner: false };
		return this.restoreReview ? { ...snapshot, permissions: {}, owner: false } : snapshot;
	}

	private async exclusive<T>(action: () => Promise<T>): Promise<T> {
		if (this.running) { await this.running.catch(() => undefined); return this.exclusive(action); }
		const promise = action(); this.running = promise;
		try { return await promise; } finally { if (this.running === promise) this.running = undefined; }
	}

	async flush(): Promise<void> {
		return this.exclusive(() => {
			if (this.stopped) throw new Error("File inventory is offline");
			return this.exchange();
		});
	}

	/** A guarded save changes content metadata outside the inventory endpoint.
	 * Advance only its exact prior snapshot, carrying the new metadata through
	 * an in-flight local rename without publishing the old hash again. */
	async acknowledgeBaseContent(expected: BaseContentState, accepted: BaseContentState, binding: RestoreBinding = {}): Promise<void> {
		binding = restoreMetadata(binding);
		expected = parseBaseState(expected, expected.record.id); accepted = parseBaseState(accepted, expected.record.id);
		if (accepted.path !== expected.path || !accepted.content_version || !accepted.record.hash || accepted.record.synctime === undefined) throw new Error("Invalid accepted Bases metadata");
		await this.exclusive(async () => {
			if (this.stopped) return;
			this.check(this.generation, binding);
			const snapshot = this.snapshot, capability = snapshot.base_content;
			if (!capability || !same(snapshot.records[expected.path], expected.record) ||
				(capability.versions[expected.record.id] ?? null) !== expected.content_version) return;
			Y.transact(this.doc, () => {
				const records = this.doc.getMap<ItemRecord>("filemeta_v0");
				for (const [path, record] of records) if (record.id === expected.record.id && same(record, expected.record)) records.set(path, accepted.record as ItemRecord);
				this.doc.getMap<ManagedManifest>(BASE).set("snapshot", { ...snapshot,
					records: { ...snapshot.records, [accepted.path]: accepted.record as ItemRecord },
					base_content: { ...capability, versions: { ...capability.versions, [expected.record.id]: accepted.content_version! } } });
			}, this);
			this.schedule(100);
		});
	}

	private async request(body?: unknown, binding: RestoreBinding = {}): Promise<Response> {
		const { endpoint, token } = this.credentials();
		return platformFetch(endpoint, { method: body ? "POST" : "GET",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(body ? this.restoreHeader(binding) : {}) },
			...(body ? { body: JSON.stringify(body) } : {}) });
	}

	private async manifest(response: Response): Promise<ManagedManifest> {
		if (!response.ok) throw new Error(`File inventory refused (${response.status}). Local edits have been retained.`);
		const snapshot = JSON.parse(await response.text()) as ManagedManifest;
		const binding = restoreBinding(snapshot);
		return snapshot.restore_generation === undefined ? snapshot : { ...snapshot, restore_generation: binding.restoreGeneration ?? null };
	}

	/** Incorporate further offline moves/edits into the persisted decision, rather
	 * than repeatedly submitting the rejected delta or reverting the local view. */
	private refreshConflicts(current: Records): void {
		const expected = overlay(this.snapshot.records, this.conflicts);
		for (const group of groups(diff(expected, current))) {
			const affected = scope(group);
			const overlapping = this.conflicts.filter(c => group.some(g => touches(c, g.path, g.previous) || touches(c, g.path, g.value)) || c.paths.some(p => affected.paths.some(q => p.startsWith(q + "/"))));
			if (!overlapping.length) continue;
			const merged = { ...overlapping[0], paths: [...new Set([...affected.paths, ...overlapping.flatMap(c => c.paths)])], ids: [...new Set([...affected.ids, ...overlapping.flatMap(c => c.ids)])] };
			merged.local = select(current, merged);
			merged.base = Object.assign({}, ...overlapping.map(c => c.base));
			this.doc.transact(() => {
				for (const c of overlapping) this.doc.getMap(CONFLICTS).delete(c.id);
				this.doc.getMap(CONFLICTS).set(merged.id, merged);
			}, this);
		}
	}

	// JSON snapshots create local Yjs operations; marking them remote rotates the
	// client ID on every poll. The origin still suppresses an outbox echo.
	private install(snapshot: ManagedManifest, sent: Records, markers: Record<string, string>, added: StructuralConflict[] = []): void {
		const records = this.doc.getMap<ItemRecord>("filemeta_v0");
		const later = records.toJSON() as Records;
		// Preserve entire identities for changes made during HTTP, including both
		// endpoints of a rename. Path-only merging can duplicate a document ID.
		const inflight = groups(diff(sent, later)).map(g => makeConflict(g, sent, later, "in flight"));
		const view = overlay(overlay(snapshot.records, [...this.conflicts, ...added]), inflight);
		Y.transact(this.doc, () => {
			for (const c of added) this.doc.getMap(CONFLICTS).set(c.id, c);
			const flat = this.doc.getMap<string>("docs");
			for (const path of [...records.keys()]) if (!view[path]) { records.delete(path); flat.delete(path); }
			for (const [path, record] of Object.entries(view)) {
				if (!same(records.get(path), record)) records.set(path, record);
				if (record.type === "markdown") { if (flat.get(path) !== record.id) flat.set(path, record.id); }
				else flat.delete(path);
			}
			const activity = this.doc.getMap<string>("docactivity_v0");
			for (const id of [...activity.keys()]) if (!(id in snapshot.activity) && activity.get(id) === markers[id]) activity.delete(id);
			for (const [id, value] of Object.entries(snapshot.activity)) if (activity.get(id) === markers[id] && activity.get(id) !== value) activity.set(id, value);
			this.doc.getMap<ManagedManifest>(BASE).set("snapshot", snapshot);
		}, this);
		this.permissions = snapshot.permissions; this.owner = snapshot.owner;
		this.connected = true; this.status(true); this.schedule(1000);
	}

	private async exchange(): Promise<void> {
		this.check();
		const generation = this.generation;
		const current = this.doc.getMap<ItemRecord>("filemeta_v0").toJSON() as Records;
		this.refreshConflicts(current);
		const base = this.snapshot;
		const hadSnapshot = this.doc.getMap(BASE).has("snapshot"), binding = restoreBinding(base);
		const changes = diff(overlay(base.records, this.conflicts), current);
		const markers = this.doc.getMap<string>("docactivity_v0").toJSON() as Record<string, string>;
		const activity = Object.fromEntries(Object.entries(markers).filter(([id, value]) =>
			base.activity[id] !== value && Object.entries(current).some(([path, record]) => record.id === id && !this.isBlocked(path, id)) && (base.owner || Object.entries(base.records).some(([path, record]) => record.id === id && base.permissions[path] === "write"))));
		try {
			const dirty = changes.length || Object.keys(activity).length;
			if (dirty && binding.restoreGeneration) this.observe(await this.manifest(await this.request()), base, hadSnapshot, generation);
			let response = await this.request(dirty ? { changes, activity } : undefined, binding);
			this.check(generation, binding);
			const added: StructuralConflict[] = [];
			let snapshot: ManagedManifest;
			if ((response.status === 403 || response.status === 409) && dirty) {
				snapshot = await this.manifest(await this.request());
				this.observe(snapshot, base, hadSnapshot, generation);
				for (const group of groups(changes)) {
					const action = rebase(group, base.records, current, snapshot.records, snapshot.deleted);
					if (action === "done") continue;
					if (action === "retry") {
						this.check(generation, binding);
						response = await this.request({ changes: group, activity: {} }, binding);
						this.check(generation, binding);
						if (response.ok) { snapshot = await this.manifest(response); this.observe(snapshot, base, hadSnapshot, generation); continue; }
						if (response.status !== 403 && response.status !== 409) await this.manifest(response);
					}
					added.push(makeConflict(group, base.records, current, action === "conflict"
						? "The server changed the same file or folder while this device had a local change."
						: "The server cannot accept this change. Access, a destination, or a folder child may have changed."));
				}
			} else snapshot = await this.manifest(response);
			if (this.stopped || generation !== this.generation) return;
			this.observe(snapshot, base, hadSnapshot, generation);
			this.install(snapshot, current, markers, added);
		} catch (error) {
			if (!this.stopped && generation === this.generation) {
				this.connected = false; this.status(false);
				this.failed(error instanceof Error ? error : new Error(String(error))); if (!this.restoreReview) this.schedule(5000);
			}
			throw error;
		}
	}

	/** A decision is conditional on the exact visible server state reviewed by
	 * the user. Backup preparation must finish before any server or disk change. */
	async resolve(id: string, choice: "server" | "local", reviewed: Records,
		prepare: (conflict: StructuralConflict, server: ManagedManifest) => Promise<() => Promise<void>>): Promise<void> {
		return this.exclusive(async () => {
			if (this.stopped) throw new Error("Reconnect the share before resolving a conflict.");
			this.check();
			const generation = this.generation;
			const base = this.snapshot, binding = restoreBinding(base);
			const current = this.doc.getMap<ItemRecord>("filemeta_v0").toJSON() as Records;
			this.refreshConflicts(current);
			const conflict = this.conflicts.find(c => c.id === id);
			if (!conflict) throw new Error("The conflict changed. Reopen it and review the current files.");
			const expected = overlay(this.snapshot.records, this.conflicts);
			let snapshot = await this.manifest(await this.request());
			this.observe(snapshot, base, true, generation);
			if (!same(select(snapshot.records, conflict), reviewed)) {
				this.install(snapshot, expected, {});
				throw new Error("The server changed again. Review the updated conflict before choosing.");
			}
			const desired = overlay(snapshot.records, [conflict]);
			if (choice === "local" && Object.values(snapshot.records).some(record =>
				!conflict.ids.includes(record.id) && !Object.values(desired).some(local => local.id === record.id))) {
				throw new Error("New server files appeared inside this folder. Use the server layout first, then move or delete the folder after reviewing those files.");
			}
			const finish = await prepare(conflict, snapshot);
			this.check(generation, binding);
			if (this.stopped || generation !== this.generation || !same(this.doc.getMap<ItemRecord>("filemeta_v0").toJSON(), current))
				throw new Error("Local files changed during recovery. They are retained; review and retry.");
			if (choice === "local") {
				snapshot = await this.manifest(await this.request({ changes: diff(snapshot.records, desired), activity: {} }, binding));
				this.observe(snapshot, base, true, generation);
			}
			// For a server decision finish archives originals; for a local decision
			// it simply verifies the backup. Failures retain the persisted conflict.
			await finish();
			this.check(generation, binding);
			this.doc.getMap(CONFLICTS).delete(id);
			this.install(snapshot, expected, {});
		});
	}
}
