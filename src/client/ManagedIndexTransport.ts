import * as Y from "yjs";
import { platformFetch } from "../platformFetch";
import type { ItemRecord } from "../ItemKinds";

export interface ManagedManifest {
	records: Record<string, ItemRecord>;
	permissions: Record<string, "read" | "write">;
	activity: Record<string, string>;
	owner: boolean;
	deleted?: Record<string, string[]>;
}

const BASE = "managed_base_v1";
const same = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
	return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => same(left[key], right[key]));
};

/** Only JSON metadata crosses this connection. The local Y.Doc is a private
 * adapter for EVC's existing reconciliation code, never a shared CRDT index. */
export class ManagedIndexTransport {
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private stopped = false;
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

	start(): void { this.stopped = false; this.schedule(0); }
	stop(): void {
		this.stopped = true;
		this.generation++;
		clearTimeout(this.timer);
		this.connected = false;
		this.status(false);
	}
	destroy(): void { this.stop(); this.doc.off("update", this.changed); }

	registered(path: string, id: string): boolean {
		return this.doc.getMap<ManagedManifest>(BASE).get("snapshot")?.records[path]?.id === id;
	}

	async claim(path: string, record: ItemRecord): Promise<boolean> {
		const { endpoint, token } = this.credentials();
		const response = await platformFetch(endpoint + "/claim", {
			method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path, record }),
		});
		if (!response.ok) throw new Error(`Cannot reserve the file (${response.status}). Local files have been retained.`);
		const result = JSON.parse(await response.text()) as { won: boolean; record: ItemRecord; permission: "read" | "write" };
		Y.transact(this.doc, () => {
			const persisted = this.doc.getMap<ManagedManifest>(BASE);
			const snapshot = persisted.get("snapshot")!;
			persisted.set("snapshot", { ...snapshot, records: { ...snapshot.records, [path]: result.record }, permissions: { ...snapshot.permissions, [path]: result.permission } });
			this.doc.getMap<ItemRecord>("filemeta_v0").set(path, result.record);
			if (result.record.type === "markdown") this.doc.getMap<string>("docs").set(path, result.record.id);
		}, this, false);
		this.permissions = { ...this.permissions, [path]: result.permission };
		return result.won;
	}

	/** Keep unrelated or revoked local files out of the metadata outbox. */
	async publishablePaths(paths: string[]): Promise<Set<string>> {
		const snapshot = this.doc.getMap<ManagedManifest>(BASE).get("snapshot");
		if (!snapshot) throw new Error("Wait for the shared file inventory before adding files");
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
			for (const path of unknown.slice(i, i + 1000)) if (permissions[path] === "write") allowed.add(path);
		}
		return allowed;
	}

	private schedule(ms: number): void {
		if (this.stopped) return;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, ms);
	}

	async flush(): Promise<void> {
		if (this.stopped) throw new Error("File inventory is offline");
		if (this.running) { await this.running; return this.flush(); }
		this.running = this.exchange();
		try { await this.running; }
		finally { this.running = undefined; }
	}

	private async exchange(): Promise<void> {
		const generation = this.generation;
		const persisted = this.doc.getMap<ManagedManifest>(BASE);
		const base = persisted.get("snapshot") ?? { records: {}, permissions: {}, activity: {}, owner: false };
		const records = this.doc.getMap<ItemRecord>("filemeta_v0");
		const current = records.toJSON() as Record<string, ItemRecord>;
		const changes = [...new Set([...Object.keys(base.records), ...Object.keys(current)])]
			.filter(path => !same(base.records[path] ?? null, current[path] ?? null))
			.map(path => ({ path, previous: base.records[path] ?? null, value: current[path] ?? null }));
		const markers = this.doc.getMap<string>("docactivity_v0").toJSON() as Record<string, string>;
		const activity = Object.fromEntries(Object.entries(markers).filter(([id, value]) =>
			base.activity[id] !== value && Object.values(current).some(record => record.id === id) && (base.owner || Object.entries(base.records).some(([path, record]) => record.id === id && base.permissions[path] === "write"))));
		const dirty = changes.length > 0 || Object.keys(activity).length > 0;
		const { endpoint, token } = this.credentials();
		try {
			let response = await platformFetch(endpoint, {
				method: dirty ? "POST" : "GET",
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				...(dirty ? { body: JSON.stringify({ changes, activity }) } : {}),
			});
			// A permission change can race a harmless activity marker. Refresh
			// the filtered inventory instead of wedging the whole share on it.
			if (response.status === 403 && changes.length === 0 && dirty) {
				response = await platformFetch(endpoint, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
			}
			if (!response.ok) throw new Error(`File inventory refused (${response.status}). Local edits have been retained.`);
			const snapshot = JSON.parse(await response.text()) as ManagedManifest;
			if (this.stopped || generation !== this.generation) return;
			// Edits made while HTTP was in flight must remain in the outbox.
			const later = records.toJSON() as Record<string, ItemRecord>;
			const changedDuringRequest = new Set([...new Set([...Object.keys(current), ...Object.keys(later)])]
				.filter(path => !same(current[path] ?? null, later[path] ?? null)));
			Y.transact(this.doc, () => {
				const flat = this.doc.getMap<string>("docs");
				for (const path of [...records.keys()]) {
					if (!snapshot.records[path] && !changedDuringRequest.has(path)) { records.delete(path); flat.delete(path); }
				}
				for (const [path, record] of Object.entries(snapshot.records)) {
					if (changedDuringRequest.has(path)) continue;
					if (!same(records.get(path), record)) records.set(path, record);
					if (record.type === "markdown" && flat.get(path) !== record.id) flat.set(path, record.id);
				}
				const activityMap = this.doc.getMap<string>("docactivity_v0");
				for (const id of [...activityMap.keys()]) {
					if (!(id in snapshot.activity) && activityMap.get(id) === markers[id]) activityMap.delete(id);
				}
				for (const [id, value] of Object.entries(snapshot.activity)) {
					if (activityMap.get(id) === markers[id] && activityMap.get(id) !== value) activityMap.set(id, value);
				}
				persisted.set("snapshot", snapshot);
			}, this, false);
			this.permissions = snapshot.permissions;
			this.owner = snapshot.owner;
			this.connected = true;
			this.status(true);
			this.schedule(1000);
		} catch (error) {
			if (!this.stopped && generation === this.generation) {
				this.connected = false;
				this.status(false);
				this.failed(error instanceof Error ? error : new Error(String(error)));
				this.schedule(5000);
			}
			throw error;
		}
	}
}
