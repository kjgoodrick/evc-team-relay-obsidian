import { same } from "./client/managedRecovery";
import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { ResourceAddress, RemoteFolderAddress } from "./ResourceAddress";
import type { SettingsScope } from "./SettingsPersistence";
import { verifySourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourceMaterializationRequest } from "./SourceInstallationMaterialization";
import { sourceInventoryCacheSync } from "./storage/source-document-cache";
import type { SourceSelectionJournal } from "./storage/source-selection-journal";
import type { VaultShareSettings } from "./VaultShare";

type MappingSettings = Pick<SettingsScope<VaultShareSettings[]>, "readValue" | "readPersistedValue" | "mutateValue">;
const folded = (path: string) => path.normalize("NFC").toLowerCase();
const overlap = (left: string, right: string) => !left || !right || left === right || left.startsWith(right + "/") || right.startsWith(left + "/");

/** Persist the reviewed destination while ordinary startup is still fenced by
 * the applying journal. This does not activate sync or attest that native files,
 * selected caches, writer isolation or server admission are ready. The final
 * coordinator must verify those before committing the journal's native root. */
export async function stageSourceInstallationMapping(journal: SourceSelectionJournal, io: RecoveryArchiveReader, settings: MappingSettings,
	input: Omit<SourceMaterializationRequest, "operationId">, options: SourcePlanVerificationOptions = {}) {
	const request = { ...input, source: { ...input.source } }, checkContext = options.check, signal = options.signal, timeoutMs = options.timeoutMs;
	const check = () => { if (signal?.aborted) throw Object.assign(new Error("Source mapping was cancelled"), { name: "AbortError" }); checkContext?.(); };
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The mapping journal belongs to another source");
	check(); const state = await journal.read(); check();
	if (state.revision !== request.revision || state.pending?.phase !== "applying" || state.pending.reviewId !== request.reviewId
		|| state.pending.restoreGeneration !== request.source.restoreGeneration || !state.pending.preparation) throw new Error("The applying source selection changed");
	const preparation = state.pending.preparation;
	const confirm = async () => { check(); const current = await journal.read(); check(); if (current.revision !== state.revision) throw new Error("The source selection changed during mapping"); };
	const verified = await verifySourceInstallationPlan(io, preparation.plan, { source: request.source, reviewId: request.reviewId, archive: preparation.archive }, { check, signal, timeoutMs });
	const { plan } = verified, address = ResourceAddress.parse(plan.source.s3rn);
	if (!(address instanceof RemoteFolderAddress)) throw new Error("The installation has no managed folder identity");
	const snapshot = (input: unknown): VaultShareSettings[] => {
		const text = JSON.stringify(input);
		if (!text || new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) throw new Error("The saved folder mappings are unavailable or too large");
		const rows: unknown = JSON.parse(text);
		if (!Array.isArray(rows) || rows.length > 10_000 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row)
			|| typeof row.guid !== "string" || typeof row.path !== "string" || row.path.length > 4096)) throw new Error("The saved folder mappings are invalid");
		const matches = rows.filter(row => row.guid === address.folderGuid);
		if (matches.length !== 1 || matches[0].onpremServerId !== plan.source.serverId || matches[0].relay !== address.relayGuid
			|| ![plan.originalRoot, plan.destinationRoot].includes(matches[0].path)) throw new Error("The shared-folder mapping changed. Review it before continuing recovery.");
		if (rows.some(row => row.guid !== address.folderGuid && overlap(folded(row.path), folded(plan.destinationRoot)))) throw new Error("Another shared folder overlaps the installation destination");
		return rows;
	};
	const normalizeLocation = (rows: VaultShareSettings[]) => rows.map(row => row.guid === address.folderGuid ? { ...row, path: plan.originalRoot } : row);
	const read = settings.readValue.bind(settings), persisted = settings.readPersistedValue.bind(settings), mutate = settings.mutateValue.bind(settings);
	const inspectSettings = async () => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Reading the saved folder mapping timed out")), timeoutMs ?? 30_000);
			abort = () => reject(Object.assign(new Error("Source mapping was cancelled"), { name: "AbortError" })); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const result = await Promise.race([Promise.resolve().then(() => { check(); return persisted(); }), interrupted]); check(); return result; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	await confirm(); const memory = snapshot(read()), disk = snapshot(await inspectSettings()); await confirm();
	// A lost save can leave only our path different between memory and disk.
	// Other differences require reloading/review, never a stale overwrite.
	if (!same(normalizeLocation(memory), normalizeLocation(disk))) throw new Error("The saved folder settings changed outside this mapping operation. Reload them before continuing.");
	const resumed = disk.find(row => row.guid === address.folderGuid)!.path === plan.destinationRoot;
	const desired = memory.map(row => row.guid === address.folderGuid ? { ...row, path: plan.destinationRoot } : row);
	await confirm();
	await mutate(current => {
		check(); if (!same(snapshot(current), memory)) throw new Error("The in-memory folder settings changed during mapping");
		return desired;
	}, true);
	await confirm(); const saved = snapshot(await inspectSettings()); await confirm();
	if (!same(saved, desired) || !same(snapshot(read()), desired)) throw new Error("The destination mapping was not verified. Keep recovery paused and recheck the saved settings.");
	return { reference: verified.reference, revision: state.revision, originalRoot: plan.originalRoot, destinationRoot: plan.destinationRoot, resumed };
}
