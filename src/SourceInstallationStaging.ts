import type { ManagedManifest } from "./client/ManagedIndexTransport";
import { sha256Hex } from "./contentDigest";
import { verifyRecoveryArchive, type RecoveryArchiveReference } from "./ManagedRecoveryArchive";
import type { RecoveryIO } from "./ManagedRecoveryBackup";
import { buildInstallationInventory, installationSourceBytes } from "./SourceInstallationContent";
import { encodeSourceInstallationPlan, parseSourceInstallationPlan, sourceInstallationPath, verifySourceInstallationPlan,
	type InstallationArtifact, type InstallationEntry, type SourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourceInventoryIdentity } from "./storage/source-document-cache";

export interface SourceInstallationStageIO extends RecoveryIO {
	/** Must fail if the destination already exists; never reuse or empty it. */
	createDirectoryExclusive(path: string): Promise<void>;
}
export interface SourceInstallationCapture {
	reviewId: string;
	source: SourceInventoryIdentity;
	archive: RecoveryArchiveReference;
	originalRoot: string;
	destinationRoot: string;
	snapshot: ManagedManifest;
}
export interface SourceInstallationDownloads {
	/** Read-only server downloads bound to this exact captured source generation.
	 * Implementations must enforce the supplied budget while receiving data. */
	source(entry: Readonly<InstallationEntry>, identity: Readonly<SourceInventoryIdentity>, maxBytes: number): Promise<Uint8Array>;
	attachment(entry: Readonly<InstallationEntry>, identity: Readonly<SourceInventoryIdentity>, maxBytes: number): Promise<ArrayBuffer>;
}
const MAX_SOURCE = 16 * 1024 * 1024, MAX_FILE = 256 * 1024 * 1024, MAX_TOTAL = 64 * 1024 ** 3;
const placeholder = (): InstallationArtifact => ({ bytes: 0, sha256: "0".repeat(64) });

/** Stage only into a new local recovery directory, one entry at a time. A
 * complete verified plan is returned only after readback/content verification.
 * Failures retain incomplete staging; no native destination/cache/journal is
 * modified and no returned artifact grants activation authority. */
export async function stageSourceInstallation(io: SourceInstallationStageIO, input: SourceInstallationCapture,
	downloads: SourceInstallationDownloads, options: SourcePlanVerificationOptions = {}) {
	// Freeze the reviewed metadata before any asynchronous operation. Download
	// callbacks receive detached copies and cannot change this staged manifest.
	const metadata = JSON.stringify(input);
	if (!metadata || new TextEncoder().encode(metadata).byteLength > 16 * 1024 * 1024) throw new Error("Installation capture metadata exceeds its size limit");
	const capture = JSON.parse(metadata) as SourceInstallationCapture;
	const readSource = downloads.source.bind(downloads), readAttachment = downloads.attachment.bind(downloads);
	if (!capture.snapshot?.records || typeof capture.snapshot.records !== "object" || Array.isArray(capture.snapshot.records)) throw new Error("Invalid captured installation inventory");
	const entries = Object.entries(capture.snapshot.records).map(([path, record]): InstallationEntry => ({ path, record,
		...(record?.type === "folder" ? {} : { file: record?.type === "markdown" || record?.type === "canvas" ? placeholder() : { bytes: 0, sha256: record?.hash ?? "" } }),
		...(record?.type === "markdown" || record?.type === "canvas" ? { source: placeholder() } : {}),
	}));
	const plan: SourceInstallationPlan = parseSourceInstallationPlan({ format: "team-relay-source-installation", version: 1, id: crypto.randomUUID(),
		reviewId: capture.reviewId, source: capture.source, archive: capture.archive, originalRoot: capture.originalRoot,
		destinationRoot: capture.destinationRoot, mode: "new-folder", inventory: placeholder(), entries });
	const inventory = new Uint8Array(buildInstallationInventory(plan, capture.snapshot)).buffer;
	const checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid installation staging timeout");
	const cancelled = () => Object.assign(new Error("Source installation staging was cancelled"), { name: "AbortError" });
	const check = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Source installation staging timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const value = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), interrupted]); check(); return value; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	const describe = async (bytes: ArrayBuffer): Promise<InstallationArtifact> => ({ bytes: bytes.byteLength, sha256: await bounded(() => sha256Hex(bytes)) });
	let total = inventory.byteLength;
	const account = (size: number, limit: number) => {
		if (!Number.isSafeInteger(size) || size < 0 || size > limit || total + size > MAX_TOTAL) throw new Error("Installation staging exceeds its size limit");
		total += size;
	};
	check();
	await verifyRecoveryArchive(io, plan.archive, { check, signal, timeoutMs: timeout });
	const root = sourceInstallationPath(plan.id);
	await bounded(() => io.mkdir(root.slice(0, root.lastIndexOf("/"))));
	await bounded(() => io.createDirectoryExclusive(root));
	await bounded(() => io.mkdir(`${root}/files`)); await bounded(() => io.mkdir(`${root}/sources`));
	plan.inventory = await describe(inventory);
	await bounded(() => io.writeBinary(`${root}/inventory.yjs`, inventory));
	for (const entry of plan.entries) {
		if (entry.record.type === "folder") continue;
		const detached = () => JSON.parse(JSON.stringify(entry)) as InstallationEntry;
		let native: ArrayBuffer;
		if (entry.source) {
			const received = await bounded(() => readSource(detached(), Object.freeze({ ...plan.source }), MAX_SOURCE));
			account(received.byteLength, MAX_SOURCE);
			const update = new Uint8Array(received), source = update.buffer;
			native = installationSourceBytes(entry.record.type as "markdown" | "canvas", update);
			account(native.byteLength, MAX_SOURCE); entry.source = await describe(source);
			await bounded(() => io.writeBinary(`${root}/sources/${entry.record.id}.yjs`, source));
		} else {
			const received = await bounded(() => readAttachment(detached(), Object.freeze({ ...plan.source }), MAX_FILE));
			account(received.byteLength, MAX_FILE);
			native = ArrayBuffer.prototype.slice.call(received, 0) as ArrayBuffer;
		}
		entry.file = await describe(native);
		if (!entry.source && entry.file.sha256 !== entry.record.hash) throw new Error("The staged attachment no longer matches the captured inventory");
		await bounded(() => io.writeBinary(`${root}/files/${entry.record.id}.bin`, native));
	}
	const encoded = await bounded(() => encodeSourceInstallationPlan(plan));
	await bounded(() => io.writeBinary(`${root}/plan.json`, encoded.bytes));
	const verified = await verifySourceInstallationPlan(io, encoded.reference, { source: plan.source, reviewId: plan.reviewId, archive: plan.archive }, { check, signal, timeoutMs: timeout });
	check(); return { ...verified, path: root };
}
