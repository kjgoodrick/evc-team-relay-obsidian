import type { App } from "obsidian";
import type { ManagedManifest } from "./client/ManagedIndexTransport";
import { same } from "./client/managedRecovery";
import { restoreGeneration } from "./collaboration/RestoreGeneration";
import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { seedSourceInstallationCaches } from "./SourceInstallationCaches";
import { installationManifest } from "./SourceInstallationContent";
import { assertNoInstallationLocalWork } from "./SourceInstallationLocalWork";
import { stageSourceInstallationMapping, verifySourceInstallationMapping, type SourceInstallationMappingSettings } from "./SourceInstallationMapping";
import { withMaterializedSourceInstallation, type SourceMaterializationRequest, type SourceNativeInstallationIO } from "./SourceInstallationMaterialization";
import type { SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourcePreparationDownloads } from "./SourceInstallationPreparation";
import { sourceInventoryCacheSync } from "./storage/source-document-cache";
import type { SourceSelectionJournal, SourceSelectionState } from "./storage/source-selection-journal";
import type { UnsavedFileStore } from "./UnsavedFile";

export interface SourceActivationRequest extends SourceMaterializationRequest { commitOperationId: string }
export interface SourceActivationHost {
	settings: SourceInstallationMappingSettings;
	app: Pick<App, "loadLocalStorage">;
	buffers: Pick<UnsavedFileStore, "countSavedBuffers">;
	/** Must throw if the caller's writer-isolation lease no longer holds. That
	 * lease must cover providers/editors, other windows/processes and server
	 * writes throughout preparation/activation. A fresh inventory is not such a
	 * lease: document edits need not change inventory metadata. */
	checkIsolation(): void;
}
export interface SourceActivationResult { selection: SourceSelectionState; destinationRoot: string; reconciled: boolean }

/** Recover stable operation IDs from the reviewed journal. Older prepared
 * previews can reserve IDs with one CAS transition before native/cache work;
 * a lost response requires rereading the saved revision, never new operations. */
export async function sourceActivationRequest(journal: SourceSelectionJournal, input: Omit<SourceMaterializationRequest, "operationId">,
	options: SourcePlanVerificationOptions = {}): Promise<SourceActivationRequest> {
	const captured = { ...input, source: { ...input.source } }, signal = options.signal, checkContext = options.check;
	if (captured.source.restoreGeneration === undefined) throw new Error("Source activation requires an explicit generation");
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...captured.source, restoreGeneration: null }).identity) throw new Error("The activation journal belongs to another source");
	const check = () => { if (signal?.aborted) throw Object.assign(new Error("Source activation was cancelled"), { name: "AbortError" }); checkContext?.(); };
	check(); let state = await journal.read(); check();
	if (state.revision !== captured.revision || state.pending?.reviewId !== captured.reviewId || !state.pending.preparation
		|| state.pending.phase === "review" || state.pending.restoreGeneration !== captured.source.restoreGeneration) throw new Error("The prepared source selection changed");
	if (!state.pending.preparation.activation) {
		state = await journal.apply({ type: "reserve-activation", operationId: crypto.randomUUID(), expectedRevision: state.revision,
			reviewId: captured.reviewId, activation: { startOperationId: crypto.randomUUID(), commitOperationId: crypto.randomUUID() } }, { check });
		check();
	}
	const saved = state.pending!.preparation!.activation!;
	return { source: captured.source, reviewId: captured.reviewId, revision: state.revision!, operationId: saved.startOperationId, commitOperationId: saved.commitOperationId };
}

/** Commit a prepared installation under native holds. This is a coordinator,
 * not an admission authority: the host must establish writer isolation and
 * current authenticated account/server context, then separately hand off the
 * old instance and start providers from the committed journal/root. */
export async function activateSourceInstallation(journal: SourceSelectionJournal, staging: RecoveryArchiveReader,
	native: SourceNativeInstallationIO, input: SourceActivationRequest, host: SourceActivationHost,
	downloads: Pick<SourcePreparationDownloads, "revalidate">, options: SourcePlanVerificationOptions = {}): Promise<SourceActivationResult> {
	const request = { ...input, source: { ...input.source } }, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	for (const id of [request.operationId, request.commitOperationId, request.reviewId, request.revision]) {
		if (!id || restoreGeneration(id) !== id) throw new Error("Invalid source activation operation");
	}
	if (request.operationId === request.commitOperationId) throw new Error("Source activation requires distinct start and commit operations");
	if (request.source.restoreGeneration === undefined) throw new Error("Source activation requires an explicit generation");
	const generation = restoreGeneration(request.source.restoreGeneration);
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid activation timeout");
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The activation journal belongs to another source");
	const checkContext = options.check, checkIsolation = host.checkIsolation.bind(host), revalidate = downloads.revalidate.bind(downloads);
	const settings = { readValue: host.settings.readValue.bind(host.settings), readPersistedValue: host.settings.readPersistedValue.bind(host.settings), mutateValue: host.settings.mutateValue.bind(host.settings) };
	const app = { loadLocalStorage: host.app.loadLocalStorage.bind(host.app) }, buffers = { countSavedBuffers: host.buffers.countSavedBuffers.bind(host.buffers) };
	const cancelled = () => Object.assign(new Error("Source activation was cancelled"), { name: "AbortError" });
	const checkContextOnly = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const check = () => { checkContextOnly(); checkIsolation(); };
	const receipt = { operationId: request.commitOperationId, reviewId: request.reviewId, restoreGeneration: generation };
	checkContextOnly(); const current = await journal.read(); checkContextOnly();
	if (!current.pending) {
		// A retry after commit may encounter legitimate new edits, buffers and
		// providers. Confirm the receipt without touching any of those surfaces.
		const selection = await journal.reconcileCommit(receipt); checkContextOnly();
		return { selection, destinationRoot: selection.nativeRoot!, reconciled: true };
	}
	const saved = current.pending.preparation?.activation;
	if (saved && (saved.startOperationId !== request.operationId || saved.commitOperationId !== request.commitOperationId)) throw new Error("Use the saved source activation operations");
	check(); const checks = { check, signal, timeoutMs: timeout };
	return withMaterializedSourceInstallation(journal, staging, native, request, async session => {
		const applying = { ...request, revision: session.selection.revision! };
		await session.assertCurrent(); await assertNoInstallationLocalWork(app, buffers, session.plan, checks);
		await seedSourceInstallationCaches(journal, staging, applying, checks);
		await stageSourceInstallationMapping(journal, staging, settings, applying, checks);
		await session.verifyNative();
		let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Rechecking the activation inventory timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		let fresh: ManagedManifest;
		try { check(); fresh = await Promise.race([Promise.resolve().then(() => { check(); return revalidate(Object.freeze({ ...request.source })); }), interrupted]); check(); }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
		if (!same(installationManifest(session.plan, fresh), session.inventorySnapshot)) throw new Error("The server inventory changed before activation. Keep recovery paused and refresh the review.");
		// Recheck after the network await. These reads never repair changed
		// settings or discard local work to make a prepared installation pass.
		await session.verifyNative();
		await verifySourceInstallationMapping(settings, session.plan, checks);
		await assertNoInstallationLocalWork(app, buffers, session.plan, checks);
		await session.assertCurrent(); check();
		let selection: SourceSelectionState, reconciled = false;
		try {
			selection = await journal.apply({ type: "commit", operationId: request.commitOperationId, expectedRevision: applying.revision,
				reviewId: request.reviewId, destinationRoot: session.destinationRoot }, { check });
		} catch (error) {
			// The transaction may have committed before its caller saw an error.
			// Inspect its exact receipt once; never replay a native/cache import.
			try { selection = await journal.reconcileCommit(receipt); reconciled = true; } catch { throw error; }
		}
		checkContextOnly(); return { selection, destinationRoot: selection.nativeRoot!, reconciled };
	}, checks);
}
