import { RECOVERY_FOLDER } from "./conflictCopyPath";
import { sha256Hex } from "./contentDigest";

export interface RecoveryArchiveReference { path: string; manifestSha256: string }
export interface RecoveryArchiveFile { path: string; bytes: number; sha256: string }
export interface RecoveryArchiveReader {
	stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null>;
	readBinary(path: string): Promise<ArrayBuffer>;
}
export interface RecoveryArchiveVerification {
	check?: () => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
	maxFiles?: number;
	maxManifestBytes?: number;
}
const limits = { timeoutMs: 30_000, maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 64 * 1024 ** 3, maxFiles: 100_000, maxManifestBytes: 32 * 1024 * 1024 };
const hashPattern = /^[a-f0-9]{64}$/;

export function requireRecoveryRelativePath(path: string): void {
	if (typeof path !== "string" || !path || path.length > 4096 || /^[a-z]:/i.test(path) || path.includes("\\")
		|| [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		|| path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Recovery file has an unsafe relative path");
}
export function recoveryCompletionText(manifestSha256: string): string {
	return `Original file bytes, local editing history, and inventory saved and read back. This folder stays on this device.\nManifest SHA-256: ${manifestSha256}\nVerify manifest.json and every listed file before recovery.\n`;
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function parseManifest(bytes: ArrayBuffer, maxFiles: number, maxFileBytes: number, maxTotalBytes: number): { files: RecoveryArchiveFile[]; totalBytes: number } {
	const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!exactKeys(value, ["format", "version", "files"]) || value.format !== "team-relay-local-recovery" || value.version !== 1
		|| !Array.isArray(value.files) || value.files.length < 2 || value.files.length > maxFiles) throw new Error("Unsupported or invalid recovery manifest");
	const names = new Set<string>(); let totalBytes = 0;
	const files = value.files.map((file: unknown): RecoveryArchiveFile => {
		if (!exactKeys(file, ["path", "bytes", "sha256"]) || typeof file.path !== "string" || typeof file.bytes !== "number"
			|| !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maxFileBytes || typeof file.sha256 !== "string" || !hashPattern.test(file.sha256)) throw new Error("Invalid or oversized recovery artifact");
		requireRecoveryRelativePath(file.path);
		const valid = file.path === "inventory.yjs" || file.path === "recovery.json" || file.path.startsWith("files/")
			|| /^documents\/[a-z0-9][a-z0-9_-]{0,127}(?:\/relay-source-v1-[a-f0-9]{64})?\.(?:yjs|txt|unsaved\.txt|stored-unsaved\.txt|cache\.json)$/i.test(file.path)
			|| /^inventories\/relay-inventory-v1-[a-f0-9]{64}\.(?:yjs|cache\.json)$/.test(file.path);
		if (!valid) throw new Error("Unsupported recovery artifact path");
		const name = file.path.normalize("NFC").toLowerCase();
		if (names.has(name)) throw new Error("Recovery manifest contains colliding paths");
		names.add(name); totalBytes += file.bytes;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) throw new Error("Recovery archive exceeds the verification size limit");
		return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
	});
	for (const name of names) for (let slash = name.indexOf("/"); slash >= 0; slash = name.indexOf("/", slash + 1)) {
		if (names.has(name.slice(0, slash))) throw new Error("Recovery manifest contains a file/directory collision");
	}
	if (!names.has("inventory.yjs") || !names.has("recovery.json")) throw new Error("Recovery manifest is incomplete");
	return { files, totalBytes };
}

/** Reopen an archive without its original capture closure. The manifest digest
 * must come from the caller's retained reference, never from the archive being
 * checked. This proves saved bytes, not source freshness or permission to write.
 * Reads are sequential and bounded; no native file or source cache is modified. */
export async function verifyRecoveryArchive(io: RecoveryArchiveReader, input: RecoveryArchiveReference, options: RecoveryArchiveVerification = {}) {
	const { reference, fileCount, totalBytes } = await inspectRecoveryArchive(io, input, options);
	return { reference, fileCount, totalBytes };
}

/** Explicit metadata inspection for recovery comparison. Returned immutable
 * descriptors are observations bound to the verified manifest, not permission
 * to overwrite live files. Ordinary verification retains its summary-only API. */
export async function inspectRecoveryArchive(io: RecoveryArchiveReader, input: RecoveryArchiveReference, options: RecoveryArchiveVerification = {}) {
	const reference = { path: input?.path, manifestSha256: input?.manifestSha256 };
	requireRecoveryRelativePath(reference.path);
	if (!reference.path.startsWith(RECOVERY_FOLDER + "/") || reference.path.length > 2048 || reference.path.includes(":")
		|| typeof reference.manifestSha256 !== "string" || !hashPattern.test(reference.manifestSha256)) throw new Error("Invalid recovery archive reference");
	const bound = { ...limits };
	for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
		const value = options[key] ?? limits[key];
		if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new Error("Invalid recovery verification limit");
		bound[key] = value;
	}
	const checkContext = options.check, signal = options.signal;
	const check = () => {
		if (signal?.aborted) throw Object.assign(new Error("Recovery verification was cancelled"), { name: "AbortError" });
		checkContext?.();
	};
	const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Recovery archive reading timed out")), bound.timeoutMs);
			abort = () => reject(Object.assign(new Error("Recovery verification was cancelled"), { name: "AbortError" }));
			signal?.addEventListener("abort", abort, { once: true });
		});
		try { const result = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), interrupted]); check(); return result; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	const read = async (path: string, maxBytes: number, expectedBytes?: number): Promise<ArrayBuffer> => {
		const full = `${reference.path}/${path}`, stat = await bounded(() => io.stat(full));
		if (!stat || stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes
			|| expectedBytes !== undefined && stat.size !== expectedBytes) throw new Error(`Recovery file verification failed: ${path}`);
		const actual = await bounded(() => io.readBinary(full));
		if (actual.byteLength !== stat.size || actual.byteLength > maxBytes) throw new Error(`Recovery file verification failed: ${path}`);
		// Native adapters can return a buffer from the main window to a popout.
		// The built-in slice validates the buffer without a realm-local instanceof.
		return ArrayBuffer.prototype.slice.call(actual, 0) as ArrayBuffer;
	};
	const digest = async (bytes: ArrayBuffer) => { const hash = await bounded(() => sha256Hex(bytes)); check(); return hash; };
	const manifest = await read("manifest.json", bound.maxManifestBytes);
	if (await digest(manifest) !== reference.manifestSha256) throw new Error("Recovery manifest no longer matches its saved reference");
	const { files, totalBytes } = parseManifest(manifest, bound.maxFiles, bound.maxFileBytes, bound.maxTotalBytes);
	const completion = new TextEncoder().encode(recoveryCompletionText(reference.manifestSha256));
	const verifyCompletion = async () => {
		const actual = new Uint8Array(await read("BACKUP-COMPLETE.txt", completion.byteLength, completion.byteLength));
		if (!actual.every((byte, index) => byte === completion[index])) throw new Error("Recovery completion marker does not match its saved reference");
	};
	await verifyCompletion();
	for (const file of files) {
		const bytes = await read(file.path, bound.maxFileBytes, file.bytes);
		if (await digest(bytes) !== file.sha256) throw new Error(`Recovery file verification failed: ${file.path}`);
	}
	// Detect a replaced manifest/marker while sequential artifact reads ran.
	if (await digest(await read("manifest.json", bound.maxManifestBytes, manifest.byteLength)) !== reference.manifestSha256) throw new Error("Recovery manifest changed during verification");
	await verifyCompletion(); check();
	return { reference: Object.freeze(reference), fileCount: files.length, totalBytes,
		files: Object.freeze(files.map(file => Object.freeze({ ...file }))) };
}
