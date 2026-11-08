import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { prepareRecoveryBackup, type RecoveryIO } from "../../src/ManagedRecoveryBackup";
import { verifyRecoveryArchive, recoveryCompletionText, type RecoveryArchiveReference, type RecoveryArchiveFile } from "../../src/ManagedRecoveryArchive";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../../src/conflictCopyPath";

let root: string;
let io: RecoveryIO;
const journals: SourceSelectionJournal[] = [];
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-archive-verification-"));
	io = {
		mkdir: async p => { await fs.mkdir(path.join(root, p), { recursive: true }); },
		write: (p, text) => fs.writeFile(path.join(root, p), text),
		writeBinary: (p, bytes) => fs.writeFile(path.join(root, p), new Uint8Array(bytes)),
		readBinary: async p => new Uint8Array(await fs.readFile(path.join(root, p))).buffer,
		stat: async p => { const stat = await fs.stat(path.join(root, p)); return { type: stat.isFile() ? "file" : "folder", size: stat.size }; },
	};
});
afterEach(async () => { for (const journal of journals.splice(0)) journal.close(); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function archive() {
	return prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("native") }],
		documents: [{ id: "note", update: new Uint8Array([0, 0]), text: "history", unsaved: "live", persistedUnsaved: "saved" }], index: new Uint8Array([0, 0]) }), { review: "retained" });
}
async function replaceManifest(reference: RecoveryArchiveReference, change: (manifest: { format: string; version: number; files: RecoveryArchiveFile[] }) => unknown) {
	const value = JSON.parse(await fs.readFile(path.join(root, reference.path, "manifest.json"), "utf8"));
	const text = JSON.stringify(change(value)); await io.write(`${reference.path}/manifest.json`, text);
	const next = { path: reference.path, manifestSha256: hash(text) };
	await io.write(`${reference.path}/BACKUP-COMPLETE.txt`, recoveryCompletionText(next.manifestSha256)); return next;
}

test("a reopened durable preparation verifies every archived version without the capture closure", async () => {
	const backup = await archive();
	const scope = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())) };
	let journal = await SourceSelectionJournal.open(scope); journals.push(journal);
	let state = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId: crypto.randomUUID(), restoreGeneration: crypto.randomUUID() });
	state = await journal.apply({ type: "prepare", expectedRevision: state.revision, operationId: crypto.randomUUID(), reviewId: state.pending!.reviewId,
		preparation: { archive: backup.reference, plan: { id: crypto.randomUUID(), sha256: "a".repeat(64) } } });
	journal.close(); journal = await SourceSelectionJournal.open(scope); journals.push(journal);
	const reopened = await journal.read();
	const read = jest.spyOn(io, "readBinary"), result = await verifyRecoveryArchive(io, reopened.pending!.preparation!.archive);
	expect(result.fileCount).toBe(7); expect(result.totalBytes).toBeGreaterThan(0);
	expect(read.mock.calls.map(([name]) => name)).toContain(`${backup.path}/documents/note.stored-unsaved.txt`);
	expect(await journal.read()).toEqual(reopened);
	await expect(journal.assertActive(reopened.revision, reopened.active)).rejects.toThrow("awaiting recovery");
});

test.each(["files/Team/Note.md", "documents/note.yjs", "documents/note.txt", "documents/note.unsaved.txt", "documents/note.stored-unsaved.txt", "inventory.yjs", "recovery.json"])("changed archived %s is rejected", async name => {
	const backup = await archive(); const bytes = new Uint8Array(await io.readBinary(`${backup.path}/${name}`)); bytes[0] ^= 1;
	await io.writeBinary(`${backup.path}/${name}`, bytes.buffer);
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow(`verification failed: ${name}`);
});

test("replacing both manifest and completion cannot override the separately retained digest", async () => {
	const backup = await archive();
	await replaceManifest(backup.reference, manifest => ({ ...manifest, files: manifest.files.filter(file => file.path !== "documents/note.unsaved.txt") }));
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow("saved reference");
});

test.each(["missing", "changed", "folder"])("a %s completion marker never means complete", async state => {
	const backup = await archive(), name = `${backup.path}/BACKUP-COMPLETE.txt`;
	if (state === "changed") { const bytes = new Uint8Array(await io.readBinary(name)); bytes[0] ^= 1; await io.writeBinary(name, bytes.buffer); }
	else { await fs.unlink(path.join(root, name)); if (state === "folder") await io.mkdir(name); }
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow();
});

test.each(["../outside", "/absolute", "Other/archive", `${RECOVERY_FOLDER}/../escape`, `${RECOVERY_FOLDER}/a\\escape`, `${RECOVERY_FOLDER}/a:stream`])("unsafe archive reference %s is refused before I/O", async archivePath => {
	const stat = jest.spyOn(io, "stat"), read = jest.spyOn(io, "readBinary");
	await expect(verifyRecoveryArchive(io, { path: archivePath, manifestSha256: "a".repeat(64) })).rejects.toThrow();
	expect(stat).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
});

test.each([
	["future version", (m: any) => ({ ...m, version: 2 })],
	["unknown field", (m: any) => ({ ...m, extra: true })],
	["missing inventory", (m: any) => ({ ...m, files: m.files.filter((f: RecoveryArchiveFile) => f.path !== "inventory.yjs") })],
	["duplicate path", (m: any) => ({ ...m, files: [...m.files, m.files[0]] })],
	["case collision", (m: any) => ({ ...m, files: [...m.files, { ...m.files[0], path: "files/team/note.md" }] })],
	["directory collision", (m: any) => ({ ...m, files: [...m.files, { ...m.files[0], path: "files/Team" }] })],
	["traversal", (m: any) => ({ ...m, files: [...m.files, { ...m.files[0], path: "files/../../outside" }] })],
	["unknown artifact", (m: any) => ({ ...m, files: [...m.files, { ...m.files[0], path: "execute.sh" }] })],
	["negative size", (m: any) => ({ ...m, files: [{ ...m.files[0], bytes: -1 }, ...m.files.slice(1)] })],
	["fractional size", (m: any) => ({ ...m, files: [{ ...m.files[0], bytes: 1.5 }, ...m.files.slice(1)] })],
	["bad hash", (m: any) => ({ ...m, files: [{ ...m.files[0], sha256: "invalid" }, ...m.files.slice(1)] })],
])("a manifest with %s is refused even with its correct digest", async (_label, change) => {
	const backup = await archive(), reference = await replaceManifest(backup.reference, change);
	const read = jest.spyOn(io, "readBinary");
	await expect(verifyRecoveryArchive(io, reference)).rejects.toThrow();
	expect(read.mock.calls).toEqual([[`${backup.path}/manifest.json`]]);
});

test.each([{ maxFileBytes: 1 }, { maxTotalBytes: 1 }, { maxFiles: 2 }, { maxManifestBytes: 1 }])("configured resource limits refuse before artifact reads: %o", async options => {
	const backup = await archive(), read = jest.spyOn(io, "readBinary");
	await expect(verifyRecoveryArchive(io, backup.reference, options)).rejects.toThrow();
	expect(read.mock.calls.every(([name]) => name.endsWith("/manifest.json"))).toBe(true);
});

test("stat rejects an oversized artifact before reading it", async () => {
	const backup = await archive(), stat = io.stat, read = jest.spyOn(io, "readBinary");
	io.stat = p => p.endsWith("/inventory.yjs") ? Promise.resolve({ type: "file", size: 999999999 }) : stat(p);
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow("inventory.yjs");
	expect(read.mock.calls.map(([name]) => name)).not.toContain(`${backup.path}/inventory.yjs`);
});

test("a file growing after stat is rejected", async () => {
	const backup = await archive(), read = io.readBinary;
	io.readBinary = p => p.endsWith("/inventory.yjs") ? Promise.resolve(new Uint8Array([0, 0, 0]).buffer) : read(p);
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow("inventory.yjs");
});

test.each(["stat", "readBinary"] as const)("a stalled %s times out without continuing or writing", async operation => {
	const backup = await archive(), write = jest.spyOn(io, "write"), read = jest.spyOn(io, "readBinary");
	io[operation] = () => new Promise<never>(() => {});
	await expect(verifyRecoveryArchive(io, backup.reference, { timeoutMs: 5 })).rejects.toThrow("timed out");
	expect(write).not.toHaveBeenCalled(); if (operation === "stat") expect(read).not.toHaveBeenCalled();
});

test("cancellation interrupts a stalled read and late completion cannot resume it", async () => {
	const backup = await archive(), abort = new AbortController(), original = io.readBinary;
	let finish!: (bytes: ArrayBuffer) => void;
	const started = new Promise<void>(resolve => { io.readBinary = () => { resolve(); return new Promise<ArrayBuffer>(done => { finish = done; }); }; });
	const stat = jest.spyOn(io, "stat"), pending = verifyRecoveryArchive(io, backup.reference, { signal: abort.signal });
	await started; abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	finish(await original(`${backup.path}/manifest.json`)); await new Promise(resolve => setTimeout(resolve, 0));
	expect(stat).toHaveBeenCalledTimes(1);
});

test("a changed caller context stops verification after the pending read", async () => {
	const backup = await archive(), read = io.readBinary; let current = true;
	io.readBinary = async p => { const result = await read(p); current = false; return result; };
	await expect(verifyRecoveryArchive(io, backup.reference, { check: () => { if (!current) throw new Error("changed scope"); } })).rejects.toThrow("changed scope");
});

test("manifest replacement during artifact reading is detected by the closing check", async () => {
	const backup = await archive(), read = io.readBinary;
	io.readBinary = async p => { const bytes = await read(p); if (p.endsWith("/recovery.json")) await io.write(`${backup.path}/manifest.json`, "{}"); return bytes; };
	await expect(verifyRecoveryArchive(io, backup.reference)).rejects.toThrow("manifest.json");
});

test("returned summaries do not expose a mutable trusted artifact list", async () => {
	const backup = await archive(), result = await verifyRecoveryArchive(io, backup.reference);
	expect(Object.isFrozen(result.reference)).toBe(true); expect(result).not.toHaveProperty("files");
	await io.write(`${backup.path}/unlisted.txt`, "not part of recovery");
	expect(await verifyRecoveryArchive(io, backup.reference)).toEqual(result);
});

test("buffers returned from another window realm can be verified", async () => {
	const backup = await archive(), read = io.readBinary;
	io.readBinary = p => p.endsWith("/inventory.yjs") ? Promise.resolve(runInNewContext("new Uint8Array([0, 0]).buffer")) : read(p);
	await expect(verifyRecoveryArchive(io, backup.reference)).resolves.toMatchObject({ fileCount: 7 });
});
