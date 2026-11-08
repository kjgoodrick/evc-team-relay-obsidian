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
import { activateSourceInstallation, sourceActivationRequest } from "../../src/SourceInstallationActivation";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { admitSourceStartup } from "../../src/storage/source-startup-admission";
import { openSourceInventoryCache } from "../../src/storage/source-document-cache";
import { readManagedInventory } from "../../src/client/readManagedInventory";
import { ManagedIndexTransport } from "../../src/client/ManagedIndexTransport";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { UnsavedFileStore } from "../../src/UnsavedFile";

/** Called only by the disposable HTTP/MinIO integration. The fixture owns the
 * server's only writer and this temporary directory; no native app is opened. */
export async function proveAttachmentSourceInstallation(cache: RelayCredentialCache, fixture: Record<string, string>, token: string) {
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
		const downloads = createSourceInstallationDownloads(cache, identity, snapshot);
		const prepared = await prepareSourceInstallation(journal, staging, { source: identity, reviewId, reviewRevision: review.revision!, operationId: crypto.randomUUID(),
			archive: backup.reference, originalRoot: "Original", destinationRoot: "Restored", snapshot }, downloads);
		const request = await sourceActivationRequest(journal, { source: identity, reviewId, revision: prepared.selection.revision! });
		const native = createDesktopSourceMaterializationIO(vault, prepared.staged.plan);
		const host = { settings: scope, app: { loadLocalStorage: () => null }, buffers: new UnsavedFileStore(), checkIsolation: () => {} };
		const result = await activateSourceInstallation(journal, staging, native, request, host, downloads);
		expect(result).toMatchObject({ destinationRoot: "Restored", selection: { pending: null, nativeRoot: "Restored", active: { kind: "source", restoreGeneration: fixture.generation } } });
		expect(await fs.readFile(path.join(directory, "Restored", "Upload.png"), "utf8")).toBe("second exact image revision");
		expect(await fs.readFile(path.join(directory, "Restored", "Legacy.png"), "utf8")).toBe("verified legacy attachment fixture");
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
		} finally { admitted.close(); }
		await fs.writeFile(path.join(directory, "Restored", "Upload.png"), "Later local edit");
		expect(await activateSourceInstallation(journal, staging, native, request, host, downloads)).toMatchObject({ reconciled: true });
		expect(await fs.readFile(path.join(directory, "Restored", "Upload.png"), "utf8")).toBe("Later local edit");
	} finally { scope?.destroy(); journal?.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
