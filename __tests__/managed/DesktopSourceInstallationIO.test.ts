import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileSystemAdapter, Platform, type Vault } from "obsidian";
import { createDesktopSourceInstallationIO } from "../../src/DesktopSourceInstallationIO";
import { sourceInstallationPath } from "../../src/SourceInstallationPlan";
import { RECOVERY_FOLDER } from "../../src/conflictCopyPath";
import * as Y from "yjs";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { stageSourceInstallation, type SourceInstallationCapture } from "../../src/SourceInstallationStaging";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { ItemKind } from "../../src/ItemKinds";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const root = sourceInstallationPath("11111111-1111-4111-8111-111111111111"), parent = root.slice(0, root.lastIndexOf("/"));
let directory: string, vault: Vault;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-desktop-staging-")); Object.assign(Platform, { isMobile: false });
	const adapter = new FileSystemAdapter();
	adapter.getBasePath = () => directory;
	adapter.stat = async name => {
		try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size, ctime: value.ctimeMs, mtime: value.mtimeMs }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	};
	adapter.readBinary = async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer;
	vault = { adapter, createFolder: jest.fn(() => { throw new Error("Unsafe non-exclusive create"); }), createBinary: jest.fn(() => { throw new Error("Unsafe non-exclusive write"); }) } as unknown as Vault;
});
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
	await fs.rm(directory + "-outside", { recursive: true, force: true });
	await fs.rm(directory + "-moved", { recursive: true, force: true });
});

test("desktop staging uses exclusive OS creation and does not call Obsidian's check-then-write API", async () => {
	const io = createDesktopSourceInstallationIO(vault);
	await io.mkdir(parent); await io.createDirectoryExclusive(root); await io.write(root + "/plan.json", "original");
	expect(new TextDecoder().decode(await io.readBinary(root + "/plan.json"))).toBe("original");
	await expect(io.write(root + "/plan.json", "replacement")).rejects.toThrow();
	expect(await fs.readFile(path.join(directory, root, "plan.json"), "utf8")).toBe("original");
	expect(vault.createBinary).not.toHaveBeenCalled(); expect(vault.createFolder).not.toHaveBeenCalled();
});

test("concurrent staging roots have exactly one creator", async () => {
	const first = createDesktopSourceInstallationIO(vault), second = createDesktopSourceInstallationIO(vault);
	await first.mkdir(parent);
	const results = await Promise.allSettled([first.createDirectoryExclusive(root), second.createDirectoryExclusive(root)]);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
});

test("recovery directory links are refused before writing outside the vault", async () => {
	await fs.mkdir(directory + "-outside"); await fs.writeFile(path.join(directory + "-outside", "sentinel"), "retained");
	await fs.symlink(directory + "-outside", path.join(directory, RECOVERY_FOLDER));
	const io = createDesktopSourceInstallationIO(vault);
	await expect(io.mkdir(parent)).rejects.toThrow("not a regular directory");
	expect(await fs.readdir(directory + "-outside")).toEqual(["sentinel"]);
});

test("an existing artifact symlink cannot overwrite its target", async () => {
	const io = createDesktopSourceInstallationIO(vault); await io.mkdir(parent); await io.createDirectoryExclusive(root);
	const outside = path.join(directory, "original.txt"); await fs.writeFile(outside, "original");
	await fs.symlink(outside, path.join(directory, root, "plan.json"));
	await expect(io.write(root + "/plan.json", "replacement")).rejects.toThrow();
	expect(await fs.readFile(outside, "utf8")).toBe("original");
});

test("replacing the underlying vault directory invalidates future creation", async () => {
	const io = createDesktopSourceInstallationIO(vault); await io.mkdir(parent);
	await fs.rename(directory, directory + "-moved"); await fs.mkdir(directory);
	await expect(io.mkdir(parent)).rejects.toThrow("location changed"); expect(await fs.readdir(directory)).toEqual([]);
});

test("changing the configured vault adapter invalidates the captured host", async () => {
	const io = createDesktopSourceInstallationIO(vault); await io.mkdir(parent);
	Object.assign(vault, { adapter: new FileSystemAdapter() });
	await expect(io.createDirectoryExclusive(root)).rejects.toThrow("vault changed");
});

test("unsupported/mobile adapters fail before staging or a buffered native fallback", () => {
	Object.assign(Platform, { isMobile: true });
	expect(() => createDesktopSourceInstallationIO(vault)).toThrow("does not provide exclusive");
	Object.assign(Platform, { isMobile: false }); Object.assign(vault, { adapter: {} });
	expect(() => createDesktopSourceInstallationIO(vault)).toThrow("does not provide exclusive");
});

test("the production desktop adapter stages and verifies a complete plan while preserving original files", async () => {
	const encode = (text: string) => new TextEncoder().encode(text).buffer;
	await fs.mkdir(path.join(directory, "Team")); await fs.writeFile(path.join(directory, "Team", "Note.md"), "Original");
	const backupIO = { stat: vault.adapter.stat.bind(vault.adapter), readBinary: vault.adapter.readBinary.bind(vault.adapter),
		mkdir: async (name: string) => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		write: (name: string, text: string) => fs.writeFile(path.join(directory, name), text),
		writeBinary: (name: string, data: ArrayBuffer) => fs.writeFile(path.join(directory, name), new Uint8Array(data)),
	};
	const backup = await prepareRecoveryBackup(backupIO, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const note = crypto.randomUUID(), generation = crypto.randomUUID(), doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored");
	const update = Y.encodeStateAsUpdate(doc); doc.destroy();
	const capture: SourceInstallationCapture = { reviewId: crypto.randomUUID(), archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team",
		source: { hostAppId: "fixture", serverId: "source", controlPlaneUrl: "https://source.test", s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: generation },
		snapshot: { records: { "Note.md": { id: note, type: ItemKind.Document, version: 0 } }, permissions: { "Note.md": "read" }, activity: {}, owner: false, restore_guard: true, restore_generation: generation } };
	const staged = await stageSourceInstallation(createDesktopSourceInstallationIO(vault), capture, { source: async () => update, attachment: async () => { throw new Error("No attachment expected"); } });
	expect(await fs.readFile(path.join(directory, staged.path, "files", note + ".bin"), "utf8")).toBe("Restored");
	expect(staged.plan.source).toEqual(capture.source);
	expect(await fs.readFile(path.join(directory, "Team", "Note.md"), "utf8")).toBe("Original");
	await expect(fs.stat(path.join(directory, "Restored Team"))).rejects.toMatchObject({ code: "ENOENT" });
});
