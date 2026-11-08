import type { ManagedManifest } from "./client/ManagedIndexTransport";
import { same } from "./client/managedRecovery";
import { installationManifest } from "./SourceInstallationContent";
import { stageSourceInstallation, type SourceInstallationCapture, type SourceInstallationDownloads, type SourceInstallationStageIO } from "./SourceInstallationStaging";
import type { SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import { sourceInventoryCacheSync, type SourceInventoryIdentity } from "./storage/source-document-cache";
import type { SourceSelectionJournal } from "./storage/source-selection-journal";
import { restoreGeneration } from "./collaboration/RestoreGeneration";

export interface SourcePreparationRequest extends SourceInstallationCapture {
	reviewRevision: string;
	operationId: string;
}
export interface SourcePreparationDownloads extends SourceInstallationDownloads {
	/** Fresh, authenticated read for the same captured endpoint/account/folder.
	 * Must not adopt a new generation or apply the returned inventory. */
	revalidate(identity: Readonly<SourceInventoryIdentity>): Promise<ManagedManifest>;
}

/** Connect verified staging to the journal's review -> prepared transition.
 * This cannot start installation or release source admission. A rejected or
 * uncertain commit must be reconciled by reading the durable journal, not by
 * recreating files or blindly retrying a new preparation. */
export async function prepareSourceInstallation(journal: SourceSelectionJournal, io: SourceInstallationStageIO,
	input: SourcePreparationRequest, downloads: SourcePreparationDownloads, options: SourcePlanVerificationOptions = {}) {
	const metadata = JSON.stringify(input);
	if (!metadata || new TextEncoder().encode(metadata).byteLength > 16 * 1024 * 1024) throw new Error("Source preparation metadata exceeds its size limit");
	const captured = JSON.parse(metadata) as SourcePreparationRequest;
	if (!captured.reviewRevision || restoreGeneration(captured.reviewRevision) !== captured.reviewRevision
		|| !captured.operationId || restoreGeneration(captured.operationId) !== captured.operationId) throw new Error("Invalid source preparation operation");
	const identity = sourceInventoryCacheSync({ ...captured.source, restoreGeneration: null }).identity;
	if (journal.scopeIdentity !== identity) throw new Error("The recovery journal belongs to another source");
	const checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid preparation timeout");
	const cancelled = () => Object.assign(new Error("Source preparation was cancelled"), { name: "AbortError" });
	const check = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const confirmJournal = async () => {
		check(); const state = await journal.read(); check();
		if (state.revision !== captured.reviewRevision || state.pending?.reviewId !== captured.reviewId || state.pending.phase !== "review"
			|| state.pending.restoreGeneration !== captured.source.restoreGeneration) throw new Error("The source review changed. Reload its saved decision before preparing again.");
	};
	const source = downloads.source.bind(downloads), attachment = downloads.attachment.bind(downloads), revalidate = downloads.revalidate.bind(downloads);
	await confirmJournal();
	const staged = await stageSourceInstallation(io, captured, {
		source: async (...args) => { await confirmJournal(); const result = await source(...args); await confirmJournal(); return result; },
		attachment: async (...args) => { await confirmJournal(); const result = await attachment(...args); await confirmJournal(); return result; },
	}, { check, signal, timeoutMs: timeout });
	await confirmJournal();
	let timer: number | undefined, abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		timer = window.setTimeout(() => reject(new Error("Rechecking the installation inventory timed out")), timeout);
		abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
	});
	let fresh: ManagedManifest;
	try { check(); fresh = await Promise.race([Promise.resolve().then(() => { check(); return revalidate(Object.freeze({ ...captured.source })); }), interrupted]); check(); }
	finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	if (!same(installationManifest(staged.plan, fresh), staged.inventorySnapshot)) throw new Error("The server inventory changed during preparation. Retained work is unchanged; refresh the review.");
	await confirmJournal(); check();
	const selection = await journal.apply({ type: "prepare", operationId: captured.operationId, expectedRevision: captured.reviewRevision,
		reviewId: captured.reviewId, preparation: { archive: { ...staged.plan.archive }, plan: { ...staged.reference } } });
	check(); return { selection, staged };
}
