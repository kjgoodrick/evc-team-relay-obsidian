import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Y from "yjs";
import { ItemKind } from "../../src/ItemKinds";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import type { SourceInstallationStageIO } from "../../src/SourceInstallationStaging";
import { prepareSourceInstallation, type SourcePreparationDownloads, type SourcePreparationRequest } from "../../src/SourceInstallationPreparation";

let root: string, io: SourceInstallationStageIO;
const journals: SourceSelectionJournal[] = [];
const encode = (value: string) => new TextEncoder().encode(value).buffer;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-source-preparation-"));
	io = {
		mkdir: async name => { await fs.mkdir(path.join(root, name), { recursive: true }); },
		createDirectoryExclusive: async name => { await fs.mkdir(path.join(root, name)); },
		write: (name, text) => fs.writeFile(path.join(root, name), text),
		writeBinary: (name, bytes) => fs.writeFile(path.join(root, name), new Uint8Array(bytes)),
		readBinary: async name => new Uint8Array(await fs.readFile(path.join(root, name))).buffer,
		stat: async name => { try { const stat = await fs.stat(path.join(root, name)); return { type: stat.isFile() ? "file" : "folder", size: stat.size }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
	};
});
afterEach(async () => { journals.splice(0).forEach(journal => journal.close()); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
	await io.mkdir("Team"); await io.write("Team/Note.md", "Original");
	const backup = await prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const journal = await SourceSelectionJournal.open(source); journals.push(journal);
	const reviewId = crypto.randomUUID(), entryId = crypto.randomUUID();
	const state = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration, expectedRevision: null });
	const input: SourcePreparationRequest = { source, reviewId, reviewRevision: state.revision!, operationId: crypto.randomUUID(), archive: backup.reference,
		originalRoot: "Team", destinationRoot: "Restored", snapshot: { records: { "Note.md": { id: entryId, version: 0, type: ItemKind.Document } },
			permissions: { "Note.md": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration } };
	const document = new Y.Doc(); document.getText("contents").insert(0, "Restored"); const update = Y.encodeStateAsUpdate(document); document.destroy();
	const downloads: jest.Mocked<SourcePreparationDownloads> = {
		source: jest.fn<ReturnType<SourcePreparationDownloads["source"]>, Parameters<SourcePreparationDownloads["source"]>>(async () => new Uint8Array(update)),
		attachment: jest.fn<ReturnType<SourcePreparationDownloads["attachment"]>, Parameters<SourcePreparationDownloads["attachment"]>>(async () => { throw new Error("Unexpected attachment"); }),
		revalidate: jest.fn<ReturnType<SourcePreparationDownloads["revalidate"]>, Parameters<SourcePreparationDownloads["revalidate"]>>(async () => JSON.parse(JSON.stringify(input.snapshot))),
	};
	return { journal, input, downloads, state, update };
}

test("only verified artifacts and a fresh unchanged inventory can prepare the durable selection", async () => {
	const f = await fixture(), result = await prepareSourceInstallation(f.journal, io, f.input, f.downloads);
	expect(result.selection.pending).toMatchObject({ phase: "prepared", reviewId: f.input.reviewId, preparation: { plan: result.staged.reference, archive: f.input.archive } });
	expect(result.selection.active).toEqual({ kind: "legacy" }); expect(await f.journal.read()).toEqual(result.selection);
	expect(f.downloads.revalidate).toHaveBeenCalledTimes(1); expect(f.downloads.revalidate).toHaveBeenCalledWith(f.input.source);
	expect(await io.stat("Restored")).toBeNull(); expect(new TextDecoder().decode(await io.readBinary("Team/Note.md"))).toBe("Original");
	f.journal.close(); const reopened = await SourceSelectionJournal.open(f.input.source); journals.push(reopened);
	expect(await reopened.read()).toEqual(result.selection);
	await expect(reopened.assertActive(result.selection.revision, result.selection.active)).rejects.toThrow("awaiting recovery");
});

test.each(["scope", "revision", "generation", "review"])("a changed %s refuses preparation before staging", async kind => {
	const f = await fixture(), create = jest.spyOn(io, "createDirectoryExclusive");
	if (kind === "scope") f.input.source.serverId = "different";
	if (kind === "revision") f.input.reviewRevision = crypto.randomUUID();
	if (kind === "generation") f.input.source = { ...f.input.source, restoreGeneration: crypto.randomUUID() };
	if (kind === "review") f.input.reviewId = crypto.randomUUID();
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads)).rejects.toThrow();
	expect(create).not.toHaveBeenCalled(); expect(f.downloads.source).not.toHaveBeenCalled(); expect(await f.journal.read()).toEqual(f.state);
});

test("cancelling the durable review while a source downloads cannot prepare its old capture", async () => {
	const f = await fixture(); f.downloads.source.mockImplementation(async () => {
		await f.journal.apply({ type: "cancel", operationId: crypto.randomUUID(), reviewId: f.input.reviewId, expectedRevision: f.state.revision }); return f.update;
	});
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads)).rejects.toThrow("review changed");
	expect((await f.journal.read()).pending).toBeNull(); expect(f.downloads.revalidate).not.toHaveBeenCalled();
});

test.each(["generation", "record", "permission", "activity", "owner"])("changed fresh server %s leaves the journal in review", async kind => {
	const f = await fixture(), fresh = JSON.parse(JSON.stringify(f.input.snapshot));
	if (kind === "generation") fresh.restore_generation = crypto.randomUUID();
	if (kind === "record") fresh.records = {};
	if (kind === "permission") fresh.permissions["Note.md"] = "write";
	if (kind === "activity") fresh.activity[f.input.snapshot.records["Note.md"].id] = "new activity";
	if (kind === "owner") fresh.owner = true;
	f.downloads.revalidate.mockResolvedValue(fresh);
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads)).rejects.toThrow();
	expect(await f.journal.read()).toEqual(f.state); expect(await io.stat("Restored")).toBeNull();
});

test("competing preparations retain both artifact directories but only one journal decision wins", async () => {
	const f = await fixture(), other = await SourceSelectionJournal.open(f.input.source); journals.push(other);
	let release!: () => void, readers = 0; const barrier = new Promise<void>(resolve => { release = resolve; });
	f.downloads.revalidate.mockImplementation(async () => { if (++readers === 2) release(); await barrier; return f.input.snapshot; });
	const results = await Promise.allSettled([
		prepareSourceInstallation(f.journal, io, f.input, f.downloads),
		prepareSourceInstallation(other, io, { ...f.input, operationId: crypto.randomUUID() }, f.downloads),
	]);
	expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
	expect((await f.journal.read()).pending?.phase).toBe("prepared"); expect(await other.read()).toEqual(await f.journal.read());
	expect(await io.stat("Restored")).toBeNull();
});

test("corrupt readback stops before revalidation or journal preparation", async () => {
	const f = await fixture(), write = io.writeBinary;
	io.writeBinary = (name, bytes) => write(name, name.endsWith("/plan.json") ? encode("Corrupt") : bytes);
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads)).rejects.toThrow();
	expect(f.downloads.revalidate).not.toHaveBeenCalled(); expect(await f.journal.read()).toEqual(f.state);
});

test("a late revalidation cannot advance the journal after cancellation", async () => {
	const f = await fixture(), abort = new AbortController(); let finish!: (value: typeof f.input.snapshot) => void;
	const started = new Promise<void>(resolve => { f.downloads.revalidate.mockImplementation(() => { resolve(); return new Promise(done => { finish = done; }); }); });
	const pending = prepareSourceInstallation(f.journal, io, f.input, f.downloads, { signal: abort.signal });
	await started; abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	finish(f.input.snapshot); await new Promise(resolve => setTimeout(resolve, 0)); expect(await f.journal.read()).toEqual(f.state);
});

test("a cancellation at the commit boundary leaves a durable prepared decision for reconciliation", async () => {
	const f = await fixture(), abort = new AbortController(), apply = f.journal.apply.bind(f.journal);
	jest.spyOn(f.journal, "apply").mockImplementation(async command => { const result = await apply(command); abort.abort(); return result; });
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads, { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
	expect((await f.journal.read()).pending?.phase).toBe("prepared");
	expect((await f.journal.read()).active).toEqual({ kind: "legacy" }); expect(await io.stat("Restored")).toBeNull();
});

test("a stalled fresh inventory read times out without preparing the journal", async () => {
	const f = await fixture(); f.downloads.revalidate.mockImplementation(() => new Promise(() => {}));
	await expect(prepareSourceInstallation(f.journal, io, f.input, f.downloads, { timeoutMs: 500 })).rejects.toThrow("Rechecking the installation inventory timed out");
	expect(await f.journal.read()).toEqual(f.state);
});
