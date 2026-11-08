import type { ItemRecord } from "./ItemKinds";
import { RECOVERY_FOLDER } from "./conflictCopyPath";
import { sha256Hex } from "./contentDigest";
import { restoreGeneration } from "./collaboration/RestoreGeneration";
import { verifyRecoveryArchive, type RecoveryArchiveReader, type RecoveryArchiveReference } from "./ManagedRecoveryArchive";
import { sourceInventoryCacheSync, type SourceInventoryIdentity } from "./storage/source-document-cache";

export interface InstallationArtifact { bytes: number; sha256: string }
export interface InstallationEntry {
	path: string;
	record: ItemRecord;
	file?: InstallationArtifact;
	source?: InstallationArtifact;
}
export interface SourceInstallationPlan {
	format: "team-relay-source-installation";
	version: 1;
	id: string;
	reviewId: string;
	source: SourceInventoryIdentity;
	archive: RecoveryArchiveReference;
	originalRoot: string;
	destinationRoot: string;
	mode: "new-folder";
	inventory: InstallationArtifact;
	entries: InstallationEntry[];
}
export interface SourceInstallationReference { id: string; sha256: string }
export interface SourcePlanVerificationOptions { check?: () => void; signal?: AbortSignal; timeoutMs?: number }
const MAX_PLAN = 16 * 1024 * 1024, MAX_SOURCE = 16 * 1024 * 1024, MAX_FILE = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000, MAX_TOTAL = 64 * 1024 ** 3, hashPattern = /^[a-f0-9]{64}$/;
const fail = () => new Error("Invalid or unsupported source installation plan");
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
		|| keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw fail();
}
function uuid(value: unknown): string {
	const id = restoreGeneration(value);
	if (id === null || id !== value) throw fail();
	return id;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !hashPattern.test(value)) throw fail();
	return value;
}
const key = (path: string) => path.normalize("NFC").toLowerCase();
function path(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 2048 || value.normalize("NFC") !== value
		|| /[\\:<>"|?*]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		|| value.split("/").some(part => !part || new TextEncoder().encode(part).byteLength > 255 || part.startsWith(".") || /[. ]$/.test(part)
			|| /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw fail();
	return value;
}
const overlaps = (a: string, b: string) => key(a) === key(b) || key(a).startsWith(key(b) + "/") || key(b).startsWith(key(a) + "/");
function artifact(value: unknown, limit = MAX_FILE): InstallationArtifact {
	exact(value, ["bytes", "sha256"]);
	if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > limit) throw fail();
	return { bytes: value.bytes, sha256: digest(value.sha256) };
}
function record(value: unknown): ItemRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
	const input = value as Record<string, unknown>;
	const plain = ["folder", "markdown", "canvas"].includes(String(input.type));
	exact(input, plain ? ["id", "type", "version"] : ["id", "type", "version", "hash", "synctime", "mimetype"]);
	if (input.version !== 0 || !["folder", "markdown", "canvas", "image", "pdf", "audio", "video", "file"].includes(String(input.type))) throw fail();
	uuid(input.id);
	if (!plain && (typeof input.synctime !== "number" || !Number.isSafeInteger(input.synctime) || input.synctime < 0
		|| typeof input.mimetype !== "string" || !input.mimetype || input.mimetype.length > 255)) throw fail();
	if (!plain) digest(input.hash);
	return { ...input } as unknown as ItemRecord;
}

/** Metadata validation only. Hashes bind reviewed artifacts; they do not prove
 * current server authority, complete Yjs dependencies or native writer isolation. */
export function parseSourceInstallationPlan(value: unknown): SourceInstallationPlan {
	exact(value, ["format", "version", "id", "reviewId", "source", "archive", "originalRoot", "destinationRoot", "mode", "inventory", "entries"]);
	if (value.format !== "team-relay-source-installation" || value.version !== 1 || value.mode !== "new-folder"
		|| !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw fail();
	exact(value.source, ["hostAppId", "serverId", "controlPlaneUrl", "s3rn", "restoreGeneration"]);
	const source = { ...value.source } as unknown as SourceInventoryIdentity;
	if (source.restoreGeneration === undefined || source.restoreGeneration !== null && uuid(source.restoreGeneration) !== source.restoreGeneration) throw fail();
	const descriptor = sourceInventoryCacheSync(source);
	if (JSON.parse(descriptor.identity).controlPlaneUrl !== source.controlPlaneUrl) throw fail();
	exact(value.archive, ["path", "manifestSha256"]);
	const archive = { path: path(value.archive.path), manifestSha256: digest(value.archive.manifestSha256) };
	if (!archive.path.startsWith(RECOVERY_FOLDER + "/")) throw fail();
	const originalRoot = path(value.originalRoot), destinationRoot = path(value.destinationRoot);
	if (overlaps(originalRoot, destinationRoot) || overlaps(originalRoot, RECOVERY_FOLDER) || overlaps(destinationRoot, RECOVERY_FOLDER)) throw fail();
	if ([originalRoot, destinationRoot].some(root => root.split("/").some(part => key(part) === key(RECOVERY_FOLDER)))) throw fail();
	const inventory = artifact(value.inventory, MAX_SOURCE), ids = new Set<string>(), names = new Map<string, string>(), spellings = new Map<string, string>();
	let total = inventory.bytes;
	const entries = value.entries.map((input): InstallationEntry => {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw fail();
		const row = input as Record<string, unknown>, entryRecord = record(row.record);
		const folder = entryRecord.type === "folder", editing = entryRecord.type === "markdown" || entryRecord.type === "canvas";
		exact(row, ["path", "record", ...(folder ? [] : ["file"]), ...(editing ? ["source"] : [])]);
		const name = path(row.path);
		if (name.split("/").some(part => key(part) === key(RECOVERY_FOLDER)) || names.has(key(name)) || ids.has(entryRecord.id)) throw fail();
		if (destinationRoot.length + 1 + name.length > 4096) throw fail();
		const parts = name.split("/");
		for (let count = 1; count <= parts.length; count++) {
			const prefix = parts.slice(0, count).join("/"), previous = spellings.get(key(prefix));
			if (previous !== undefined && previous !== prefix) throw fail();
			spellings.set(key(prefix), prefix);
		}
		names.set(key(name), entryRecord.type); ids.add(entryRecord.id);
		const file = folder ? undefined : artifact(row.file), update = editing ? artifact(row.source, MAX_SOURCE) : undefined;
		if (!folder && !editing && file!.sha256 !== entryRecord.hash) throw fail();
		total += (file?.bytes ?? 0) + (update?.bytes ?? 0);
		if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw fail();
		return { path: name, record: entryRecord, ...(file ? { file } : {}), ...(update ? { source: update } : {}) };
	});
	for (const name of names.keys()) for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
		if (names.has(name.slice(0, slash)) && names.get(name.slice(0, slash)) !== "folder") throw fail();
	}
	return { format: value.format, version: 1, id: uuid(value.id), reviewId: uuid(value.reviewId), source, archive,
		originalRoot, destinationRoot, mode: "new-folder", inventory, entries };
}

/** A deterministic staging location; arbitrary manifest paths never become
 * staging paths. No file is written or source selection changed by this API. */
export function sourceInstallationPath(id: string): string {
	return `${RECOVERY_FOLDER}/Source installations/${uuid(id)}`;
}
export function sourceInstallationArtifacts(plan: SourceInstallationPlan): { path: string; artifact: InstallationArtifact }[] {
	const parsed = parseSourceInstallationPlan(plan);
	return [{ path: "inventory.yjs", artifact: parsed.inventory }, ...parsed.entries.flatMap(entry => [
		...(entry.file ? [{ path: `files/${entry.record.id}.bin`, artifact: entry.file }] : []),
		...(entry.source ? [{ path: `sources/${entry.record.id}.yjs`, artifact: entry.source }] : []),
	])];
}
export async function encodeSourceInstallationPlan(input: SourceInstallationPlan) {
	const plan = parseSourceInstallationPlan(input), bytes = new TextEncoder().encode(JSON.stringify(plan)).buffer;
	if (bytes.byteLength > MAX_PLAN) throw fail();
	const reference = Object.freeze({ id: plan.id, sha256: await sha256Hex(bytes) });
	return { reference, bytes };
}

/** Reopen against the exact digest retained by the journal. Verification is
 * read-only and returns data, never permission to install or activate it. The
 * caller must still validate source semantics/freshness at its write boundary. */
export async function verifySourceInstallationPlan(io: RecoveryArchiveReader, input: SourceInstallationReference,
	expected: { source: SourceInventoryIdentity; reviewId: string; archive: RecoveryArchiveReference }, options: SourcePlanVerificationOptions = {}) {
	const reference = Object.freeze({ id: uuid(input?.id), sha256: digest(input?.sha256) });
	const scopeIdentity = sourceInventoryCacheSync({ ...expected.source }).identity, reviewId = uuid(expected.reviewId);
	const archiveReference = { ...expected.archive };
	const root = sourceInstallationPath(reference.id), checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw fail();
	const cancelled = () => Object.assign(new Error("Source installation verification was cancelled"), { name: "AbortError" });
	const check = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Source installation verification timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const result = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), interrupted]); check(); return result; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	const read = async (name: string, maxBytes: number, expectedSize?: number) => {
		const file = `${root}/${name}`, stat = await bounded(() => io.stat(file));
		if (!stat || stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes
			|| expectedSize !== undefined && stat.size !== expectedSize) throw new Error("Missing or changed installation artifact: " + name);
		const bytes = await bounded(() => io.readBinary(file));
		if (bytes.byteLength !== stat.size) throw new Error("Installation artifact changed during reading: " + name);
		return ArrayBuffer.prototype.slice.call(bytes, 0) as ArrayBuffer;
	};
	const hash = (bytes: ArrayBuffer) => bounded(() => sha256Hex(bytes));
	const bytes = await read("plan.json", MAX_PLAN);
	if (await hash(bytes) !== reference.sha256) throw new Error("Installation plan no longer matches its saved reference");
	const plan = parseSourceInstallationPlan(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
	if (plan.id !== reference.id || plan.reviewId !== reviewId || sourceInventoryCacheSync(plan.source).identity !== scopeIdentity
		|| plan.archive.path !== archiveReference.path || plan.archive.manifestSha256 !== archiveReference.manifestSha256) throw new Error("Installation plan belongs to another source review or recovery archive");
	await verifyRecoveryArchive(io, archiveReference, { check, signal, timeoutMs: timeout });
	let totalBytes = 0;
	const artifacts = sourceInstallationArtifacts(plan);
	for (const { path: name, artifact: expectedArtifact } of artifacts) {
		const bytes = await read(name, expectedArtifact.bytes, expectedArtifact.bytes);
		if (await hash(bytes) !== expectedArtifact.sha256) throw new Error("Installation artifact digest mismatch: " + name);
		totalBytes += expectedArtifact.bytes;
	}
	if (await hash(await read("plan.json", MAX_PLAN, bytes.byteLength)) !== reference.sha256) throw new Error("Installation plan changed during verification");
	check(); return { reference, plan, artifactCount: artifacts.length, totalBytes };
}
