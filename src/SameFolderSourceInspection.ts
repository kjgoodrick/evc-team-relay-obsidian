import { sha256Hex } from "./contentDigest";
import { requireRecoveryRelativePath, type RecoveryArchiveReader, type RecoveryArchiveReference } from "./ManagedRecoveryArchive";
import { verifySourceInstallationPlan, type InstallationArtifact, type SourceInstallationReference, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourceInventoryIdentity } from "./storage/source-document-cache";

type NativeItem = { type: "folder" } | { type: "file"; file: InstallationArtifact };
export interface SameFolderInspectionRow {
	path: string;
	current?: NativeItem;
	archived?: InstallationArtifact;
	selected?: NativeItem;
	entryId?: string;
	change: "unchanged" | "create" | "replace" | "local-only" | "absent" | "type-conflict";
	backupStatus: "matches-backup" | "changed-since-backup" | "not-backed-up" | "absent" | "directory";
	/** Includes case/Unicode aliases and file/directory conflicts in ancestors. */
	pathConflict: boolean;
}
/** Read-only host capability. Bind reads to one vault/root identity, refuse
 * symlinks and non-regular files, and enforce maxBytes during stable reads.
 * list returns immediate basenames and must stop at maxEntries, not truncate. */
export interface SameFolderInspectionIO {
	readonly root: string;
	stat(path: string): Promise<{ type: "file" | "folder"; size: number } | null>;
	list(path: string, maxEntries: number): Promise<string[]>;
	readBinary(path: string, maxBytes: number): Promise<ArrayBuffer>;
}
export interface SameFolderInspectionOptions extends SourcePlanVerificationOptions {
	maxNativeEntries?: number;
	maxFileBytes?: number;
	maxTotalBytes?: number;
}
const bounds = { maxNativeEntries: 100_000, maxFileBytes: 256 * 1024 * 1024, maxTotalBytes: 64 * 1024 ** 3 };
const equal = (a?: InstallationArtifact, b?: InstallationArtifact) => !!a && !!b && a.bytes === b.bytes && a.sha256 === b.sha256;
const folded = (path: string) => path.normalize("NFC").toLowerCase();

/** Compare a verified selected source with archived originals and current
 * native files, without creating a second working folder or changing any file.
 * Results are observations, NOT a write plan or proof of an atomic snapshot.
 * Application must bind reviewed choices and revalidate before every mutation;
 * local-only files are never inferred to be deletions from their absent target. */
export async function inspectSameFolderSource(staging: RecoveryArchiveReader, native: SameFolderInspectionIO,
	input: SourceInstallationReference,
	expected: { source: SourceInventoryIdentity; reviewId: string; archive: RecoveryArchiveReference },
	options: SameFolderInspectionOptions = {}) {
	const reference = { ...input }, captured = { source: { ...expected.source }, reviewId: expected.reviewId, archive: { ...expected.archive } };
	const root = native.root, stat = native.stat.bind(native), list = native.list.bind(native), read = native.readBinary.bind(native);
	const checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid same-folder inspection timeout");
	const limits = { ...bounds };
	for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
		const value = options[key] ?? bounds[key];
		if (!Number.isSafeInteger(value) || value < 1 || value > bounds[key]) throw new Error("Invalid same-folder inspection limit");
		limits[key] = value;
	}
	const cancelled = () => Object.assign(new Error("Same-folder inspection was cancelled"), { name: "AbortError" });
	const check = () => {
		if (signal?.aborted) throw cancelled();
		if (native.root !== root) throw new Error("The native inspection location changed");
		checkContext?.();
	};
	const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Same-folder inspection timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const value = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), interrupted]); check(); return value; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	const verified = await verifySourceInstallationPlan(staging, reference, captured, { check, signal, timeoutMs: timeout });
	const { plan } = verified;
	if (plan.mode !== "existing-folder" || plan.originalRoot !== root) throw new Error("This comparison requires the reviewed existing folder");
	const archived = new Map<string, InstallationArtifact>(), selected = new Map<string, NativeItem>(), ids = new Map<string, string>();
	const prefix = `files/${root}/`;
	for (const file of verified.archiveFiles) if (file.path.startsWith(prefix)) {
		const path = file.path.slice(prefix.length); requireRecoveryRelativePath(path);
		archived.set(path, { bytes: file.bytes, sha256: file.sha256 });
	}
	for (const entry of plan.entries) {
		const parts = entry.path.split("/");
		for (let i = 1; i < parts.length; i++) selected.set(parts.slice(0, i).join("/"), { type: "folder" });
		selected.set(entry.path, entry.file ? { type: "file", file: { ...entry.file } } : { type: "folder" });
		ids.set(entry.path, entry.record.id);
	}
	if ((await bounded(() => stat(root)))?.type !== "folder") throw new Error("The original working folder is missing or changed");
	const current = new Map<string, NativeItem>(), folders = [""];
	let count = 0, totalBytes = 0, nativeComponents = 0;
	while (folders.length) {
		const folder = folders.pop()!, full = folder ? `${root}/${folder}` : root;
		const remaining = limits.maxNativeEntries - count;
		const names = await bounded(() => list(full, Math.max(1, remaining + 1)));
		if (!Array.isArray(names) || names.length > remaining) throw new Error("The working folder exceeds the inspection entry limit");
		const seen = new Set<string>();
		for (const name of names) {
			if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || seen.has(name)) throw new Error("Invalid native inspection directory listing");
			seen.add(name); const path = folder ? `${folder}/${name}` : name;
			requireRecoveryRelativePath(path);
			if (new TextEncoder().encode(`${root}/${path}`).byteLength > 4096) throw new Error("The native inspection path is too long");
			nativeComponents += path.split("/").length;
			if (nativeComponents > 1_000_000) throw new Error("The native inspection exceeds the path component limit");
			count++;
			const target = `${root}/${path}`, item = await bounded(() => stat(target));
			if (!item || item.type !== "folder" && item.type !== "file") throw new Error("The native inspection entry is missing or changed: " + path);
			if (item.type === "folder") { current.set(path, { type: "folder" }); folders.push(path); continue; }
			if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > limits.maxFileBytes || totalBytes + item.size > limits.maxTotalBytes) throw new Error("The working folder exceeds the inspection byte limit");
			totalBytes += item.size;
			const received = await bounded(() => read(target, item.size));
			const bytes = ArrayBuffer.prototype.slice.call(received, 0) as ArrayBuffer;
			if (bytes.byteLength !== item.size) throw new Error("A native file changed during inspection: " + path);
			current.set(path, { type: "file", file: { bytes: bytes.byteLength, sha256: await bounded(() => sha256Hex(bytes)) } });
		}
	}
	const paths = new Set([...archived.keys(), ...selected.keys(), ...current.keys()]);
	if (paths.size > 100_000) throw new Error("The comparison exceeds the path count limit");
	// A name can collide through a parent even when no full file paths collide.
	const spellings = new Map<string, string>(), aliases = new Set<string>();
	let components = 0;
	for (const path of paths) {
		const parts = path.split("/"); components += parts.length;
		if (components > 1_000_000) throw new Error("The comparison exceeds the path component limit");
		let name = "";
		for (const part of parts) {
			name = name ? `${name}/${part}` : part;
			const key = folded(name), previous = spellings.get(key);
			if (previous !== undefined && previous !== name) aliases.add(key);
			else {
				if (previous === undefined && spellings.size >= 100_000) throw new Error("The comparison exceeds the path count limit");
				spellings.set(key, name);
			}
		}
	}
	const obstructions = new Set([...selected].filter(([path, item]) => current.has(path) && current.get(path)!.type !== item.type).map(([path]) => folded(path)));
	const rows: SameFolderInspectionRow[] = [...paths].sort().map(path => {
		const local = current.get(path), saved = archived.get(path), target = selected.get(path);
		let change: SameFolderInspectionRow["change"];
		if (!local) change = target ? "create" : "absent";
		else if (!target) change = "local-only";
		else if (local.type !== target.type) change = "type-conflict";
		else change = local.type === "folder" || target.type === "file" && equal(local.file, target.file) ? "unchanged" : "replace";
		const backupStatus: SameFolderInspectionRow["backupStatus"] = saved
			? local?.type === "file" && equal(local.file, saved) ? "matches-backup" : "changed-since-backup"
			: !local ? "absent" : local.type === "folder" ? "directory" : "not-backed-up";
		let prefix = "";
		const pathConflict = path.split("/").some(part => {
			prefix = prefix ? `${prefix}/${part}` : part;
			return aliases.has(folded(prefix)) || obstructions.has(folded(prefix));
		});
		return { path, change, backupStatus, pathConflict, ...(local ? { current: local } : {}), ...(saved ? { archived: saved } : {}),
			...(target ? { selected: target } : {}), ...(ids.has(path) ? { entryId: ids.get(path)! } : {}) };
	});
	if ((await bounded(() => stat(root)))?.type !== "folder") throw new Error("The original working folder changed during inspection");
	check();
	return { plan: verified.reference, root, rows, nativeEntries: count, nativeBytes: totalBytes };
}
