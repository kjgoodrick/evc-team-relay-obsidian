import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as Y from "yjs";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { createDesktopSourceInstallationIO } from "../../src/DesktopSourceInstallationIO";
import { createDesktopSourceMaterializationIO } from "../../src/DesktopSourceMaterializationIO";
import { INSTALLATION_METADATA, materializeSourceInstallation } from "../../src/SourceInstallationMaterialization";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation } from "../../src/SourceInstallationStaging";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";
import { trackNativeSourceMutation } from "../../src/storage/native-document-writes";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const digest = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
let directory: string, vault: Vault;
const journals: SourceSelectionJournal[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-installation-")); Object.assign(Platform, { isMobile: false });
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory;
	adapter.stat = async name => {
		try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size, ctime: value.ctimeMs, mtime: value.mtimeMs }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	};
	adapter.readBinary = async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer;
	vault = { adapter, createBinary: jest.fn(() => { throw new Error("Unsafe native write"); }), createFolder: jest.fn(() => { throw new Error("Unsafe native mkdir"); }) } as unknown as Vault;
});
afterEach(async () => {
	jest.restoreAllMocks(); journals.splice(0).forEach(journal => journal.close());
	await fs.rm(directory, { recursive: true, force: true });
	await fs.rm(directory + "-moved", { recursive: true, force: true });
});
async function fixture() {
	await fs.mkdir(path.join(directory, "Team")); await fs.writeFile(path.join(directory, "Team", "Note.md"), "Original offline work");
	const backup = await prepareRecoveryBackup({ stat: vault.adapter.stat.bind(vault.adapter), readBinary: vault.adapter.readBinary.bind(vault.adapter),
		mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		write: (name, text) => fs.writeFile(path.join(directory, name), text),
		writeBinary: (name, data) => fs.writeFile(path.join(directory, name), new Uint8Array(data)),
	}, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original offline work") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored source"); const update = Y.encodeStateAsUpdate(doc); doc.destroy();
	const image = encode("Synthetic attachment"), noteId = crypto.randomUUID();
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const reviewId = crypto.randomUUID(), staging = createDesktopSourceInstallationIO(vault);
	const staged = await stageSourceInstallation(staging, { source, reviewId, archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team",
		snapshot: { records: {
			"Notes/Note.md": { id: noteId, version: 0, type: ItemKind.Document },
			"Empty": { id: crypto.randomUUID(), version: 0, type: ItemKind.Folder },
			"Picture.png": { id: crypto.randomUUID(), version: 0, type: ItemKind.Image, hash: digest(image), synctime: 1, mimetype: "image/png" },
		}, permissions: { "Notes/Note.md": "read", Empty: "read", "Picture.png": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration },
	}, { source: async () => update, attachment: async () => image });
	const journal = await SourceSelectionJournal.open(source); journals.push(journal);
	let selection = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration });
	selection = await journal.apply({ type: "prepare", expectedRevision: selection.revision, operationId: crypto.randomUUID(), reviewId,
		preparation: { archive: backup.reference, plan: staged.reference } });
	const request = { source, reviewId, revision: selection.revision!, operationId: crypto.randomUUID() };
	return { journal, staging, staged, request, image, noteId, native: createDesktopSourceMaterializationIO(vault, staged.plan) };
}
const installed = (name: string) => path.join(directory, "Restored Team", name);
async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
	f.journal.close(); const journal = await SourceSelectionJournal.open(f.request.source); journals.push(journal);
	const request = { ...f.request, revision: (await journal.read()).revision! };
	return { journal, request, native: createDesktopSourceMaterializationIO(vault, f.staged.plan) };
}

test("real desktop installation preserves originals and source artifacts, creates implicit/empty directories, and stays paused", async () => {
	const f = await fixture(), result = await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	expect(result).toMatchObject({ created: 2, resumed: 0, destinationRoot: "Restored Team" });
	expect(result.selection.pending?.phase).toBe("applying"); expect(result.selection.active).toEqual({ kind: "legacy" });
	expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("Restored source");
	expect(await fs.readdir(installed("Empty"))).toEqual([]);
	expect(await fs.readFile(installed("Picture.png"), "utf8")).toBe("Synthetic attachment");
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe("Original offline work");
	expect(await f.staging.stat(`${f.staged.path}/sources/${f.noteId}.yjs`)).toMatchObject({ type: "file" });
	expect(vault.createBinary).not.toHaveBeenCalled(); expect(vault.createFolder).not.toHaveBeenCalled();
	const again = await reopen(f), resumed = await materializeSourceInstallation(again.journal, f.staging, again.native, again.request);
	expect(resumed).toMatchObject({ created: 0, resumed: 2 }); expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
});

test("lost completion after the first published file resumes by verifying bytes after a journal/adapter restart", async () => {
	const f = await fixture(); let interrupted = false;
	const native = { ...f.native, createFileExclusive: async (name: string, bytes: ArrayBuffer) => {
		await f.native.createFileExclusive(name, bytes); if (!interrupted) { interrupted = true; throw new Error("Simulated lost completion"); }
	} };
	await expect(materializeSourceInstallation(f.journal, f.staging, native, f.request)).rejects.toThrow("lost completion");
	const next = await reopen(f), result = await materializeSourceInstallation(next.journal, f.staging, next.native, next.request);
	expect(result).toMatchObject({ created: 1, resumed: 1 });
});

test.each(["file changed", "unexpected file", "unexpected folder", "missing marker", "wrong marker", "symlink", "hard link"])("restart preserves and refuses %s", async kind => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	if (kind === "file changed") await fs.writeFile(installed("Notes/Note.md"), "User-edited restored note");
	if (kind === "unexpected file") await fs.writeFile(installed("New.md"), "New local work");
	if (kind === "unexpected folder") await fs.mkdir(installed("New"));
	if (kind === "missing marker") await fs.unlink(installed(`${INSTALLATION_METADATA}/owner.json`));
	if (kind === "wrong marker") await fs.writeFile(installed(`${INSTALLATION_METADATA}/owner.json`), "Different installation");
	if (kind === "symlink" || kind === "hard link") {
		await fs.unlink(installed("Notes/Note.md"));
		await (kind === "symlink" ? fs.symlink : fs.link)(path.join(directory, "Team", "Note.md"), installed("Notes/Note.md"));
	}
	const before = await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8"), next = await reopen(f);
	await expect(materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).rejects.toThrow();
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe(before);
	expect((await next.journal.read()).pending?.phase).toBe("applying");
	if (kind === "file changed") expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("User-edited restored note");
	if (kind === "unexpected file") expect(await fs.readFile(installed("New.md"), "utf8")).toBe("New local work");
});

test("an existing unowned empty destination is never adopted", async () => {
	const f = await fixture(); await fs.mkdir(installed(""));
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("no installation ownership marker");
	expect(await fs.readdir(installed(""))).toEqual([]);
});

test("a failed publication leaves no partial final file and can resume", async () => {
	const f = await fixture(), nativeFS = require("fs/promises") as typeof fs, link = nativeFS.link;
	let failed = false;
	jest.spyOn(nativeFS, "link").mockImplementation(async (temporary, destination) => {
		if (!failed) {
			failed = true; expect(await fs.readFile(temporary, "utf8")).toBe("Restored source");
			await expect(fs.stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
			throw new Error("Simulated publication failure");
		}
		return link(temporary, destination);
	});
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("publication failure");
	expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
	const next = await reopen(f); expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 2, resumed: 0 });
});

test("cancellation during a native operation waits for settlement and retains both write holds", async () => {
	const f = await fixture(), controller = new AbortController();
	let release!: () => void, started!: () => void;
	const entered = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
	const native = { ...f.native, createFileExclusive: async (name: string, bytes: ArrayBuffer) => { started(); await gate; await f.native.createFileExclusive(name, bytes); } };
	let settled = false;
	const operation = materializeSourceInstallation(f.journal, f.staging, native, f.request, { signal: controller.signal });
	void operation.then(() => { settled = true; }, () => { settled = true; });
	await entered; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
	for (const target of ["Team/Note.md", "Restored Team/Picture.png"]) await expect(trackNativeSourceMutation(vault, [target], async () => {})).rejects.toThrow("paused");
	release(); await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	await expect(trackNativeSourceMutation(vault, ["Team/Note.md"], async () => {})).resolves.toBeUndefined();
	const next = await reopen(f); expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 1, resumed: 1 });
});

test("changed journal cannot start native creation", async () => {
	const f = await fixture();
	await f.journal.apply({ type: "cancel", expectedRevision: f.request.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId });
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("selection changed");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
});

test("staged corruption is rejected before starting installation", async () => {
	const f = await fixture(); await fs.writeFile(path.join(directory, f.staged.path, "files", f.noteId + ".bin"), "Changed source");
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow();
	expect((await f.journal.read()).pending?.phase).toBe("prepared");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
});

test("an uncertain start response writes no native files and resumes from the saved applying state", async () => {
	const f = await fixture(), apply = f.journal.apply.bind(f.journal);
	jest.spyOn(f.journal, "apply").mockImplementation(async command => {
		const state = await apply(command); if (command.type === "start") throw new Error("Lost journal response"); return state;
	});
	await expect(materializeSourceInstallation(f.journal, f.staging, f.native, f.request)).rejects.toThrow("Lost journal response");
	expect((await f.journal.read()).pending?.phase).toBe("applying");
	await expect(fs.stat(installed(""))).rejects.toMatchObject({ code: "ENOENT" });
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 2, resumed: 0 });
});

test("mobile fails explicitly without using a non-exclusive Vault fallback", async () => {
	const f = await fixture(); Object.assign(Platform, { isMobile: true });
	expect(() => createDesktopSourceMaterializationIO(vault, f.staged.plan)).toThrow("does not provide exclusive");
});

test("restart removes only owned interrupted temporary bytes, including the link-publication crash window", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await fs.link(installed("Notes/Note.md"), installed(`${INSTALLATION_METADATA}/${crypto.randomUUID()}.tmp`));
	await fs.writeFile(installed(`${INSTALLATION_METADATA}/${crypto.randomUUID()}.tmp`), "Partial unpublished bytes");
	const next = await reopen(f);
	expect(await materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).toMatchObject({ created: 0, resumed: 2 });
	expect(await fs.readdir(installed(INSTALLATION_METADATA))).toEqual(["owner.json"]);
	expect((await fs.stat(installed("Notes/Note.md"))).nlink).toBe(1);
});

test.each(["unknown control file", "linked temporary file"])("unexpected ownership-directory content is retained: %s", async kind => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	const name = kind === "unknown control file" ? "personal-note.md" : crypto.randomUUID() + ".tmp";
	if (kind === "unknown control file") await fs.writeFile(installed(`${INSTALLATION_METADATA}/${name}`), "Retained work");
	else await fs.symlink(path.join(directory, "Team", "Note.md"), installed(`${INSTALLATION_METADATA}/${name}`));
	const next = await reopen(f);
	await expect(materializeSourceInstallation(next.journal, f.staging, next.native, next.request)).rejects.toThrow();
	expect(await fs.lstat(installed(`${INSTALLATION_METADATA}/${name}`))).toBeTruthy();
});

test("the native adapter refuses existing final files even if their size matches", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await expect(f.native.createFileExclusive("Restored Team/Notes/Note.md", encode("Different bytes"))).rejects.toMatchObject({ code: "EEXIST" });
	expect(await fs.readFile(installed("Notes/Note.md"), "utf8")).toBe("Restored source");
});

test("replacing the destination or vault directory invalidates a captured native adapter", async () => {
	const f = await fixture(); await materializeSourceInstallation(f.journal, f.staging, f.native, f.request);
	await fs.rename(installed(""), path.join(directory, "Moved restore")); await fs.mkdir(installed(""));
	await expect(f.native.stat("Restored Team")).rejects.toThrow("destination changed");
	await fs.rename(directory, directory + "-moved"); await fs.mkdir(directory);
	await expect(f.native.stat("Restored Team")).rejects.toThrow("vault location changed");
});
