import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import type { SameFolderDirectoryOperation } from "./SameFolderDirectoryOperation";
import type { SameFolderFileOperation } from "./SameFolderFileOperation";
import { sameFolderComparisonDigest, type SameFolderReview } from "./SameFolderReview";
import { verifySameFolderReview } from "./SameFolderReviewPreparation";
import { inspectSameFolderSource, type SameFolderInspectionIO } from "./SameFolderSourceInspection";
import type { SourceMaterializationRequest } from "./SourceInstallationMaterialization";
import { sourceInstallationPath, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import { holdNativeSourceWrites, type NativeSourceWriteHold } from "./storage/native-document-writes";
import { sourceInventoryCacheSync } from "./storage/source-document-cache";
import type { SourceSelectionJournal, SourceSelectionState } from "./storage/source-selection-journal";
import { borrowPausedSourceHold } from "./storage/source-startup-admission";

interface NativeOperationResult { operationId: string; resumed: boolean; preservedPath: string | null }
/** The host keeps the same root identity across operations, provides a fresh
 * inspector after legitimate directory mutations, and awaits each OS mutation.
 * Current access and isolation from other processes belong to the caller. */
export interface SameFolderMaterializationIO {
	readonly root: string;
	readonly nativeWriteOwner: object;
	assertCurrent(): Promise<void>;
	inspect(): SameFolderInspectionIO;
	verifyPreserved(review: SameFolderReview, check: () => void): Promise<void>;
	applyFile(operation: SameFolderFileOperation, bytes: ArrayBuffer | null, hold: NativeSourceWriteHold, check: () => void): Promise<NativeOperationResult>;
	applyDirectory(operation: SameFolderDirectoryOperation, hold: NativeSourceWriteHold, check: () => void): Promise<NativeOperationResult>;
}

/** Apply the saved complete native recipe, then verify the exact selected tree
 * while still holding registered plugin writers. The journal remains applying.
 * Keeping/merging archived local edits, cache/editor handoff and source commit
 * are separate workflows. This only executes explicitly reviewed selections.
 * A completion receipt never substitutes for final native/source verification. */
export async function withMaterializedSameFolder<T>(journal: SourceSelectionJournal, staging: RecoveryArchiveReader,
	native: SameFolderMaterializationIO, input: SourceMaterializationRequest,
	continueWith: (session: SameFolderMaterializedSession) => Promise<T>, options: SourcePlanVerificationOptions = {}): Promise<T> {
	const request = { ...input, source: { ...input.source } }, root = native.root, owner = native.nativeWriteOwner;
	const assertRoot = native.assertCurrent.bind(native), inspect = native.inspect.bind(native), applyFile = native.applyFile.bind(native), applyDirectory = native.applyDirectory.bind(native), verifyPreserved = native.verifyPreserved.bind(native);
	const signal = options.signal, context = options.check, timeoutMs = options.timeoutMs;
	let closed = false;
	const check = () => {
		if (closed) throw new Error("The same-folder recovery session ended");
		if (signal?.aborted) throw Object.assign(new Error("Same-folder recovery was cancelled"), { name: "AbortError" });
		if (native.root !== root || native.nativeWriteOwner !== owner) throw new Error("The same-folder recovery host changed");
		context?.();
	};
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The native recovery journal belongs to another source");
	check(); let state = await journal.read(); check();
	const pending = state.pending, preparation = pending?.preparation;
	if (state.revision !== request.revision || pending?.reviewId !== request.reviewId || pending.restoreGeneration !== request.source.restoreGeneration
		|| !preparation?.nativeReview || !preparation.activation || preparation.activation.startOperationId !== request.operationId
		|| !["prepared", "applying"].includes(pending.phase)) throw new Error("The saved native recovery review changed or is incomplete");
	const expected = { plan: preparation.plan, source: request.source, reviewId: request.reviewId, archive: preparation.archive }, checks = { check, signal, timeoutMs };
	const verified = await verifySameFolderReview(staging, preparation.nativeReview, expected, checks), { review, source } = verified;
	if (review.root !== root) throw new Error("The native recovery root does not match its review");
	const confirm = async () => {
		check(); await assertRoot(); check(); const current = await journal.read(); check();
		if (current.revision !== state.revision) throw new Error("The source selection changed during native recovery");
	};
	const hold = borrowPausedSourceHold(owner, root, request.source) ?? holdNativeSourceWrites(owner, root);
	try {
		await hold.wait(checks); await confirm();
		if (state.pending!.phase === "prepared") {
			const comparison = await inspectSameFolderSource(staging, inspect(), preparation.plan, expected, checks);
			const savedDigest = await sameFolderComparisonDigest({ plan: review.plan, root: review.root,
				rows: review.before.map(({ path, ...current }) => ({ path, current })) });
			if (await sameFolderComparisonDigest(comparison) !== savedDigest) throw new Error("Native work changed after review; refresh the backup and choices before installation");
			await confirm();
			state = await journal.apply({ type: "start", expectedRevision: state.revision, operationId: request.operationId, reviewId: request.reviewId }, { check });
			await confirm();
		}
		let applied = 0, resumed = 0;
		for (let index = state.pending!.completedNativeOperations!; index < review.operations.length; index++) {
			const step = review.operations[index], common = { version: 1 as const, id: step.id, plan: review.plan, reviewId: review.reviewId, root, path: step.path };
			await confirm(); let result: NativeOperationResult;
			if (step.kind === "directory") {
				result = await applyDirectory({ ...common, format: "team-relay-native-directory-operation", action: step.action }, hold, check);
			} else {
				let bytes: ArrayBuffer | null = null;
				if (step.after) {
					const path = `${sourceInstallationPath(review.plan.id)}/files/${step.entryId}.bin`, stat = await staging.stat(path); await confirm();
					if (stat?.type !== "file" || stat.size !== step.after.bytes) throw new Error("The staged replacement file changed");
					bytes = await staging.readBinary(path); await confirm();
				}
				// The host validates exact before/after hashes and awaits publication.
				// Never race an OS mutation with timeout/cancellation and release its hold.
				result = await applyFile({ ...common, format: "team-relay-native-file-operation", before: step.before, after: step.after }, bytes, hold, check);
			}
			await confirm();
			if (result.operationId !== step.id) throw new Error("The native operation receipt belongs to different work");
			state = await journal.apply({ type: "finish-native-operation", expectedRevision: state.revision, operationId: step.id,
				reviewId: request.reviewId, nativeReview: verified.reference, index }, { check });
			if (result.resumed) resumed++; else applied++; await confirm();
		}
		const verifyNative = async () => {
			await confirm();
			const comparison = await inspectSameFolderSource(staging, inspect(), preparation.plan, expected, checks);
			const mismatch = comparison.rows.find(row => row.change !== "unchanged" && row.change !== "absent");
			if (mismatch) throw new Error("Native recovery is incomplete or changed at: " + mismatch.path);
			await verifyPreserved(review, check); await confirm();
			// Historical archive spellings may still report a case conflict. Only
			// exact selected/current paths and hashes determine the installed tree.
			await verifySameFolderReview(staging, verified.reference, expected, checks); await confirm();
		};
		await verifyNative();
		return await continueWith(Object.freeze({ selection: structuredClone(state), reference: source.reference,
			destinationRoot: root, plan: structuredClone(source.plan), inventorySnapshot: structuredClone(source.inventorySnapshot),
			applied, resumed, assertCurrent: confirm, verifyNative }));
	} finally { closed = true; hold.release(); }
}

export interface SameFolderMaterializedSession {
	selection: SourceSelectionState;
	reference: import("./SourceInstallationPlan").SourceInstallationReference;
	destinationRoot: string;
	plan: import("./SourceInstallationPlan").SourceInstallationPlan;
	inventorySnapshot: import("./client/ManagedIndexTransport").ManagedManifest;
	applied: number;
	resumed: number;
	assertCurrent(): Promise<void>;
	verifyNative(): Promise<void>;
}
