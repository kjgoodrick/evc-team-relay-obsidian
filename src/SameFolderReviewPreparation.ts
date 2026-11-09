import { sha256Hex } from "./contentDigest";
import type { RecoveryArchiveReader, RecoveryArchiveReference } from "./ManagedRecoveryArchive";
import { createSameFolderReview, encodeSameFolderReview, MAX_NATIVE_REVIEW_BYTES, parseSameFolderReview, sameFolderComparisonDigest,
	sameFolderReviewPath, verifyNativeReviewBackup, type NativeReviewChoice } from "./SameFolderReview";
import { inspectSameFolderSource, type SameFolderInspectionIO } from "./SameFolderSourceInspection";
import { verifySourceInstallationPlan, type SourceInstallationReference, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourceInstallationStageIO } from "./SourceInstallationStaging";
import { sourceInventoryCacheSync, type SourceInventoryIdentity } from "./storage/source-document-cache";
import type { SourceNativeReviewReference, SourceSelectionJournal } from "./storage/source-selection-journal";
import { restoreGeneration } from "./collaboration/RestoreGeneration";

function controls(options: SourcePlanVerificationOptions) {
	const signal = options.signal, checkContext = options.check, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid native review timeout");
	const cancelled = () => Object.assign(new Error("Native recovery review was cancelled"), { name: "AbortError" });
	const check = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const bounded = async <T>(action: () => Promise<T>): Promise<T> => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Native recovery review timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const value = await Promise.race([Promise.resolve().then(() => { check(); return action(); }), interrupted]); check(); return value; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	return { check, bounded, options: { check, signal, timeoutMs: timeout } };
}
type VerifiedSource = Awaited<ReturnType<typeof verifySourceInstallationPlan>>;
async function readReview(io: RecoveryArchiveReader, input: SourceNativeReviewReference, source: VerifiedSource, control: ReturnType<typeof controls>) {
	const reference = { id: input.id, sha256: input.sha256, operations: input.operations }, { bounded, check } = control;
	if (!/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.operations) || reference.operations < 0 || reference.operations > 100_000) throw new Error("Invalid native review reference");
	const path = `${sameFolderReviewPath(reference.id)}/review.json`, stat = await bounded(() => io.stat(path));
	if (stat?.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > MAX_NATIVE_REVIEW_BYTES) throw new Error("The saved native review is missing or too large");
	const received = await bounded(() => io.readBinary(path)), bytes = ArrayBuffer.prototype.slice.call(received, 0) as ArrayBuffer;
	if (bytes.byteLength !== stat.size || await bounded(() => sha256Hex(bytes)) !== reference.sha256) throw new Error("The saved native review changed");
	const review = parseSameFolderReview(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), source.plan, source.reference);
	if (review.id !== reference.id || review.operations.length !== reference.operations) throw new Error("The saved native review reference does not match its operations");
	verifyNativeReviewBackup(review, source.archiveFiles); check(); return { review, reference: Object.freeze(reference), source };
}

/** Reopen an immutable review with fresh source/archive verification. This does
 * not attest that current native files still match its before-state. */
export async function verifySameFolderReview(io: RecoveryArchiveReader, input: SourceNativeReviewReference,
	expected: { plan: SourceInstallationReference; source: SourceInventoryIdentity; reviewId: string; archive: RecoveryArchiveReference },
	options: SourcePlanVerificationOptions = {}) {
	const reference = { ...input }, captured = { plan: { ...expected.plan }, source: { ...expected.source }, reviewId: expected.reviewId, archive: { ...expected.archive } };
	const control = controls(options), source = await verifySourceInstallationPlan(io, captured.plan, captured, control.options);
	return readReview(io, reference, source, control);
}

export interface SameFolderReviewRequest {
	source: SourceInventoryIdentity;
	reviewId: string;
	revision: string;
	operationId: string;
	comparisonDigest: string;
	choices: NativeReviewChoice[];
}
/** Save explicit choices only if the shown comparison still matches a fresh
 * native scan and every current file is in the verified original-work archive.
 * Read back a unique immutable review, then bind its digest/count using the
 * source journal's revision CAS. No native file/cache/mapping is modified. */
export async function prepareSameFolderReview(journal: SourceSelectionJournal, io: SourceInstallationStageIO, native: SameFolderInspectionIO,
	input: SameFolderReviewRequest, options: SourcePlanVerificationOptions = {}) {
	const metadata = JSON.stringify(input);
	if (!metadata || new TextEncoder().encode(metadata).byteLength > MAX_NATIVE_REVIEW_BYTES) throw new Error("The native review request exceeds its size limit");
	const request = JSON.parse(metadata) as SameFolderReviewRequest, control = controls(options), { check, bounded } = control;
	for (const id of [request.reviewId, request.revision, request.operationId]) if (!id || restoreGeneration(id) !== id) throw new Error("Invalid native review operation");
	if (!/^[a-f0-9]{64}$/.test(request.comparisonDigest) || journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The native review belongs to another source or comparison");
	const confirm = async () => {
		check(); const state = await journal.read(); check();
		if (state.revision !== request.revision || state.pending?.phase !== "prepared" || state.pending.reviewId !== request.reviewId
			|| state.pending.restoreGeneration !== request.source.restoreGeneration || !state.pending.preparation) throw new Error("The prepared source review changed");
		return state;
	};
	const state = await confirm(), preparation = state.pending!.preparation!;
	if (preparation.activation && [preparation.activation.startOperationId, preparation.activation.commitOperationId].includes(request.operationId)) {
		throw new Error("Native review progress cannot use a reserved activation operation ID");
	}
	const inspection = await inspectSameFolderSource(io, native, preparation.plan, { source: request.source, reviewId: request.reviewId, archive: preparation.archive }, control.options);
	if (await bounded(() => sameFolderComparisonDigest(inspection)) !== request.comparisonDigest) throw new Error("Native files changed since the shown comparison. Refresh the recovery review.");
	const source = inspection.sourceArtifacts;
	const review = createSameFolderReview(source.plan, source.reference, inspection.rows.filter(row => row.current).map(row => ({ path: row.path, ...row.current! })), request.choices);
	verifyNativeReviewBackup(review, source.archiveFiles);
	const activation = preparation.activation;
	if (activation && review.operations.some(row => row.id === activation.startOperationId || row.id === activation.commitOperationId)) throw new Error("Native operation identities overlap source activation");
	const encoded = await bounded(() => encodeSameFolderReview(review, source.plan, source.reference));
	await confirm(); const path = sameFolderReviewPath(review.id);
	await bounded(() => io.mkdir(path.slice(0, path.lastIndexOf("/"))));
	await bounded(() => io.createDirectoryExclusive(path));
	await bounded(() => io.writeBinary(`${path}/review.json`, encoded.bytes));
	const verified = await readReview(io, encoded.reference, source, control);
	await confirm();
	const selection = await journal.apply({ type: "review-native", expectedRevision: request.revision, operationId: request.operationId,
		reviewId: request.reviewId, nativeReview: verified.reference }, { check });
	check(); return { ...verified, selection, path };
}
