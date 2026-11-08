import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Y from "yjs";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { ItemKind } from "../../src/ItemKinds";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation, type SourceInstallationCapture, type SourceInstallationStageIO } from "../../src/SourceInstallationStaging";
import { prepareSourceInstallation } from "../../src/SourceInstallationPreparation";
import { parseSourceInstallationPlan, verifySourceInstallationPlan } from "../../src/SourceInstallationPlan";
import { inspectSameFolderSource, type SameFolderInspectionIO } from "../../src/SameFolderSourceInspection";
import { createDesktopSameFolderInspectionIO } from "../../src/DesktopSameFolderInspectionIO";
import { createDesktopSourceMaterializationIO } from "../../src/DesktopSourceMaterializationIO";
import { materializeSourceInstallation, type SourceNativeInstallationIO } from "../../src/SourceInstallationMaterialization";
import { stageSourceInstallationMapping } from "../../src/SourceInstallationMapping";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const encode = (value: string) => new TextEncoder().encode(value).buffer;
let directory: string, io: SourceInstallationStageIO, vault: Vault;
const journals: SourceSelectionJournal[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-same-folder-")); Object.assign(Platform, { isMobile: false });
	io = {
		mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		createDirectoryExclusive: async name => { await fs.mkdir(path.join(directory, name)); },
		write: (name, value) => fs.writeFile(path.join(directory, name), value),
		writeBinary: (name, value) => fs.writeFile(path.join(directory, name), new Uint8Array(value)),
		readBinary: async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer,
		stat: async name => {
			try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		},
	};
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory; vault = { adapter } as unknown as Vault;
});
afterEach(async () => {
	jest.restoreAllMocks(); journals.splice(0).forEach(journal => journal.close());
	await fs.rm(directory, { recursive: true, force: true });
});
async function fixture(options: { local?: Record<string, string>; server?: Record<string, string>; mode?: "new-folder" | "existing-folder" } = {}) {
	const local = options.local ?? { "Same.md": "Same", "Changed.md": "Local edit", "Only local.md": "Unshared work" };
	const server = options.server ?? { "Same.md": "Same", "Changed.md": "Restored content", "New.md": "New from server" };
	await io.mkdir("Team");
	for (const [name, text] of Object.entries(local)) {
		await io.mkdir(path.posix.dirname(`Team/${name}`)); await io.write(`Team/${name}`, text);
	}
	const backup = await prepareRecoveryBackup(io, async () => ({ files: Object.entries(local).map(([name, value]) => ({ path: `Team/${name}`, bytes: encode(value) })),
		documents: [], index: new Uint8Array([0, 0]) }), {});
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const capture: SourceInstallationCapture = { source, reviewId: crypto.randomUUID(), archive: backup.reference, originalRoot: "Team",
		destinationRoot: options.mode === "new-folder" ? "Separate" : "Team", mode: options.mode ?? "existing-folder",
		snapshot: { records: Object.fromEntries(Object.keys(server).map(name => [name, { id: crypto.randomUUID(), version: 0, type: ItemKind.Document }])),
			permissions: Object.fromEntries(Object.keys(server).map(name => [name, "read" as const])), activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration } };
	const downloads = {
		source: async (entry: { path: string }) => { const doc = new Y.Doc(); doc.getText("contents").insert(0, server[entry.path]); const update = Y.encodeStateAsUpdate(doc); doc.destroy(); return update; },
		attachment: async () => { throw new Error("Unexpected attachment"); },
		revalidate: async () => structuredClone(capture.snapshot),
	};
	const staged = await stageSourceInstallation(io, capture, downloads), native = createDesktopSameFolderInspectionIO(vault, "Team");
	const inspect = (host: SameFolderInspectionIO = native) => inspectSameFolderSource(io, host, staged.reference, capture);
	return { local, capture, downloads, staged, native, inspect, backup };
}

test("real files are compared with both verified backup and restored histories without a second working folder", async () => {
	const f = await fixture(), result = await f.inspect();
	expect(f.staged.plan).toMatchObject({ version: 2, mode: "existing-folder", originalRoot: "Team", destinationRoot: "Team" });
	expect(result.rows.map(row => [row.path, row.change, row.backupStatus])).toEqual([
		["Changed.md", "replace", "matches-backup"], ["New.md", "create", "absent"],
		["Only local.md", "local-only", "matches-backup"], ["Same.md", "unchanged", "matches-backup"],
	]);
	expect(result.rows.every(row => !row.pathConflict)).toBe(true);
	for (const [name, text] of Object.entries(f.local)) expect(await fs.readFile(path.join(directory, "Team", name), "utf8")).toBe(text);
	expect((await fs.readdir(path.join(directory, "Team"))).sort()).toEqual(Object.keys(f.local).sort());
	expect(await io.stat("Separate")).toBeNull();
	expect((await verifySourceInstallationPlan(io, f.staged.reference, f.capture)).plan).toEqual(f.staged.plan);
});

test("edits, deletions and new files after backup remain distinguishable from archived originals", async () => {
	const f = await fixture();
	await io.write("Team/Changed.md", "Edited after backup"); await fs.unlink(path.join(directory, "Team", "Same.md"));
	await io.write("Team/.hidden.md", "Never backed up");
	const result = await f.inspect();
	expect(result.rows).toEqual(expect.arrayContaining([
		expect.objectContaining({ path: "Changed.md", change: "replace", backupStatus: "changed-since-backup" }),
		expect.objectContaining({ path: "Same.md", change: "create", backupStatus: "changed-since-backup" }),
		expect.objectContaining({ path: ".hidden.md", change: "local-only", backupStatus: "not-backed-up" }),
	]));
	expect(await fs.readFile(path.join(directory, "Team", "Changed.md"), "utf8")).toBe("Edited after backup");
});

test("empty files and folders, local-only files and type conflicts are retained as distinct observations", async () => {
	const f = await fixture({ local: { "Empty.md": "", "Folder/Local.md": "Original" }, server: { "Empty.md": "", Folder: "Restored file" } });
	await io.mkdir("Team/Untracked empty folder"); await fs.unlink(path.join(directory, "Team", "Folder", "Local.md"));
	const result = await f.inspect();
	expect(result.rows).toEqual(expect.arrayContaining([
		expect.objectContaining({ path: "Empty.md", change: "unchanged", backupStatus: "matches-backup" }),
		expect.objectContaining({ path: "Folder", change: "type-conflict" }),
		expect.objectContaining({ path: "Folder/Local.md", change: "absent", backupStatus: "changed-since-backup" }),
		expect.objectContaining({ path: "Untracked empty folder", change: "local-only", backupStatus: "directory" }),
	]));
});

test("case aliases in parent folders are marked on descendants despite distinct file names", async () => {
	const f = await fixture({ local: { "notes/Local.md": "Local" }, server: { "Notes/Server.md": "Remote" } });
	const result = await f.inspect();
	expect(result.rows.find(row => row.path === "Notes/Server.md")).toMatchObject({ change: "create", pathConflict: true });
	expect(result.rows.find(row => row.path === "notes/Local.md")).toMatchObject({ change: "local-only", pathConflict: true });
});

test("a file blocking a selected parent directory marks every affected descendant", async () => {
	const f = await fixture({ local: { Folder: "Local file at folder path" }, server: { "Folder/Remote.md": "Restored" } });
	const result = await f.inspect();
	expect(result.rows.find(row => row.path === "Folder")).toMatchObject({ change: "type-conflict", pathConflict: true });
	expect(result.rows.find(row => row.path === "Folder/Remote.md")).toMatchObject({ change: "create", pathConflict: true });
});

test.each(["missing opt-in", "old version", "new mode old location", "different case root", "nested root"])("same-folder plans reject %s", async kind => {
	const f = await fixture(), plan: Record<string, unknown> = { ...f.staged.plan };
	if (kind === "missing opt-in") { delete f.capture.mode; await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow(); return; }
	if (kind === "old version") plan.version = 1;
	if (kind === "new mode old location") plan.destinationRoot = "Separate";
	if (kind === "different case root") plan.destinationRoot = "team";
	if (kind === "nested root") plan.destinationRoot = "Team/Nested";
	expect(() => parseSourceInstallationPlan(plan)).toThrow();
});

test("a damaged original-work archive prevents any native inspection", async () => {
	const f = await fixture(), stat = jest.spyOn(f.native, "stat");
	await io.write(`${f.backup.path}/files/Team/Changed.md`, "Corrupted archive");
	await expect(f.inspect()).rejects.toThrow("Recovery file verification failed"); expect(stat).not.toHaveBeenCalled();
});

test("new-folder plans and wrong native roots cannot become same-folder reviews", async () => {
	const f = await fixture({ mode: "new-folder" }), stat = jest.spyOn(f.native, "stat");
	await expect(f.inspect()).rejects.toThrow("reviewed existing folder"); expect(stat).not.toHaveBeenCalled();
	const g = await fixture({ local: {}, server: {} });
	await expect(g.inspect({ ...g.native, root: "Other" })).rejects.toThrow("reviewed existing folder");
});

test.each(["entries", "one file", "total bytes"])("the %s budget fails without returning a partial comparison", async kind => {
	const f = await fixture(), limits = kind === "entries" ? { maxNativeEntries: 1 } : kind === "one file" ? { maxFileBytes: 1 } : { maxTotalBytes: 1 };
	await expect(inspectSameFolderSource(io, f.native, f.staged.reference, f.capture, limits)).rejects.toThrow(/inspection.*limit|inspection limit/);
});

test.each(["symlink file", "symlink directory", "hard link"])("native inspection refuses a %s and leaves both targets unchanged", async kind => {
	const f = await fixture();
	if (kind === "hard link") await fs.link(path.join(directory, "Team", "Same.md"), path.join(directory, "Team", "Linked.md"));
	else await fs.symlink(kind === "symlink file" ? path.join(directory, "Team", "Same.md") : directory, path.join(directory, "Team", "Linked"));
	await expect(f.inspect()).rejects.toThrow("regular file");
	expect(await fs.readFile(path.join(directory, "Team", "Same.md"), "utf8")).toBe("Same");
});

test("a replaced native root cannot be adopted by an existing inspection adapter", async () => {
	const f = await fixture(); await f.native.stat("Team");
	await fs.rename(path.join(directory, "Team"), path.join(directory, "Moved")); await io.mkdir("Team");
	await expect(f.inspect()).rejects.toThrow("directory changed");
});

test("native reader enforces scope, byte limits and host capability", async () => {
	const f = await fixture();
	await expect(f.native.readBinary("Team/Same.md", 1)).rejects.toThrow("too large");
	await expect(f.native.stat("Team/../Other")).rejects.toThrow("unsafe relative path");
	await expect(f.native.stat("Team-other/Note.md")).rejects.toThrow("outside");
	Object.assign(Platform, { isMobile: true }); expect(() => createDesktopSameFolderInspectionIO(vault, "Team")).toThrow("host");
});

test("cancelled, timed-out and changed-context inspection never returns success", async () => {
	const f = await fixture(), controller = new AbortController(); controller.abort();
	await expect(inspectSameFolderSource(io, f.native, f.staged.reference, f.capture, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	await expect(inspectSameFolderSource(io, { ...f.native, list: () => new Promise(() => {}) }, f.staged.reference, f.capture, { timeoutMs: 5 })).rejects.toThrow("timed out");
	await expect(inspectSameFolderSource(io, f.native, f.staged.reference, f.capture, { check: () => { throw new Error("account changed"); } })).rejects.toThrow("account changed");
});

test("same-folder preparation survives journal reopen but cannot use the new-folder mutation paths", async () => {
	const f = await fixture(), journal = await SourceSelectionJournal.open(f.capture.source); journals.push(journal);
	const review = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId: f.capture.reviewId, restoreGeneration: f.capture.source.restoreGeneration! });
	const prepared = await prepareSourceInstallation(journal, io, { ...f.capture, reviewRevision: review.revision!, operationId: crypto.randomUUID() }, f.downloads);
	journal.close(); const reopened = await SourceSelectionJournal.open(f.capture.source); journals.push(reopened);
	expect((await reopened.read()).pending?.preparation?.plan).toEqual(prepared.staged.reference);
	const native: SourceNativeInstallationIO = { ...f.native, nativeWriteOwner: vault, claim: jest.fn(), createDirectoryExclusive: jest.fn(), createFileExclusive: jest.fn() };
	const request = { source: f.capture.source, reviewId: f.capture.reviewId, revision: prepared.selection.revision!, operationId: prepared.selection.pending!.preparation!.activation!.startOperationId };
	await expect(materializeSourceInstallation(reopened, io, native, request)).rejects.toThrow("replacement coordinator");
	expect(native.claim).not.toHaveBeenCalled(); expect(native.createFileExclusive).not.toHaveBeenCalled();
	expect((await reopened.read()).pending?.phase).toBe("prepared");
	expect(() => createDesktopSourceMaterializationIO(vault, prepared.staged.plan)).toThrow("new-folder");
	const applying = await reopened.apply({ type: "start", expectedRevision: request.revision, operationId: request.operationId, reviewId: request.reviewId });
	const settings = { readValue: jest.fn(), readPersistedValue: jest.fn(), mutateValue: jest.fn() };
	await expect(stageSourceInstallationMapping(reopened, io, settings, { ...request, revision: applying.revision! })).rejects.toThrow("own activation coordinator");
	expect(settings.mutateValue).not.toHaveBeenCalled();
	expect(await fs.readFile(path.join(directory, "Team", "Changed.md"), "utf8")).toBe("Local edit");
});
