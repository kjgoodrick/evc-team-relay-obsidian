import { sha256Hex } from "../contentDigest";
import { restoreContext, restoreMetadata, type RestoreContext, type RestoreBinding } from "../collaboration/RestoreGeneration";

export const BASE_CONTENT_LIMIT = 256 * 1024;
export const BASE_LOCAL_QUOTA = 64 * 1024 * 1024;
export interface BaseRecord {
	id: string; version: 0; type: "file"; hash?: string; mimetype?: string; synctime?: number;
}
export interface BaseContentState {
	path: string; record: BaseRecord; generation: string | null; content_version: string | null;
}
export interface BaseSnapshot { state: BaseContentState; bytes: ArrayBuffer | null; restoreContext?: RestoreContext }
export interface BasePending extends RestoreBinding { operationId: string; expected: BaseContentState; bytes: ArrayBuffer }
export interface BaseAccepted { operation_id: string; state: BaseContentState }
export type BaseWithdrawal = { status: "accepted"; result: BaseAccepted } |
	{ status: "withdrawn"; operation_id: string; entry_id: string };
export type BaseCommandStatus = BaseWithdrawal | { status: "unknown"; operation_id: string; entry_id: string };

export const baseId = (value: unknown): value is string => typeof value === "string" &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const baseObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const invalid = (): never => { throw new Error("Invalid Bases content protocol data"); };

export const basePath = (path: unknown): path is string => typeof path === "string" && !!path && path.length <= 512 &&
	path === path.normalize("NFC") && !/[\\:]/.test(path) && ![...path].some(character => character.charCodeAt(0) < 32) &&
	!path.split("/").some(part => !part || part.startsWith("."));

/** Require both the guarded marker and an explicit matching tombstone. */
export function retiredBaseEntries(manifest: { base_content?: { retired?: Record<string, string> }; deleted?: Record<string, string[]> }): [string, string][] {
	return Object.entries(manifest.base_content?.retired ?? {}).filter(([id, path]) => baseId(id) && basePath(path) &&
		Array.isArray(manifest.deleted?.[path]) && manifest.deleted[path].includes(id));
}

export function parseBaseState(value: unknown, entryId: string): BaseContentState {
	if (!baseId(entryId) || !baseObject(value) || !baseObject(value.record)) return invalid();
	const { path, record, generation, content_version } = value;
	if (!basePath(path) ||
		record.id !== entryId || record.version !== 0 || record.type !== "file" ||
		generation !== null && !baseId(generation) || content_version !== null && !baseId(content_version) ||
		content_version !== null && (generation === null || !digest(record.hash)) ||
		record.hash !== undefined && !digest(record.hash) ||
		record.synctime !== undefined && (typeof record.synctime !== "number" || !Number.isSafeInteger(record.synctime) || record.synctime < 0) ||
		record.mimetype !== undefined && (typeof record.mimetype !== "string" || record.mimetype.length > 255)) return invalid();
	return { path, generation: generation as string | null, content_version: content_version as string | null,
		record: { id: entryId, version: 0, type: "file", ...(record.hash !== undefined ? { hash: record.hash as string } : {}),
			...(record.mimetype !== undefined ? { mimetype: record.mimetype as string } : {}),
			...(record.synctime !== undefined ? { synctime: record.synctime as number } : {}) } };
}

export function copyBaseBytes(value: ArrayBuffer): ArrayBuffer {
	// Cross-window ArrayBuffers need not share this realm's prototype.
	if (Object.prototype.toString.call(value) !== "[object ArrayBuffer]" || value.byteLength > BASE_CONTENT_LIMIT) return invalid();
	return new Uint8Array(value).slice().buffer;
}

export function encodeBaseBytes(value: ArrayBuffer): string {
	const bytes = new Uint8Array(copyBaseBytes(value));
	let raw = "";
	for (let offset = 0; offset < bytes.length; offset += 8192) raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	return btoa(raw);
}

export function decodeBaseBytes(value: unknown): ArrayBuffer {
	if (typeof value !== "string" || value.length > Math.ceil(BASE_CONTENT_LIMIT / 3) * 4 ||
		! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid();
	let raw: string;
	try { raw = atob(value); } catch { return invalid(); }
	if (raw.length > BASE_CONTENT_LIMIT) return invalid();
	return Uint8Array.from(raw, character => character.charCodeAt(0)).buffer;
}

export async function validateBaseSnapshot(snapshot: BaseSnapshot, entryId: string): Promise<BaseSnapshot> {
	const state = parseBaseState(snapshot.state, entryId);
	const context = parseBaseRestoreContext(snapshot.restoreContext?.supported, snapshot.restoreContext?.generation);
	const bytes = snapshot.bytes === null ? null : copyBaseBytes(snapshot.bytes);
	if (bytes === null ? state.record.hash !== undefined || state.content_version !== null :
		await sha256Hex(bytes) !== state.record.hash) return invalid();
	return { state, bytes, ...(context ? { restoreContext: context } : {}) };
}

export function parseBaseRestoreContext(supported: unknown, generation: unknown): RestoreContext | undefined {
	const context = restoreContext(supported, generation);
	if (context && context.generation !== null && !context.supported) return invalid();
	return context;
}

export function baseRestoreBinding(snapshot: BaseSnapshot): RestoreBinding {
	return snapshot.restoreContext ? { restoreGeneration: snapshot.restoreContext.generation } : {};
}

export async function parseBaseSnapshot(value: unknown, entryId: string): Promise<BaseSnapshot> {
	if (!baseObject(value) || value.protocol_version !== 1) return invalid();
	return validateBaseSnapshot({ state: parseBaseState(value.state, entryId),
		restoreContext: parseBaseRestoreContext(value.restore_guard, value.restore_generation),
		bytes: value.content_base64 === null ? null : decodeBaseBytes(value.content_base64) }, entryId);
}

export function copyBasePending(pending: BasePending, entryId: string): BasePending {
	if (!baseId(pending.operationId)) return invalid();
	return { operationId: pending.operationId, expected: parseBaseState(pending.expected, entryId), bytes: copyBaseBytes(pending.bytes), ...restoreMetadata(pending) };
}

export async function parseBaseAccepted(value: unknown, pending: BasePending, entryId: string): Promise<BaseAccepted> {
	pending = copyBasePending(pending, entryId);
	if (!baseObject(value) || value.protocol_version !== 1 || value.operation_id !== pending.operationId) return invalid();
	const state = parseBaseState(value.state, entryId);
	if (state.path !== pending.expected.path || !state.content_version || state.content_version === pending.expected.content_version ||
		pending.expected.generation !== null && state.generation !== pending.expected.generation ||
		state.record.hash !== await sha256Hex(pending.bytes) || state.record.mimetype !== "application/yaml" ||
		state.record.synctime === undefined) return invalid();
	return { operation_id: pending.operationId, state };
}

export type BaseDecision = "adopt" | "upload" | "download" | "wait" | "unknown-baseline" | "diverged" | "generation-changed" | "restore-changed" | "local-deletion" | "unpublished";

/** Timestamps never decide which bytes win. The host still guards identity,
 * access and local replacement; this function only compares observed content. */
export async function decideBaseSync(baseline: BaseSnapshot | undefined, localBytes: ArrayBuffer | null,
	remote: BaseSnapshot, canInitialize = false): Promise<BaseDecision> {
	const localCopy = localBytes === null ? null : copyBaseBytes(localBytes), entryId = remote.state.record.id;
	[baseline, remote] = await Promise.all([baseline ? validateBaseSnapshot(baseline, entryId) : undefined, validateBaseSnapshot(remote, entryId)]);
	const local = localCopy === null ? null : await sha256Hex(localCopy);
	const remoteHash = remote.bytes === null ? null : remote.state.record.hash;
	if (baseline && (baseline.restoreContext?.generation ?? null) !== (remote.restoreContext?.generation ?? null)) return "restore-changed";
	if (local === remoteHash) return local === null ? "wait" : "adopt";
	if (local === null) return baseline ? "local-deletion" : "download";
	if (!baseline && remote.restoreContext?.generation) return "restore-changed";
	if (remoteHash === null) return !baseline && canInitialize ? "upload" : "unpublished";
	if (!baseline) return "unknown-baseline";
	if (baseline.state.generation !== remote.state.generation && baseline.state.generation !== null) return "generation-changed";
	const baseHash = baseline.bytes === null ? null : baseline.state.record.hash;
	if (local === baseHash) return "download";
	if (remoteHash === baseHash) return "upload";
	return "diverged";
}
