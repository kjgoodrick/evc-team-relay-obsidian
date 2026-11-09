import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Y from "yjs";
import { FileSystemAdapter, type Vault } from "obsidian";
import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { Settings, SettingsScope } from "../../src/SettingsPersistence";
import type { VaultShareSettings } from "../../src/VaultShare";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { createDesktopSourceInstallationIO } from "../../src/DesktopSourceInstallationIO";
import { createDesktopSourceMaterializationIO } from "../../src/DesktopSourceMaterializationIO";
import { createSourceInstallationDownloads } from "../../src/SourceInstallationDownloads";
import { prepareSourceInstallation } from "../../src/SourceInstallationPreparation";
import { stageSourceInstallation } from "../../src/SourceInstallationStaging";
import { inspectSameFolderSource } from "../../src/SameFolderSourceInspection";
import { sameFolderComparisonDigest, type NativeReviewChoice } from "../../src/SameFolderReview";
import { prepareSameFolderReview, verifySameFolderReview } from "../../src/SameFolderReviewPreparation";
import { createDesktopSameFolderInspectionIO } from "../../src/DesktopSameFolderInspectionIO";
import { applyDesktopSameFolderFileOperation } from "../../src/DesktopSameFolderFileOperation";
import type { SameFolderFileOperation } from "../../src/SameFolderFileOperation";
import { holdNativeSourceWrites } from "../../src/storage/native-document-writes";
import { activateSourceInstallation, sourceActivationRequest } from "../../src/SourceInstallationActivation";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { admitSourceStartup } from "../../src/storage/source-startup-admission";
import { openSourceInventoryCache, type SourceInventoryIdentity } from "../../src/storage/source-document-cache";
import type { SourceSelectionContext } from "../../src/storage/source-selection-context";
import { readManagedInventory } from "../../src/client/readManagedInventory";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { UnsavedFileStore } from "../../src/UnsavedFile";

/** Called only by the disposable HTTP/MinIO integration. The fixture owns the
 * server's only writer and this temporary directory; no native app is opened. */
export async function proveAttachmentSourceInstallation(cache: RelayCredentialCache, fixture: Record<string, string>, token: string) {
	return proveSourceInstallation(cache, fixture, token, { expectedFiles: { "Upload.png": "second exact image revision", "Legacy.png": "verified legacy attachment fixture" } });
}

export async function proveSourceInstallation(cache: RelayCredentialCache, fixture: Record<string, string>, token: string, proof: {
	expectedFiles: Record<string, string>;
	/** Yrs may reorder object keys while preserving the Canvas JSON value. */
	compareJsonFiles?: readonly string[];
	afterPreparation?: () => Promise<void>;
	verifySelected?: (identity: SourceInventoryIdentity, selected: SourceSelectionContext, directory: string) => Promise<void>;
}) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-http-installation-"));
	const identity = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: fixture.base,
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", fixture.share)), restoreGeneration: fixture.generation };
	let journal: SourceSelectionJournal | undefined, scope: SettingsScope<VaultShareSettings[]> | undefined;
	try {
		const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory;
		adapter.stat = async name => {
			try { const stat = await fs.stat(path.join(directory, name)); return { type: stat.isDirectory() ? "folder" : "file", size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		};
		adapter.readBinary = async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer;
		const vault = { adapter } as unknown as Vault, staging = createDesktopSourceInstallationIO(vault);
		await fs.mkdir(path.join(directory, "Original")); await fs.writeFile(path.join(directory, "Original", "Offline.md"), "Retained original offline work");
		const backup = await prepareRecoveryBackup({ stat: adapter.stat.bind(adapter), readBinary: adapter.readBinary.bind(adapter),
			mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
			write: (name, value) => fs.writeFile(path.join(directory, name), value), writeBinary: (name, value) => fs.writeFile(path.join(directory, name), new Uint8Array(value)),
		}, async () => ({ files: [{ path: "Original/Offline.md", bytes: new TextEncoder().encode("Retained original offline work").buffer }], documents: [], index: new Uint8Array([0, 0]) }), {});
		const configuration = path.join(directory, "settings.json");
		await fs.writeFile(configuration, JSON.stringify({ sharedFolders: [{ guid: fixture.share, path: "Original", relay: "relay-onprem", onpremServerId: "fixture" }] }));
		const settings = new Settings({ loadData: async () => JSON.parse(await fs.readFile(configuration, "utf8")) as { sharedFolders: VaultShareSettings[] },
			saveData: async (data: { sharedFolders: VaultShareSettings[] }) => { await fs.writeFile(configuration, JSON.stringify(data)); } }, { sharedFolders: [] as VaultShareSettings[] });
		await settings.hydrate(); scope = new SettingsScope<VaultShareSettings[]>(settings as unknown as Settings<unknown>, "sharedFolders");
		journal = await SourceSelectionJournal.open(identity); const reviewId = crypto.randomUUID();
		const review = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: null, reviewId, restoreGeneration: fixture.generation });
		await expect(admitSourceStartup(vault, "Original", identity, { check: () => {} })).rejects.toThrow("awaiting recovery");
		const snapshot = await readManagedInventory(cache, identity.s3rn, "fixture", identity);
		expect(Object.keys(snapshot.records).sort()).toEqual(Object.keys(proof.expectedFiles).sort());
		const downloads = createSourceInstallationDownloads(cache, identity, snapshot);
		const sameFolder = await stageSourceInstallation(staging, { source: identity, reviewId, archive: backup.reference,
			originalRoot: "Original", destinationRoot: "Original", mode: "existing-folder", snapshot }, downloads);
		await fs.writeFile(path.join(directory, "Original", "Later.md"), "New local work after backup");
		const comparison = await inspectSameFolderSource(staging, createDesktopSameFolderInspectionIO(vault, "Original"), sameFolder.reference,
			{ source: identity, reviewId, archive: backup.reference });
		expect(comparison.rows.filter(row => row.entryId).map(row => row.path).sort()).toEqual(Object.keys(proof.expectedFiles).sort());
		expect(comparison.rows).toEqual(expect.arrayContaining([
			expect.objectContaining({ path: "Offline.md", change: "local-only", backupStatus: "matches-backup" }),
			expect.objectContaining({ path: "Later.md", change: "local-only", backupStatus: "not-backed-up" }),
		]));
		expect((await journal.read()).pending?.phase).toBe("review");
		expect(await adapter.stat("Restored")).toBeNull();
		expect(await fs.readFile(path.join(directory, "Original", "Later.md"), "utf8")).toBe("New local work after backup");
		const prepared = await prepareSourceInstallation(journal, staging, { source: identity, reviewId, reviewRevision: review.revision!, operationId: crypto.randomUUID(),
			archive: backup.reference, originalRoot: "Original", destinationRoot: "Restored", snapshot }, downloads);
		await proof.afterPreparation?.();
		const request = await sourceActivationRequest(journal, { source: identity, reviewId, revision: prepared.selection.revision! });
		const native = createDesktopSourceMaterializationIO(vault, prepared.staged.plan);
		const host = { settings: scope, app: { loadLocalStorage: () => null }, buffers: new UnsavedFileStore(), checkIsolation: () => {} };
		const result = await activateSourceInstallation(journal, staging, native, request, host, downloads);
		expect(result).toMatchObject({ destinationRoot: "Restored", selection: { pending: null, nativeRoot: "Restored", active: { kind: "source", restoreGeneration: fixture.generation } } });
		for (const [name, expected] of Object.entries(proof.expectedFiles)) {
			const actual = await fs.readFile(path.join(directory, "Restored", name), "utf8");
			if (proof.compareJsonFiles?.includes(name)) expect(JSON.parse(actual)).toEqual(JSON.parse(expected));
			else expect(actual).toBe(expected);
		}
		expect(await fs.readFile(path.join(directory, "Original", "Offline.md"), "utf8")).toBe("Retained original offline work");
		expect((await scope.readPersistedValue())![0].path).toBe("Restored");
		const admitted = await admitSourceStartup(vault, "Restored", identity, { check: () => {} });
		try {
			const doc = new Y.Doc(), store = await openSourceInventoryCache(identity, doc);
			const transport = new ManagedIndexTransport(doc, () => ({ endpoint: fixture.base + "/v1/managed/index/" + fixture.share, token }), () => {}, () => {}, admitted.binding);
			try {
				expect(transport.snapshot.records).toEqual(snapshot.records); await transport.flush();
				expect(transport.restoreReview).toBeUndefined(); expect(transport.conflicts).toEqual([]); expect(transport.snapshot.records).toEqual(snapshot.records);
			} finally { transport.destroy(); await store.close(); doc.destroy(); }
			await proof.verifySelected?.(identity, admitted, path.join(directory, "Restored"));
		} finally { admitted.close(); }
		const laterFile = path.join(directory, "Restored", Object.keys(proof.expectedFiles)[0]);
		await fs.writeFile(laterFile, "Later local edit");
		expect(await activateSourceInstallation(journal, staging, native, request, host, downloads)).toMatchObject({ reconciled: true });
		expect(await fs.readFile(laterFile, "utf8")).toBe("Later local edit");
		await proveSameFolderNativeOperation(vault, directory, cache, identity, Object.keys(proof.expectedFiles)[0]);
	} finally { scope?.destroy(); journal?.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

/** Bind a complete file-only review to a separate disposable client's journal,
 * apply every reviewed operation and record progress. Directory execution and
 * final cache/editor activation are separate work and are not claimed here. */
async function proveSameFolderNativeOperation(vault: Vault, directory: string, cache: RelayCredentialCache,
	input: SourceInventoryIdentity, file: string) {
	const source = { ...input, hostAppId: crypto.randomUUID() }, root = "Same folder native proof", reviewId = crypto.randomUUID();
	const target = `${root}/${file}`, before = new TextEncoder().encode("Local content retained before replacement").buffer;
	await fs.mkdir(path.dirname(path.join(directory, target)), { recursive: true }); await fs.writeFile(path.join(directory, target), new Uint8Array(before));
	const archive = await prepareRecoveryBackup({ stat: vault.adapter.stat.bind(vault.adapter), readBinary: vault.adapter.readBinary.bind(vault.adapter),
		mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		write: (name, value) => fs.writeFile(path.join(directory, name), value), writeBinary: (name, value) => fs.writeFile(path.join(directory, name), new Uint8Array(value)),
	}, async () => ({ files: [{ path: target, bytes: before }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const journal = await SourceSelectionJournal.open(source), hold = holdNativeSourceWrites(vault, root);
	try {
		await hold.wait({ check: () => {} });
		const review = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration! });
		const snapshot = await readManagedInventory(cache, source.s3rn, source.serverId, source), staging = createDesktopSourceInstallationIO(vault);
		const capture = { source, reviewId, archive: archive.reference, originalRoot: root, destinationRoot: root, mode: "existing-folder" as const, snapshot };
		const prepared = await prepareSourceInstallation(journal, staging, { ...capture, reviewRevision: review.revision!, operationId: crypto.randomUUID() }, createSourceInstallationDownloads(cache, source, snapshot));
		const native = createDesktopSameFolderInspectionIO(vault, root);
		const comparison = await inspectSameFolderSource(staging, native, prepared.staged.reference, capture);
		const row = comparison.rows.find(row => row.path === file)!, entry = prepared.staged.plan.entries.find(entry => entry.path === file)!;
		expect(row).toMatchObject({ change: "replace", backupStatus: "matches-backup", pathConflict: false });
		if (row.current?.type !== "file" || !entry.file) throw new Error("Missing native source proof input");
		const choices: NativeReviewChoice[] = comparison.rows.filter(row => row.change !== "unchanged" && row.change !== "absent")
			.map(row => ({ path: row.path, choice: row.selected ? "use-selected" : "archive-local" }));
		const saved = await prepareSameFolderReview(journal, staging, native, { source, reviewId, revision: prepared.selection.revision!,
			operationId: crypto.randomUUID(), comparisonDigest: await sameFolderComparisonDigest(comparison), choices });
		const verified = await verifySameFolderReview(createDesktopSourceInstallationIO(vault), saved.reference, { ...capture, plan: prepared.staged.reference });
		expect(verified.review).toEqual(saved.review);
		const activation = saved.selection.pending!.preparation!.activation!;
		let applying = await journal.apply({ type: "start", expectedRevision: saved.selection.revision, reviewId, operationId: activation.startOperationId });
		await expect(journal.apply({ type: "commit", expectedRevision: applying.revision, reviewId, operationId: activation.commitOperationId, destinationRoot: root })).rejects.toThrow("Finish the reviewed native operations");
		let replaced: { operation: SameFolderFileOperation; selected: ArrayBuffer | null } | undefined;
		for (const [index, step] of verified.review.operations.entries()) {
			if (step.kind !== "file") throw new Error("This fixture requires the directory executor");
			const operation: SameFolderFileOperation = { format: "team-relay-native-file-operation", version: 1, id: step.id,
				plan: prepared.staged.reference, reviewId, root, path: step.path, before: step.before, after: step.after };
			const selected = step.after ? await staging.readBinary(`${prepared.staged.path}/files/${step.entryId}.bin`) : null;
			const result = await applyDesktopSameFolderFileOperation(vault, operation, selected, hold);
			if (selected) expect(new Uint8Array(await vault.adapter.readBinary(`${root}/${step.path}`))).toEqual(new Uint8Array(selected));
			if (step.path === file) {
				expect(new Uint8Array(await vault.adapter.readBinary(result.preservedPath!))).toEqual(new Uint8Array(before));
				replaced = { operation, selected };
			}
			// A restart between native publication and progress recording must use
			// the same immutable operation, without replacing the native file again.
			expect(await applyDesktopSameFolderFileOperation(vault, operation, selected, hold)).toMatchObject({ resumed: true });
			const command = { type: "finish-native-operation" as const, expectedRevision: applying.revision, reviewId,
				operationId: step.id, nativeReview: saved.reference, index };
			applying = await journal.apply(command); expect(await journal.apply(command)).toEqual(applying);
		}
		expect(replaced).toBeDefined();
		const reopened = await SourceSelectionJournal.open(source);
		try { expect((await reopened.read()).pending?.completedNativeOperations).toBe(verified.review.operations.length); }
		finally { reopened.close(); }
		await fs.writeFile(path.join(directory, target), "Later local edit at the same path");
		await expect(applyDesktopSameFolderFileOperation(vault, replaced!.operation, replaced!.selected, hold)).rejects.toThrow();
		expect(await fs.readFile(path.join(directory, target), "utf8")).toBe("Later local edit at the same path");
		expect((await journal.read()).revision).toBe(applying.revision);
		expect((await journal.read()).pending?.phase).toBe("applying");
	} finally { hold.release(); journal.close(); }
}
