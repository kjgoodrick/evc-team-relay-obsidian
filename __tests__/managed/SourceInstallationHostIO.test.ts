import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSourceInstallationHostIO, type SourceInstallationHost } from "../../src/SourceInstallationHostIO";
import { sourceInstallationPath } from "../../src/SourceInstallationPlan";
import { RECOVERY_FOLDER } from "../../src/conflictCopyPath";
import { holdNativeSourceWrites } from "../../src/storage/native-document-writes";

const id = "11111111-1111-4111-8111-111111111111", entryId = "22222222-2222-4222-8222-222222222222";
const root = sourceInstallationPath(id), parent = root.slice(0, root.lastIndexOf("/"));
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
let directory: string, host: SourceInstallationHost;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-installation-host-"));
	host = { nativeWriteOwner: {}, adapter: {
		stat: async name => { try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
		readBinary: async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer,
	}, createDirectoryExclusive: async name => { await fs.mkdir(path.join(directory, name)); },
	createFileExclusive: async (name, value) => { await fs.writeFile(path.join(directory, name), new Uint8Array(value), { flag: "wx" }); } };
});
afterEach(async () => { jest.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

test("creates only a new owned staging root and reads back its fixed artifacts", async () => {
	const io = createSourceInstallationHostIO(host);
	await io.mkdir(parent); await io.createDirectoryExclusive(root); await io.mkdir(root + "/files"); await io.mkdir(root + "/sources");
	await io.write(root + "/plan.json", "plan"); await io.writeBinary(root + "/inventory.yjs", bytes("inventory"));
	await io.writeBinary(root + `/files/${entryId}.bin`, bytes("native")); await io.writeBinary(root + `/sources/${entryId}.yjs`, bytes("source"));
	expect(new TextDecoder().decode(await io.readBinary(root + `/files/${entryId}.bin`))).toBe("native");
	expect(await io.stat(root + "/plan.json")).toMatchObject({ type: "file", size: 4 });
});

test("existing roots and artifact files cannot be overwritten", async () => {
	const io = createSourceInstallationHostIO(host); await io.mkdir(parent); await io.createDirectoryExclusive(root); await io.write(root + "/plan.json", "original");
	await expect(io.createDirectoryExclusive(root)).rejects.toThrow();
	await expect(io.write(root + "/plan.json", "replacement")).rejects.toThrow();
	expect(new TextDecoder().decode(await io.readBinary(root + "/plan.json"))).toBe("original");
});

test("an artifact created concurrently by another writer wins without being replaced", async () => {
	const io = createSourceInstallationHostIO(host); await io.mkdir(parent); await io.createDirectoryExclusive(root);
	const real = host.createFileExclusive.bind(host);
	const racingHost = { ...host, createFileExclusive: async (name: string, value: ArrayBuffer) => {
		await real(name, bytes("concurrent original")); await real(name, value);
	} };
	const other = createSourceInstallationHostIO(racingHost), anotherRoot = sourceInstallationPath(crypto.randomUUID());
	await other.createDirectoryExclusive(anotherRoot);
	await expect(other.write(anotherRoot + "/plan.json", "replacement")).rejects.toThrow();
	expect(new TextDecoder().decode(await other.readBinary(anotherRoot + "/plan.json"))).toBe("concurrent original");
});

test("reopened adapters can verify existing plans but cannot rewrite or claim their directories", async () => {
	const first = createSourceInstallationHostIO(host); await first.mkdir(parent); await first.createDirectoryExclusive(root); await first.write(root + "/plan.json", "saved");
	const reopened = createSourceInstallationHostIO(host);
	expect(new TextDecoder().decode(await reopened.readBinary(root + "/plan.json"))).toBe("saved");
	await expect(reopened.createDirectoryExclusive(root)).rejects.toThrow();
	await expect(reopened.write(root + "/inventory.yjs", "foreign")).rejects.toThrow("does not belong");
});

test.each(["Team/Note.md", "../escape", `${RECOVERY_FOLDER}/../escape`, `${root}/../escape`, `${root}/unexpected.txt`, `${root}/files/not-an-id.bin`])("rejects writes outside fixed owned artifacts: %s", async name => {
	const io = createSourceInstallationHostIO(host); await io.mkdir(parent); await io.createDirectoryExclusive(root);
	await expect(io.write(name, "invalid")).rejects.toThrow();
	expect(await fs.readdir(path.join(directory, root))).toEqual([]);
});

test("native-source holds fence staging writes through the actual host owner", async () => {
	const io = createSourceInstallationHostIO(host); await io.mkdir(parent);
	const hold = holdNativeSourceWrites(host.nativeWriteOwner, root);
	try { await expect(io.createDirectoryExclusive(root)).rejects.toThrow("paused for recovery"); expect(await io.stat(root)).toBeNull(); }
	finally { hold.release(); }
	await io.createDirectoryExclusive(root);
});

test("late directory creation after context invalidation cannot grant staging write authority", async () => {
	let current = true; const original = host.createDirectoryExclusive.bind(host);
	const io = createSourceInstallationHostIO(host, () => { if (!current) throw new Error("review changed"); });
	await io.mkdir(parent);
	// Construct an operation with a context change during the exclusive native call.
	const changedHost = { ...host, createDirectoryExclusive: async (name: string) => { await original(name); current = false; } };
	const changed = createSourceInstallationHostIO(changedHost, () => { if (!current) throw new Error("review changed"); });
	await expect(changed.createDirectoryExclusive(root)).rejects.toThrow("review changed");
	expect((await fs.stat(path.join(directory, root))).isDirectory()).toBe(true);
	await expect(changed.write(root + "/plan.json", "late")).rejects.toThrow("review changed");
	expect(await fs.readdir(path.join(directory, root))).toEqual([]);
});

test("copies bytes before the asynchronous native write begins", async () => {
	const io = createSourceInstallationHostIO(host); await io.mkdir(parent); await io.createDirectoryExclusive(root);
	const value = bytes("original"), pending = io.writeBinary(root + "/inventory.yjs", value); new Uint8Array(value).fill(0); await pending;
	expect(new TextDecoder().decode(await io.readBinary(root + "/inventory.yjs"))).toBe("original");
});
