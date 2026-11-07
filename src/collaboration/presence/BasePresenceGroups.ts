import type { TFile } from "obsidian";
import { baseConfigurationKey, type NativeBaseGroupHandle, type NativeBasesSurface } from "../../bases/NativeBasesSurface";
import { nativeBaseGroupValueKey, type NativeBaseGroupValue, type NativeGroupLinkResolver } from "../../bases/NativeBaseGroupValue";
import { sha256Hex } from "../../contentDigest";
import { captureBaseGroupValue } from "../BaseGroupValueBridge";
import { parseBaseGroupValue } from "../BaseGroupValue";
import { parseBaseState, type BaseRecordContext } from "./BasePositionProtocol";
import type { BasePresenceGroup, BasePresenceReference } from "./BaseExtendedTargets";
import type { BasePresenceRecords, BaseLocalRecord } from "./BasePresenceRecords";
import type { BaseLocation } from "./LocationProtocol";

export interface BaseGroupSources {
	supported(): boolean; resolve: NativeGroupLinkResolver; fileAtPath(path: string): TFile | null;
}
type Options = BaseGroupSources & {
	current(): boolean; location(): BaseLocation | undefined; local(file: TFile): BaseLocalRecord | undefined;
	file(id: string): TFile | undefined; records: BasePresenceRecords; changed(): void;
};
export type BaseGroupFrame = { surface: NativeBasesSurface; handles: NativeBaseGroupHandle[]; members: Map<NativeBaseGroupHandle, TFile[]> };
type Proof = { file: TFile; path: string; local: BaseLocalRecord; record: BaseRecordContext };
type Entry = { key: string; valid(): boolean; build(): Promise<BasePresenceGroup>; value?: BasePresenceGroup;
	started: boolean; promise: Promise<void>; finish(): void };
export type BaseGroupMatch = { handle: NativeBaseGroupHandle; current(): boolean };
const inventory = new Set(["name", "basename", "fullname", "ext", "path", "folder", "file"]);
const supported = (handle: NativeBaseGroupHandle) => handle.target.property.source === "note" ||
	handle.target.property.source === "file" && inventory.has(handle.target.property.name.toLowerCase());
const key = (handle: NativeBaseGroupHandle) => JSON.stringify([handle.target.property, nativeBaseGroupValueKey(handle.target.value)]);
const reference = (record: BaseRecordContext): BasePresenceReference => ({ record_id: record.entry_id, record_generation: record.generation });
const digest = (text: string) => sha256Hex(new TextEncoder().encode(text).buffer);
const sameGroup = (a: BasePresenceGroup, b: BasePresenceGroup) => a.record_id === b.record_id && a.record_generation === b.record_generation &&
	a.property.source === b.property.source && a.property.name === b.property.name && a.value_sha256 === b.value_sha256 && a.references.length === b.references.length &&
	a.references.every(ref => b.references.some(other => ref.record_id === other.record_id && ref.record_generation === other.record_generation));

/** Read-only local matching. No note loads, providers, comment permission or
 * persistent group registry. Hash jobs and metadata are bounded independently. */
export class BasePresenceGroups {
	private entries = new Map<string, Entry>();
	private running = 0;
	private closed = false;
	constructor(private options: Options) {}
	frame(surface: NativeBasesSurface): BaseGroupFrame {
		const handles = !this.closed && this.options.current() && this.options.supported() ? surface.groupHandles(this.options.resolve) : [];
		const counts = new Map<string, number>();
		for (const handle of handles) counts.set(key(handle), (counts.get(key(handle)) ?? 0) + 1);
		return { surface, handles: handles.filter(handle => !handle.ambiguous && supported(handle) && counts.get(key(handle)) === 1 && handle.current()), members: new Map() };
	}
	private members(frame: BaseGroupFrame, handle: NativeBaseGroupHandle): TFile[] {
		let members = frame.members.get(handle); if (!members) { members = handle.members(); frame.members.set(handle, members); } return members;
	}
	private live(proofs: readonly Proof[], location: BaseLocation): boolean {
		return !this.closed && this.options.current() && this.options.supported() && JSON.stringify(this.options.location()) === JSON.stringify(location) &&
			proofs.every(proof => { const local = this.options.local(proof.file); return proof.file.path === proof.path && local?.id === proof.local.id &&
				local.type === proof.local.type && local.path === proof.local.path && this.options.records.get(proof.file, proof.record.generation) === proof.record; });
	}
	private prepare(handle: NativeBaseGroupHandle, member: TFile): Entry | undefined {
		try {
			const currentLocation = this.options.location(); if (!currentLocation || !supported(handle)) return;
			const location = { ...currentLocation };
			// Copy the complete bounded native tree before any asynchronous work.
			const files = new Set<TFile>([member]); let nodes = 256, characters = 0;
			const text = (value: string) => { characters += value.length; if (characters > 8192) throw new Error("Group text exceeds budget"); return value; };
			const copy = (value: NativeBaseGroupValue, depth = 0): NativeBaseGroupValue => {
				if (--nodes < 0 || depth > 8) throw new Error("Group exceeds budget");
				if (value.type === "list") return { type: "list", value: value.value.map(item => copy(item, depth + 1)) };
				if (value.type === "file" || value.type === "link") { files.add(value.file); return value.type === "file" ? { type: "file", file: value.file } : { type: "link", file: value.file, subpath: text(value.subpath) }; }
				if (value.type === "unresolved_link") { const file = this.options.fileAtPath(value.source); if (!file) throw new Error("Missing link source"); files.add(file); return { ...value, link: text(value.link), source: text(value.source) }; }
				const result = parseBaseGroupValue(value); if ("value" in result && typeof result.value === "string") text(result.value);
				return result as NativeBaseGroupValue;
			};
			let value = copy(handle.target.value); if (files.size > 9) return;
			const proofs: Proof[] = [], ids = new Set<string>(); let ready = true;
			for (const file of files) {
				const local = this.options.local(file); if (!local || ids.has(local.id)) return; ids.add(local.id);
				const record = this.options.records.get(file); if (!record) { ready = false; continue; }
				proofs.push({ file, path: file.path, local, record });
			}
			if (!ready) return;
			const selected = proofs.find(proof => proof.file === member)!;
			if (handle.target.property.source === "note" && selected.record.type !== "markdown") return;
			if (handle.target.property.source === "file") {
				const shared = selected.local.path; if (shared === undefined) return;
				const property = handle.target.property.name.toLowerCase(), localPath = selected.path;
				const project = (path: string, local: boolean): NativeBaseGroupValue => {
					if (property === "file") return { type: "file", file: member };
					const name = path.slice(path.lastIndexOf("/") + 1), dot = name.lastIndexOf("."), base = dot < 0 ? name : name.slice(0, dot), ext = dot < 0 ? "" : name.slice(dot + 1);
					const values: Record<string, string> = { name: ext === "md" ? base : name, basename: base, fullname: name, ext, path,
						folder: local ? member.parent?.path ?? (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/") : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
					return { type: "text", value: values[property] };
				};
				if (nativeBaseGroupValueKey(value) !== nativeBaseGroupValueKey(project(localPath, true))) return;
				value = project(shared, false);
			}
			const property = { ...handle.target.property }, scope = [1, location.share_id, location.entry_id, location.generation, location.definition_id,
				location.view_id, location.registry_revision, property.source, property.name];
			const cacheKey = baseConfigurationKey([scope, nativeBaseGroupValueKey(value), proofs.map(proof => [proof.path, proof.local.path ?? null, proof.record.entry_id, proof.record.generation])]);
			if (!cacheKey || !this.live(proofs, location)) return;
			const cached = this.entries.get(cacheKey); if (cached?.valid()) return cached;
			if (cached) { cached.finish(); this.entries.delete(cacheKey); }
			while (this.entries.size >= 128) { const first = this.entries.keys().next().value!; this.entries.get(first)!.finish(); this.entries.delete(first); }
			let finish!: () => void; const promise = new Promise<void>(resolve => { finish = resolve; });
			const proofFor = (file: TFile, path: string) => { const proof = proofs.find(proof => proof.file === file && proof.path === path); if (!proof || !this.live(proofs, location)) throw new Error("Group input changed"); return proof; };
			const entry: Entry = { key: cacheKey, valid: () => this.entries.get(cacheKey) === entry && this.live(proofs, location), started: false, promise, finish,
				build: async () => {
					const encoded = await captureBaseGroupValue(value, {
						file: async (file, path) => reference(proofFor(file, path).record),
						source: async path => { const file = this.options.fileAtPath(path), proof = file && proofFor(file, path); if (!proof?.local.path) throw new Error("Missing shared source path");
							return { ...reference(proof.record), source_path_sha256: await digest(proof.local.path) }; },
					});
					const canonical = baseConfigurationKey([...scope, encoded]); if (!canonical) throw new Error("Group exceeds budget");
					const target = { type: "group", ...reference(selected.record), property, value_sha256: await digest(canonical),
						references: proofs.filter(proof => proof !== selected).map(proof => reference(proof.record)).sort((a, b) => a.record_id.localeCompare(b.record_id)) };
					return parseBaseState({ version: 2, pointer: { target, offset: { x: 0, y: 0 } }, viewport: null }).pointer!.target as BasePresenceGroup;
				} };
			this.entries.set(cacheKey, entry); this.pump(); return entry;
		} catch { return; }
	}
	private pump(): void {
		if (this.closed) return;
		for (const entry of this.entries.values()) {
			if (this.running >= 2) break; if (entry.started) continue; entry.started = true;
			if (!entry.valid()) { entry.finish(); continue; }
			this.running++;
			void Promise.resolve().then(() => entry.valid() ? entry.build() : undefined).then(value => { if (entry.valid()) entry.value = value; })
				.catch(() => { /* Retry only after an explicit reset or changed identity. */ }).finally(() => {
					this.running--; entry.finish(); if (entry.valid()) this.options.changed(); this.pump();
				});
		}
	}
	capture(frame: BaseGroupFrame, handle: NativeBaseGroupHandle): BasePresenceGroup | undefined {
		if (!frame.handles.includes(handle) || !handle.current()) return;
		const members = this.members(frame, handle), candidates = members.map(file => ({ file, local: this.options.local(file) })).filter(item => !!item.local);
		const counts = new Map<string, number>(); for (const item of candidates) counts.set(item.local!.id, (counts.get(item.local!.id) ?? 0) + 1);
		for (const { file } of candidates.filter(item => counts.get(item.local!.id) === 1).sort((a, b) => a.local!.id.localeCompare(b.local!.id)).slice(0, 8)) {
			const entry = this.prepare(handle, file); if (entry?.valid() && entry.value) return entry.value;
		}
	}
	project(frame: BaseGroupFrame, target: BasePresenceGroup): BaseGroupMatch | undefined {
		const matches = frame.handles.filter(handle => JSON.stringify(handle.target.property) === JSON.stringify(target.property) &&
			this.members(frame, handle).some(file => this.options.local(file)?.id === target.record_id));
		if (matches.length !== 1) return;
		const handle = matches[0], files = this.members(frame, handle).filter(file => this.options.local(file)?.id === target.record_id); if (files.length !== 1) return;
		for (const ref of [target, ...target.references]) {
			const file = ref.record_id === target.record_id ? files[0] : this.options.file(ref.record_id);
			if (!file || !this.options.records.get(file, ref.record_generation)) return;
		}
		const entry = this.prepare(handle, files[0]); if (!entry?.value || !sameGroup(entry.value, target)) return;
		return { handle, current: () => frame.surface.current() && handle.current() && handle.members().includes(files[0]) && entry.valid() };
	}
	async wait(surface: NativeBasesSurface, target: BasePresenceGroup, current: () => boolean): Promise<BaseGroupMatch | undefined> {
		const files = [target, ...target.references].map(ref => ({ ref, file: this.options.file(ref.record_id) }));
		if (!current() || files.some(item => !item.file)) return;
		const records = await Promise.all(files.map(item => this.options.records.wait(item.file!, item.ref.record_generation)));
		if (!current() || records.some(record => !record)) return;
		const frame = this.frame(surface), handles = frame.handles.filter(handle => JSON.stringify(handle.target.property) === JSON.stringify(target.property) && this.members(frame, handle).includes(files[0].file!));
		if (handles.length !== 1) return;
		const entry = this.prepare(handles[0], files[0].file!); if (!entry) return;
		await entry.promise;
		return current() ? this.project(this.frame(surface), target) : undefined;
	}
	reset(): void { for (const entry of this.entries.values()) entry.finish(); this.entries.clear(); }
	close(): void { this.closed = true; this.reset(); }
}
