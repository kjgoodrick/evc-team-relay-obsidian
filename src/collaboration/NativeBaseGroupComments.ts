import type { TFile } from "obsidian";
import * as Y from "yjs";
import { toBase64 } from "lib0/buffer";
import { sha256Hex } from "../contentDigest";
import type { NativeBaseGroupHandle, NativeBaseGroupTarget } from "../bases/NativeBasesSurface";
import { nativeBaseGroupValueKey, type NativeGroupLinkResolver } from "../bases/NativeBaseGroupValue";
import type { BaseCommentContext } from "./BaseCommentContext";
import type { BaseDefinitionCatalog } from "./BaseDefinitionProtocol";
import type { BaseAnchor, BaseRecordType } from "./DiscussionProtocol";
import type { PendingBaseGroupAnchor } from "./LocalDiscussionAnchor";
import { baseGroupValueLabel, captureBaseGroupValue, revealBaseGroupValue } from "./BaseGroupValueBridge";

type Context = Pick<BaseCommentContext, "session" | "entryId" | "baseEntryId" | "binding" | "surface" | "current">;
export interface NativeGroupSource { text: Y.Text; current(): boolean; release?(): void }
export interface RetainedGroupCandidate { file: TFile; load(): Promise<NativeGroupSource | undefined> }
export interface NativeGroupSources {
	record(file: TFile): { id: string; type: BaseRecordType; path: string } | undefined;
	/** One inventory scan for a large native group; references are rechecked later. */
	records?(files: TFile[]): { file: TFile; record: { id: string; type: BaseRecordType; path: string } | undefined }[];
	file(id: string): TFile | undefined;
	fileAtPath(path: string): TFile | null;
	source(file: TFile): NativeGroupSource | undefined;
	/** Discover candidates without reading content. load() is called only after
	 * readBaseContext has authorized this account's access to the source. */
	retained?(files: TFile[], current: () => boolean): Promise<RetainedGroupCandidate[]>;
	read(file: TFile): Promise<string>;
	resolve: NativeGroupLinkResolver;
}
const propertyKey = (property: { source: string; name: string }) => JSON.stringify([property.source, property.name]);
export const nativeGroupTargetKey = (target: NativeBaseGroupTarget) => JSON.stringify(["group", propertyKey(target.property), nativeBaseGroupValueKey(target.value)]);
export function nativeGroupTargetLabel(target: NativeBaseGroupTarget): string {
	return baseGroupValueLabel(target.value);
}

/** Current native values select candidates; only the server grants a witness.
 * This adapter never creates documents, connects providers or changes source. */
export class NativeBaseGroupComments {
	constructor(private context: Context, private catalog: BaseDefinitionCatalog, private sources: NativeGroupSources) {}
	private definition(target: NativeBaseGroupTarget) {
		return this.catalog.targets.find(item => item.kind === "group" && propertyKey(item.property) === propertyKey(target.property));
	}
	handles(): NativeBaseGroupHandle[] { return this.context.current() ? this.context.surface.groupHandles(this.sources.resolve) : []; }
	hit(node: Node): NativeBaseGroupHandle[] { return this.context.current() ? this.context.surface.groupHit(node, this.sources.resolve) : []; }
	canCapture(handle: NativeBaseGroupHandle): boolean {
		return this.context.current() && handle.current() && handle.target.property.source === "note" && !!this.definition(handle.target) &&
			this.context.session.canAnchorBase("group") && this.context.session.permission(this.context.entryId)?.comment === true;
	}
	private async reference(file: TFile, capturedPath: string) {
		const record = this.sources.record(file), path = record?.path;
		const current = () => this.context.current() && file.path === capturedPath && this.sources.record(file)?.id === record?.id && this.sources.record(file)?.path === path;
		if (!record || !path || !current()) throw new Error("Group source is not a readable shared record");
		const proof = await this.context.session.readBaseContext(this.context.entryId, record.id);
		const hash = await sha256Hex(new TextEncoder().encode(path).buffer);
		if (!current() || !proof.record_generation || proof.definition_id !== this.catalog.definition_id || proof.generation !== this.catalog.generation) throw new Error("Group source changed");
		return { record_id: record.id, record_generation: proof.record_generation, source_path_sha256: hash };
	}
	async capture(handle: NativeBaseGroupHandle): Promise<PendingBaseGroupAnchor> {
		if (!this.canCapture(handle)) throw new Error("This group is not available for commenting");
		const definition = this.definition(handle.target)!, key = nativeGroupTargetKey(handle.target);
		const selected = () => this.context.current() && nativeGroupTargetKey(handle.target) === key;
		const references = new Map<TFile, ReturnType<NativeBaseGroupComments["reference"]>>();
		const reference = (file: TFile, path: string) => {
			if (!selected() || file.path !== path) throw new Error("Group selection changed");
			let promise = references.get(file); if (!promise) { promise = this.reference(file, path); references.set(file, promise); } return promise;
		};
		// Freeze the native value before any asynchronous cache or permission read.
		const value = captureBaseGroupValue(handle.target.value, {
			file: async (file, path) => { const ref = await reference(file, path); return { record_id: ref.record_id, record_generation: ref.record_generation }; },
			source: path => { const file = this.sources.fileAtPath(path); if (!file) throw new Error("Link source unavailable"); return reference(file, path); },
		});
		void value.catch(() => undefined); // Observe errors while source discovery awaits.
		const members = handle.members();
		const candidates = (this.sources.records?.(members) ?? members.map(file => ({ file, record: this.sources.record(file) })))
			.filter(candidate => candidate.record?.type === "markdown").sort((a, b) => a.record!.id.localeCompare(b.record!.id));
		let chosen: { file: TFile; source: NativeGroupSource } | undefined;
		for (const candidate of candidates) {
			const source = this.sources.source(candidate.file);
			if (source?.current()) { chosen = { file: candidate.file, source }; break; }
		}
		if (!chosen && this.sources.retained) {
			// Bound a single action across absent, unreadable or stale candidates.
			const deadline = Date.now() + 10_000, available = () => selected() && Date.now() < deadline;
			const retained = await this.sources.retained(candidates.map(candidate => candidate.file), available);
			const allowed = new Set(candidates.map(candidate => candidate.file));
			for (const candidate of retained) {
				if (!available()) break;
				if (!allowed.has(candidate.file)) continue;
				let source: NativeGroupSource | undefined;
				try {
					await reference(candidate.file, candidate.file.path);
					if (!available()) break;
					source = await candidate.load();
					if (source?.current()) { chosen = { file: candidate.file, source }; source = undefined; break; }
				} catch { /* Another readable member may have a complete retained copy. */ }
				finally { source?.release?.(); }
			}
		}
		if (!chosen) throw new Error("A synchronized source is unavailable. Open a shared note in this group and wait for it to finish synchronizing, then select the group again.");
		try {
			const { file, source } = chosen, path = file.path, text = source.text.toString();
			if (!source.text.doc || !source.current()) throw new Error("Group source changed");
			if (text.length > 2 * 1024 * 1024) throw new Error("This group's source note exceeds the current capture limit.");
			const snapshot = Y.encodeSnapshot(Y.snapshot(source.text.doc!));
			if (snapshot.length > 65536) throw new Error("This group's source history exceeds the current capture limit.");
			const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
			const stable = () => selected() && source.current() && file.path === path;
			const current = () => stable() && this.canCapture(handle) && handle.members().includes(file);
			// Attach a rejection handler immediately while the disk/source check awaits.
			const [disk, ref, capturedValue] = await Promise.all([this.sources.read(file), reference(file, path), value]);
			if (!current() || disk !== text) throw new Error("The group and synchronized note are still updating. Select the group again after synchronization.");
			const anchor = await this.context.session.captureBaseGroupSelection(this.context.entryId, {
				group_definition_id: definition.id, group_definition_revision: definition.revision, record_id: ref.record_id,
				record_generation: ref.record_generation, dependency: toBase64(snapshot), time_zone: timeZone, value: capturedValue });
			if (!current()) throw new Error("The group selection changed; existing drafts are retained.");
			return anchor;
		} finally { chosen.source.release?.(); }
	}
	async native(anchor: BaseAnchor | PendingBaseGroupAnchor): Promise<NativeBaseGroupTarget | undefined> {
		try {
			if (anchor.type === "base_group_pending" && anchor.entry_id !== this.context.baseEntryId) return;
			const captured = anchor.type === "base_group_pending" ? anchor.capture : anchor;
			if (!this.context.current() || captured.definition_id !== this.catalog.definition_id || captured.view_id !== this.catalog.view_id ||
				captured.generation !== this.catalog.generation || captured.registry_revision > this.catalog.registry_revision) return;
			const target = anchor.type === "base_group_pending" ? { definition_id: anchor.capture.group_definition_id,
				definition_revision: anchor.capture.group_definition_revision, property: anchor.property, value: anchor.capture.value } :
				anchor.target.type === "group" ? anchor.target : undefined;
			if (!target || !this.catalog.targets.some(item => item.kind === "group" && item.id === target.definition_id &&
				item.revision === target.definition_revision && propertyKey(item.property) === propertyKey(target.property))) return;
			const references = new Map<string, ReturnType<NativeBaseGroupComments["reference"]>>();
			const value = await revealBaseGroupValue(target.value, async reference => {
				const file = this.sources.file(reference.record_id); if (!file) throw new Error("Group reference unavailable");
				let promise = references.get(reference.record_id); if (!promise) { promise = this.reference(file, file.path); references.set(reference.record_id, promise); }
				const proof = await promise;
				if (proof.record_generation !== reference.record_generation) throw new Error("Group reference replaced");
				return { file, sourcePathHash: proof.source_path_sha256 };
			});
			return this.context.current() ? { type: "group", property: target.property, value } : undefined;
		} catch { return undefined; }
	}
	reveal(target: NativeBaseGroupTarget, current: () => boolean) {
		return this.context.surface.revealGroup(target, this.sources.resolve, () => this.context.current() && current());
	}
}
