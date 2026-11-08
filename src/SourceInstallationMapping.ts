import { same } from "./client/managedRecovery";
import type { RecoveryArchiveReader } from "./ManagedRecoveryArchive";
import { ResourceAddress, RemoteFolderAddress } from "./ResourceAddress";
import type { SettingsScope } from "./SettingsPersistence";
import { parseSourceInstallationPlan, sourceInstallationNativeRoot, verifySourceInstallationPlan, type SourceInstallationPlan, type SourcePlanVerificationOptions } from "./SourceInstallationPlan";
import type { SourceMaterializationRequest } from "./SourceInstallationMaterialization";
import { sourceInventoryCacheSync } from "./storage/source-document-cache";
import type { SourceSelectionJournal } from "./storage/source-selection-journal";
import type { SourceSelectionScope } from "./storage/source-selection-context";
import type { VaultShareSettings } from "./VaultShare";

export type SourceInstallationMappingSettings = Pick<SettingsScope<VaultShareSettings[]>, "readValue" | "readPersistedValue" | "mutateValue">;
const folded = (path: string) => path.normalize("NFC").toLowerCase();
const overlap = (left: string, right: string) => !left || !right || left === right || left.startsWith(right + "/") || right.startsWith(left + "/");

type MappingLocation = Pick<SourceInstallationPlan, "source" | "originalRoot" | "destinationRoot">;
function mappingSnapshot(input: unknown, plan: MappingLocation): VaultShareSettings[] {
	const address = ResourceAddress.parse(plan.source.s3rn);
	if (!(address instanceof RemoteFolderAddress)) throw new Error("The installation has no managed folder identity");
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
}

function mappingInspection(settings: Pick<SourceInstallationMappingSettings, "readValue" | "readPersistedValue">, options: SourcePlanVerificationOptions) {
	const checkContext = options.check, signal = options.signal, timeout = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid source mapping timeout");
	const cancelled = () => Object.assign(new Error("Source mapping was cancelled"), { name: "AbortError" });
	const check = () => { if (signal?.aborted) throw cancelled(); checkContext?.(); };
	const read = settings.readValue.bind(settings), persisted = settings.readPersistedValue.bind(settings);
	const inspectSettings = async () => {
		check(); let timer: number | undefined, abort: (() => void) | undefined;
		const interrupted = new Promise<never>((_resolve, reject) => {
			timer = window.setTimeout(() => reject(new Error("Reading the saved folder mapping timed out")), timeout);
			abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
		});
		try { const result = await Promise.race([Promise.resolve().then(() => { check(); return persisted(); }), interrupted]); check(); return result; }
		finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
	};
	return { read, inspectSettings, check };
}

/** Final read-only check. Unlike staging, this never repairs or rewrites a
 * mapping changed during an intervening network or native verification. */
export async function verifySourceInstallationMapping(settings: Pick<SourceInstallationMappingSettings, "readValue" | "readPersistedValue">,
	input: SourceInstallationPlan, options: SourcePlanVerificationOptions = {}): Promise<void> {
	return verifyDestinationMapping(settings, parseSourceInstallationPlan(input), options);
}

/** Startup for a committed source only reads its mapping. It must not recreate
 * a removed row or overwrite a changed location from a stale restore request. */
export async function verifySelectedSourceMapping(settings: Pick<SourceInstallationMappingSettings, "readValue" | "readPersistedValue">,
	input: SourceSelectionScope, destination: string, options: SourcePlanVerificationOptions = {}): Promise<void> {
	const source = { ...input, restoreGeneration: null }, root = sourceInstallationNativeRoot(destination);
	sourceInventoryCacheSync(source);
	return verifyDestinationMapping(settings, { source, originalRoot: root, destinationRoot: root }, options);
}

async function verifyDestinationMapping(settings: Pick<SourceInstallationMappingSettings, "readValue" | "readPersistedValue">,
	plan: MappingLocation, options: SourcePlanVerificationOptions): Promise<void> {
	const { read, inspectSettings, check } = mappingInspection(settings, options);
	check(); const memory = mappingSnapshot(read(), plan), disk = mappingSnapshot(await inspectSettings(), plan); check();
	const address = ResourceAddress.parse(plan.source.s3rn) as RemoteFolderAddress;
	if (memory.find(row => row.guid === address.folderGuid)!.path !== plan.destinationRoot || !same(memory, disk)
		|| !same(memory, mappingSnapshot(read(), plan))) throw new Error("The installation destination mapping changed. Keep recovery paused and review the saved settings.");
}

/** Persist the reviewed destination while ordinary startup is still fenced by
 * the applying journal. This does not activate sync or attest that native files,
 * selected caches, writer isolation or server admission are ready. The final
 * coordinator must verify those before committing the journal's native root. */
export async function stageSourceInstallationMapping(journal: SourceSelectionJournal, io: RecoveryArchiveReader, settings: SourceInstallationMappingSettings,
	input: Omit<SourceMaterializationRequest, "operationId">, options: SourcePlanVerificationOptions = {}) {
	const request = { ...input, source: { ...input.source } }, signal = options.signal, timeoutMs = options.timeoutMs;
	const { read, inspectSettings, check } = mappingInspection(settings, options), mutate = settings.mutateValue.bind(settings);
	if (journal.scopeIdentity !== sourceInventoryCacheSync({ ...request.source, restoreGeneration: null }).identity) throw new Error("The mapping journal belongs to another source");
	check(); const state = await journal.read(); check();
	if (state.revision !== request.revision || state.pending?.phase !== "applying" || state.pending.reviewId !== request.reviewId
		|| state.pending.restoreGeneration !== request.source.restoreGeneration || !state.pending.preparation) throw new Error("The applying source selection changed");
	const preparation = state.pending.preparation;
	const confirm = async () => { check(); const current = await journal.read(); check(); if (current.revision !== state.revision) throw new Error("The source selection changed during mapping"); };
	const verified = await verifySourceInstallationPlan(io, preparation.plan, { source: request.source, reviewId: request.reviewId, archive: preparation.archive }, { check, signal, timeoutMs });
	const { plan } = verified, address = ResourceAddress.parse(plan.source.s3rn);
	if (!(address instanceof RemoteFolderAddress)) throw new Error("The installation has no managed folder identity");
	const snapshot = (value: unknown) => mappingSnapshot(value, plan);
	const normalizeLocation = (rows: VaultShareSettings[]) => rows.map(row => row.guid === address.folderGuid ? { ...row, path: plan.originalRoot } : row);
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
