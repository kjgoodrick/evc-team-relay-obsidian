import { sha256Hex } from "./contentDigest";
import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { sourceInstallationPath, verifySourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import { holdNativeSourceWrites } from "./storage/native-document-writes";
import { sourceInventoryCacheSync, type SourceInventoryIdentity } from "./storage/source-document-cache";
import type { SourceSelectionJournal } from "./storage/source-selection-journal";
import { borrowPausedSourceDrain } from "./storage/source-startup-admission";

export const INSTALLATION_METADATA = ".relay-source-installation";
export interface NativeInstallationStat { type: "file" | "folder"; size: number }
/** The host must atomically refuse existing files, publish complete bytes, refuse
 * links, and keep reads/listings bounded. Claim may create only a new root, or
 * reopen a root with the exact durable marker. No overwrite/delete capability. */
export interface SourceNativeInstallationIO {
	readonly root: string;
	readonly nativeWriteOwner: object;
	claim(marker: ArrayBuffer): Promise<void>;
	stat(path: string): Promise<NativeInstallationStat | null>;
	list(path: string, maxEntries: number): Promise<string[]>;
	readBinary(path: string, maxBytes: number): Promise<ArrayBuffer>;
	createDirectoryExclusive(path: string): Promise<void>;
	createFileExclusive(path: string, bytes: ArrayBuffer): Promise<void>;
}
export interface SourceMaterializationRequest {
	source: SourceInventoryIdentity;
	reviewId: string;
	revision: string;
	operationId: string;
}

/** Copy a prepared source into its new native folder, or resume an interrupted
 * copy. This deliberately leaves the journal applying and ordinary sync paused.
 * Cache/mapping installation, current server admission and final activation are
 * separate steps. The caller must isolate untracked host/process writers too. */
export async function materializeSourceInstallation(journal: SourceSelectionJournal, staging: RecoveryArchiveReader,
	native: SourceNativeInstallationIO, input: SourceMaterializationRequest, options: SourcePlanVerificationOptions = {}) {
	const request = { ...input, source: { ...input.source } }, checkContext = options.check, signal = options.signal, timeoutMs = options.timeoutMs;
	const check = () => {
		if (signal?.aborted) throw Object.assign(new Error("Source installation was cancelled"), { name: "AbortError" });
		checkContext?.();
	};
	const scope = sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity;
	if (journal.scopeIdentity !== scope) throw new Error("The installation journal belongs to another source");
	check(); let state = await journal.read(); check();
	const pending = state.pending;
	if (state.revision !== request.revision || pending?.reviewId !== request.reviewId
		|| pending.restoreGeneration !== request.source.restoreGeneration || !pending.preparation
		|| !["prepared", "applying"].includes(pending.phase)) throw new Error("The prepared source selection changed");
	const preparation = pending.preparation;
	const verified = await verifySourceInstallationPlan(staging, preparation.plan,
		{ source: request.source, reviewId: request.reviewId, archive: preparation.archive }, { check, signal, timeoutMs });
	const { plan } = verified, root = plan.destinationRoot, owner = native.nativeWriteOwner;
	if (native.root !== root) throw new Error("The native destination does not match the installation plan");
	const confirm = async () => {
		check();
		if (native.root !== root || native.nativeWriteOwner !== owner) throw new Error("The native installation host changed");
		const current = await journal.read(); check();
		if (current.revision !== state.revision) throw new Error("The source selection changed during installation");
	};
	const expected = new Map<string, "file" | "folder">([[root, "folder"]]);
	for (const entry of plan.entries) {
		let path = root;
		const parts = entry.path.split("/");
		for (let i = 0; i < parts.length; i++) {
			path += "/" + parts[i];
			expected.set(path, i === parts.length - 1 && entry.file ? "file" : "folder");
		}
	}
	const marker = new TextEncoder().encode(JSON.stringify({ format: "team-relay-native-installation", version: 1,
		plan: verified.reference, reviewId: plan.reviewId, scope, destinationRoot: root })).buffer;
	const originalHold = borrowPausedSourceDrain(owner, plan.originalRoot, plan.source) ?? holdNativeSourceWrites(owner, plan.originalRoot);
	let destinationHold: ReturnType<typeof holdNativeSourceWrites> | undefined;
	try {
		destinationHold = holdNativeSourceWrites(owner, root);
		await originalHold.wait({ check, signal, timeoutMs });
		await destinationHold.wait({ check, signal, timeoutMs });
		await confirm();
		if (state.pending!.phase === "prepared") {
			state = await journal.apply({ type: "start", expectedRevision: state.revision, operationId: request.operationId, reviewId: request.reviewId });
			await confirm();
		}
		// Never race a native mutation against cancellation: an OS operation may
		// still finish. Await it before releasing either registered-writer hold.
		const write = async (path: string, action: () => Promise<void>) => {
			await confirm(); await destinationHold!.write(path, () => { check(); return action(); }); await confirm();
		};
		await write(root, () => native.claim(marker));
		const inspect = async (complete: boolean) => {
			const folders = [root], seen = new Set<string>(); let visited = 0;
			while (folders.length) {
				const folder = folders.pop()!; await confirm();
				const children = await native.list(folder, Math.max(1, expected.size + 1 - visited)); await confirm();
				for (const name of children) {
					if (folder === root && name === INSTALLATION_METADATA) continue;
					if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || ++visited > expected.size) throw new Error("Invalid native installation directory listing");
					const path = `${folder}/${name}`, kind = expected.get(path);
					if (seen.has(path)) throw new Error("Duplicate native installation directory entry");
					seen.add(path); await confirm();
					const stat = await native.stat(path); await confirm();
					if (!kind || stat?.type !== kind) throw new Error("Unexpected or changed native installation content: " + path);
					if (kind === "folder") folders.push(path);
				}
			}
			if (complete && visited !== expected.size - 1) throw new Error("The native installation is incomplete");
		};
		await inspect(false);
		const directories = [...expected].filter(([path, kind]) => path !== root && kind === "folder");
		directories.sort(([a], [b]) => a.split("/").length - b.split("/").length);
		for (const [path] of directories) {
			await confirm(); const stat = await native.stat(path); await confirm();
			if (stat) { if (stat.type !== "folder") throw new Error("A file occupies an installation directory: " + path); }
			else await write(path, () => native.createDirectoryExclusive(path));
		}
		let created = 0, resumed = 0;
		const verifyFile = async (path: string, bytes: number, digest: string) => {
			await confirm(); const stat = await native.stat(path); await confirm();
			if (!stat || stat.type !== "file" || stat.size !== bytes) throw new Error("A native installation file is missing or changed: " + path);
			const data = await native.readBinary(path, bytes); await confirm();
			if (data.byteLength !== bytes || await sha256Hex(data) !== digest) throw new Error("A native installation file changed: " + path);
			await confirm();
		};
		for (const entry of plan.entries) {
			if (!entry.file) continue;
			const path = `${root}/${entry.path}`; await confirm();
			const existing = await native.stat(path); await confirm();
			if (existing) { await verifyFile(path, entry.file.bytes, entry.file.sha256); resumed++; continue; }
			const artifact = `${sourceInstallationPath(plan.id)}/files/${entry.record.id}.bin`;
			const stat = await staging.stat(artifact); await confirm();
			if (stat?.type !== "file" || stat.size !== entry.file.bytes) throw new Error("The staged native file changed: " + entry.path);
			const bytes = await staging.readBinary(artifact); await confirm();
			if (bytes.byteLength !== entry.file.bytes || await sha256Hex(bytes) !== entry.file.sha256) throw new Error("The staged native file digest changed: " + entry.path);
			await write(path, () => native.createFileExclusive(path, bytes));
			await verifyFile(path, entry.file.bytes, entry.file.sha256); created++;
		}
		await inspect(true);
		for (const entry of plan.entries) if (entry.file) await verifyFile(`${root}/${entry.path}`, entry.file.bytes, entry.file.sha256);
		await confirm();
		// Includes the retained original-work archive and source/native projections.
		await verifySourceInstallationPlan(staging, preparation.plan,
			{ source: request.source, reviewId: request.reviewId, archive: preparation.archive }, { check, signal, timeoutMs });
		await native.stat(root); await confirm();
		return { selection: state, reference: verified.reference, destinationRoot: root, created, resumed };
	} finally { destinationHold?.release(); originalHold.release(); }
}
