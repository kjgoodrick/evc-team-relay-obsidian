import type { TFile } from "obsidian";
import type { BaseRecordContext } from "./BasePositionProtocol";

export type BaseLocalRecord = Readonly<{ id: string; type: BaseRecordContext["type"]; path?: string }>;
type Entry = { file: TFile; path: string; local: BaseLocalRecord; context?: BaseRecordContext; requested: Set<string>;
	promise: Promise<BaseRecordContext | undefined>; finish(value?: BaseRecordContext): void; started: boolean; done: boolean };
type Options = { current(): boolean; local(file: TFile): BaseLocalRecord | undefined; read(id: string): Promise<BaseRecordContext>; changed(): void };

/** Per-foreground-Base lineage cache. Two requests at a time, at most 256
 * entries, no polling on rejection and no reads per ordinary pointer movement. */
export class BasePresenceRecords {
	private entries = new Map<string, Entry>();
	private running = 0;
	private closed = false;
	constructor(private options: Options) {}
	private current(entry: Entry): boolean {
		const local = !this.closed && this.options.current() && this.options.local(entry.file);
		return !!local && this.entries.get(local.id) === entry && entry.path === entry.file.path && local.id === entry.local.id && local.type === entry.local.type;
	}
	private entry(file: TFile, generation?: string): Entry | undefined {
		if (this.closed || !this.options.current()) return;
		const local = this.options.local(file); if (!local) return;
		let entry = this.entries.get(local.id);
		if (entry && (entry.file !== file || !this.current(entry))) { this.entries.delete(local.id); entry.finish(); entry = undefined; }
		if (entry && generation && entry.context && entry.context.generation !== generation && !entry.requested.has(generation) && entry.requested.size < 8) {
			this.entries.delete(local.id); entry.finish(); entry.requested.add(generation);
			entry = this.create(file, local, entry.requested);
		} else if (!entry) entry = this.create(file, local, new Set(generation ? [generation] : []));
		this.pump(); return entry;
	}
	private create(file: TFile, local: BaseLocalRecord, requested: Set<string>): Entry {
		while (this.entries.size >= 256) { const key = this.entries.keys().next().value!; this.entries.get(key)!.finish(); this.entries.delete(key); }
		let finish!: Entry["finish"];
		const promise = new Promise<BaseRecordContext | undefined>(resolve => { finish = resolve; });
		const entry: Entry = { file, path: file.path, local, requested, promise, finish, started: false, done: false };
		this.entries.set(local.id, entry); return entry;
	}
	private pump(): void {
		if (this.closed) return;
		for (const entry of this.entries.values()) {
			if (this.running >= 2) break;
			if (entry.started) continue;
			entry.started = true;
			if (!this.current(entry)) { entry.done = true; entry.finish(); continue; }
			this.running++;
			void Promise.resolve().then(() => this.current(entry) ? this.options.read(entry.local.id) : undefined).then(context => {
				if (this.current(entry) && context?.entry_id === entry.local.id && context.type === entry.local.type) entry.context = context;
			}).catch(() => { /* Explicit retry or changed local identity is required. */ }).finally(() => {
				this.running--; entry.done = true; entry.finish(this.current(entry) ? entry.context : undefined);
				if (this.current(entry)) this.options.changed(); this.pump();
			});
		}
	}
	get(file: TFile, generation?: string): BaseRecordContext | undefined {
		const entry = this.entry(file, generation), context = entry?.context;
		return context && (!generation || context.generation === generation) ? context : undefined;
	}
	async wait(file: TFile, generation: string): Promise<BaseRecordContext | undefined> {
		const entry = this.entry(file, generation); if (!entry) return;
		// Explicit navigation goes ahead of queued background pointer metadata.
		if (!entry.started) this.entries = new Map([[entry.local.id, entry], ...[...this.entries].filter(([id]) => id !== entry.local.id)]);
		const value = await entry.promise;
		return this.current(entry) && value?.generation === generation ? value : undefined;
	}
	reset(): void { for (const entry of this.entries.values()) entry.finish(); this.entries.clear(); }
	reconcile(): void {
		for (const [id, entry] of this.entries) if (!this.current(entry) || entry.done && !entry.context) { entry.finish(); this.entries.delete(id); }
	}
	close(): void { this.closed = true; this.reset(); }
}
