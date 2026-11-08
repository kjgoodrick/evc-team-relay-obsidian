import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Y from "yjs";
import { createHash } from "node:crypto";
import { ItemKind } from "../../src/ItemKinds";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { stageSourceInstallation, type SourceInstallationStageIO, type SourceInstallationCapture, type SourceInstallationDownloads } from "../../src/SourceInstallationStaging";
import { verifySourceInstallationPlan } from "../../src/SourceInstallationPlan";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const hash = (bytes: ArrayBuffer) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
let root: string, io: SourceInstallationStageIO;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-source-staging-"));
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
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
	await io.mkdir("Team"); await io.write("Team/Note.md", "Original native text");
	const backup = await prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original native text") }], documents: [], index: new Uint8Array([0, 0]) }), {});
	const picture = new Uint8Array([1, 2, 3]).buffer, doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored source");
	const update = Y.encodeStateAsUpdate(doc); doc.destroy();
	const capture: SourceInstallationCapture = { reviewId: id(1), source: { hostAppId: "fixture", serverId: "server", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", id(2))), restoreGeneration: id(3) },
		archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team", snapshot: {
			records: { "Note.md": { id: id(4), version: 0, type: ItemKind.Document }, "Picture.png": { id: id(5), version: 0, type: ItemKind.Image,
				hash: hash(picture), mimetype: "image/png", synctime: 1 } }, permissions: { "Note.md": "read", "Picture.png": "read" }, activity: {}, owner: false,
			restore_guard: true, restore_generation: id(3),
		} };
	const downloads: jest.Mocked<SourceInstallationDownloads> = {
		source: jest.fn<ReturnType<SourceInstallationDownloads["source"]>, Parameters<SourceInstallationDownloads["source"]>>(async () => new Uint8Array(update)),
		attachment: jest.fn<ReturnType<SourceInstallationDownloads["attachment"]>, Parameters<SourceInstallationDownloads["attachment"]>>(async () => picture.slice(0)),
	};
	return { capture, downloads, backup };
}

test("staging returns only a fully verified plan in a unique recovery directory, preserving native originals", async () => {
	const f = await fixture(), first = await stageSourceInstallation(io, f.capture, f.downloads);
	expect(first.plan.entries.map(entry => entry.path)).toEqual(["Note.md", "Picture.png"]);
	expect(new TextDecoder().decode(await io.readBinary(`${first.path}/files/${id(4)}.bin`))).toBe("Restored source");
	expect(new Uint8Array(await io.readBinary(`${first.path}/files/${id(5)}.bin`))).toEqual(new Uint8Array([1, 2, 3]));
	expect(new TextDecoder().decode(await io.readBinary("Team/Note.md"))).toBe("Original native text");
	expect(await io.stat("Restored Team")).toBeNull();
	expect(f.downloads.source).toHaveBeenCalledWith(expect.objectContaining({ path: "Note.md" }), f.capture.source, 16 * 1024 * 1024);
	expect(f.downloads.attachment).toHaveBeenCalledWith(expect.objectContaining({ path: "Picture.png" }), f.capture.source, 256 * 1024 * 1024);
	expect((await verifySourceInstallationPlan(io, first.reference, f.capture)).plan).toEqual(first.plan);
	const second = await stageSourceInstallation(io, f.capture, f.downloads); expect(second.path).not.toBe(first.path);
	expect(await io.stat(`${first.path}/plan.json`)).toMatchObject({ type: "file" });
});

test("input and callback mutations cannot rewrite captured scope, records or handlers", async () => {
	const f = await fixture(), generation = f.capture.source.restoreGeneration;
	f.downloads.source.mockImplementation(async (...args: unknown[]) => {
		(args[0] as { path: string }).path = "Changed.md";
		const doc = new Y.Doc(); doc.getText("contents").insert(0, "Restored source"); const update = Y.encodeStateAsUpdate(doc); doc.destroy(); return update;
	});
	const pending = stageSourceInstallation(io, f.capture, f.downloads);
	f.capture.source = { ...f.capture.source, restoreGeneration: id(99) }; f.capture.snapshot.records["Note.md"].id = id(99);
	f.downloads.attachment = jest.fn<ReturnType<SourceInstallationDownloads["attachment"]>, Parameters<SourceInstallationDownloads["attachment"]>>(async () => encode("changed callback"));
	const result = await pending; expect(result.plan.source.restoreGeneration).toBe(generation);
	expect(result.plan.entries[0]).toMatchObject({ path: "Note.md", record: { id: id(4) } });
});

test("an exclusive-directory conflict never reuses or modifies another staging directory", async () => {
	const f = await fixture(); let occupied = "";
	io.createDirectoryExclusive = async name => { occupied = name; await io.mkdir(name); await io.write(`${name}/sentinel.txt`, "Existing work"); throw new Error("exists"); };
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("exists");
	expect(new TextDecoder().decode(await io.readBinary(`${occupied}/sentinel.txt`))).toBe("Existing work");
	expect(await fs.readdir(path.join(root, occupied))).toEqual(["sentinel.txt"]);
	expect(f.downloads.source).not.toHaveBeenCalled();
});

test("damaged recovery archives and changed manifest generations fail before creating staging", async () => {
	const f = await fixture(), create = jest.spyOn(io, "createDirectoryExclusive");
	f.capture.snapshot.restore_generation = id(99);
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("selected source plan");
	f.capture.snapshot.restore_generation = id(3); await io.write(`${f.backup.path}/files/Team/Note.md`, "Damaged");
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("Recovery file verification failed");
	expect(create).not.toHaveBeenCalled();
});

test("wrong attachment bytes leave incomplete staging without a usable plan", async () => {
	const f = await fixture(), create = jest.spyOn(io, "createDirectoryExclusive");
	f.downloads.attachment.mockResolvedValue(encode("Wrong revision"));
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("captured inventory");
	const directory = create.mock.calls[0][0]; expect(await io.stat(`${directory}/plan.json`)).toBeNull();
	expect(await io.stat(`${directory}/files/${id(4)}.bin`)).toMatchObject({ type: "file" });
	expect(await io.stat("Restored Team")).toBeNull();
});

test.each(["native", "plan"])("corrupt %s writeback cannot return a verified plan", async kind => {
	const f = await fixture(), write = io.writeBinary;
	io.writeBinary = (name, bytes) => write(name, name.endsWith(kind === "plan" ? "/plan.json" : `/files/${id(4)}.bin`) ? encode("Corrupt") : bytes);
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow();
	expect(new TextDecoder().decode(await io.readBinary("Team/Note.md"))).toBe("Original native text");
});

test("a cancelled download cannot continue after its late completion", async () => {
	const f = await fixture(), abort = new AbortController(); let finish!: (value: Uint8Array) => void;
	const started = new Promise<void>(resolve => { f.downloads.source.mockImplementation(() => { resolve(); return new Promise(done => { finish = done; }); }); });
	const write = jest.spyOn(io, "writeBinary"), pending = stageSourceInstallation(io, f.capture, f.downloads, { signal: abort.signal });
	await started; abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	const calls = write.mock.calls.length; finish(new Uint8Array([0, 0])); await new Promise(resolve => setTimeout(resolve, 0));
	expect(write).toHaveBeenCalledTimes(calls); expect(f.downloads.attachment).not.toHaveBeenCalled();
});

test("cancelling a pending native staging write cannot publish its plan after the write finishes", async () => {
	const f = await fixture(), abort = new AbortController(), write = io.writeBinary;
	let finish!: () => void, completed!: Promise<void>;
	const started = new Promise<void>(resolve => { io.writeBinary = async (name, bytes) => {
		if (!name.endsWith(`/files/${id(4)}.bin`)) return write(name, bytes);
		await new Promise<void>(done => { finish = done; resolve(); });
		completed = write(name, bytes); await completed;
	}; });
	const create = jest.spyOn(io, "createDirectoryExclusive"), pending = stageSourceInstallation(io, f.capture, f.downloads, { signal: abort.signal });
	await started; abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	finish(); await new Promise(resolve => setTimeout(resolve, 0)); await completed;
	const directory = create.mock.calls[0][0]; expect(await io.stat(`${directory}/plan.json`)).toBeNull();
	expect(f.downloads.attachment).not.toHaveBeenCalled(); expect(await io.stat("Restored Team")).toBeNull();
});

test("a stalled download times out and context changes stop before further staging", async () => {
	const f = await fixture(); f.downloads.source.mockImplementation(() => new Promise(() => {}));
	await expect(stageSourceInstallation(io, f.capture, f.downloads, { timeoutMs: 100 })).rejects.toThrow("timed out");
	let current = true; f.downloads.source.mockImplementation(async () => { current = false; return new Uint8Array([0, 0]); });
	await expect(stageSourceInstallation(io, f.capture, f.downloads, { check: () => { if (!current) throw new Error("Changed source context"); } })).rejects.toThrow("Changed source context");
	expect(f.downloads.attachment).not.toHaveBeenCalled();
});

test("source download bounds are enforced before interpreting or saving the update", async () => {
	const f = await fixture(), write = jest.spyOn(io, "writeBinary");
	f.downloads.source.mockResolvedValue(new Uint8Array(16 * 1024 * 1024 + 1));
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("size limit");
	expect(write.mock.calls.every(([name]) => name.endsWith("/inventory.yjs"))).toBe(true);
});

test("incomplete source dependencies remain incomplete staging, not an empty native file", async () => {
	const f = await fixture(), doc = new Y.Doc(); doc.getText("contents").insert(0, "Before"); const vector = Y.encodeStateVector(doc);
	doc.getText("contents").insert(6, " later"); f.downloads.source.mockResolvedValue(Y.encodeStateAsUpdate(doc, vector)); doc.destroy();
	await expect(stageSourceInstallation(io, f.capture, f.downloads)).rejects.toThrow("incomplete changes");
	expect(f.downloads.attachment).not.toHaveBeenCalled();
});
