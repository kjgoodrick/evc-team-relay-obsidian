import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import * as Y from "yjs";
import { ItemKind } from "../../src/ItemKinds";
import { prepareRecoveryBackup, type RecoveryIO } from "../../src/ManagedRecoveryBackup";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../../src/conflictCopyPath";
import { buildInstallationInventory } from "../../src/SourceInstallationContent";
import { encodeSourceInstallationPlan, parseSourceInstallationPlan, sourceInstallationArtifacts, sourceInstallationPath,
	verifySourceInstallationPlan, type SourceInstallationPlan, type InstallationArtifact } from "../../src/SourceInstallationPlan";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const digest = (value: ArrayBuffer) => createHash("sha256").update(new Uint8Array(value)).digest("hex");
const descriptor = (value: ArrayBuffer): InstallationArtifact => ({ bytes: value.byteLength, sha256: digest(value) });
let root: string, io: RecoveryIO;
const journals: SourceSelectionJournal[] = [];
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-source-installation-"));
	io = {
		mkdir: async name => { await fs.mkdir(path.join(root, name), { recursive: true }); },
		write: (name, text) => fs.writeFile(path.join(root, name), text),
		writeBinary: (name, bytes) => fs.writeFile(path.join(root, name), new Uint8Array(bytes)),
		readBinary: async name => new Uint8Array(await fs.readFile(path.join(root, name))).buffer,
		stat: async name => { try { const stat = await fs.stat(path.join(root, name)); return { type: stat.isFile() ? "file" : "folder", size: stat.size }; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } },
	};
});
afterEach(async () => { journals.splice(0).forEach(journal => journal.close()); jest.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
	await io.mkdir("Team"); await io.write("Team/Note.md", "Original native text");
	const backup = await prepareRecoveryBackup(io, async () => ({ files: [{ path: "Team/Note.md", bytes: encode("Original native text") }],
		documents: [], index: new Uint8Array([0, 0]) }), { review: id(2) });
	let inventory = new Uint8Array([0, 0]).buffer;
	const file = encode("Restored text"), document = new Y.Doc(); document.getText("contents").insert(0, "Restored text");
	const source = new Uint8Array(Y.encodeStateAsUpdate(document)).buffer; document.destroy();
	const plan: SourceInstallationPlan = { format: "team-relay-source-installation", version: 1, id: id(1), reviewId: id(2),
		source: { hostAppId: crypto.randomUUID(), serverId: "test", controlPlaneUrl: "https://fixture.test",
			s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", id(3))), restoreGeneration: id(4) },
		archive: backup.reference, originalRoot: "Team", destinationRoot: "Restored Team", mode: "new-folder", inventory: descriptor(inventory),
		entries: [{ path: "Notes", record: { id: id(5), version: 0, type: ItemKind.Folder } },
			{ path: "Notes/Note.md", record: { id: id(6), version: 0, type: ItemKind.Document }, file: descriptor(file), source: descriptor(source) },
			{ path: "Picture.png", record: { id: id(7), version: 0, type: ItemKind.Image, hash: digest(file), synctime: 1, mimetype: "image/png" }, file: descriptor(file) }],
	};
	inventory = new Uint8Array(buildInstallationInventory(plan, {
		records: Object.fromEntries(plan.entries.map(entry => [entry.path, entry.record])),
		permissions: Object.fromEntries(plan.entries.map(entry => [entry.path, "read" as const])), activity: {}, owner: false,
		restore_guard: true, restore_generation: plan.source.restoreGeneration,
	})).buffer; plan.inventory = descriptor(inventory);
	const encoded = await encodeSourceInstallationPlan(plan), directory = sourceInstallationPath(plan.id);
	await io.mkdir(`${directory}/files`); await io.mkdir(`${directory}/sources`);
	await io.writeBinary(`${directory}/plan.json`, encoded.bytes);
	await io.writeBinary(`${directory}/inventory.yjs`, inventory);
	await io.writeBinary(`${directory}/files/${id(6)}.bin`, file); await io.writeBinary(`${directory}/sources/${id(6)}.yjs`, source);
	await io.writeBinary(`${directory}/files/${id(7)}.bin`, file);
	const expected = { source: plan.source, reviewId: plan.reviewId, archive: backup.reference };
	return { plan, directory, encoded, expected, backup };
}

test("a reopened journal binds the plan, source generation, review and archive without activating it", async () => {
	const f = await fixture();
	let journal = await SourceSelectionJournal.open(f.plan.source); journals.push(journal);
	let state = await journal.apply({ type: "begin", expectedRevision: null, operationId: id(10), reviewId: f.plan.reviewId, restoreGeneration: id(4) });
	state = await journal.apply({ type: "prepare", expectedRevision: state.revision, operationId: id(11), reviewId: f.plan.reviewId,
		preparation: { archive: f.backup.reference, plan: f.encoded.reference } });
	journal.close(); journal = await SourceSelectionJournal.open(f.plan.source); journals.push(journal);
	const reopened = await journal.read(), write = jest.spyOn(io, "writeBinary");
	const verified = await verifySourceInstallationPlan(io, reopened.pending!.preparation!.plan, f.expected);
	expect(verified.plan).toEqual(f.plan); expect(verified.artifactCount).toBe(4);
	expect(await journal.read()).toEqual(state); expect(write).not.toHaveBeenCalled();
	expect(await io.stat("Restored Team")).toBeNull();
	expect(new TextDecoder().decode(await io.readBinary("Team/Note.md"))).toBe("Original native text");
});

test.each([
	["unknown field", (p: any) => { p.extra = true; }],
	["future version", (p: any) => { p.version = 2; }],
	["replacement mode", (p: any) => { p.mode = "replace-folder"; }],
	["missing generation", (p: any) => { delete p.source.restoreGeneration; }],
	["credential URL", (p: any) => { p.source.controlPlaneUrl = "https://secret@fixture.test"; }],
	["noncanonical URL", (p: any) => { p.source.controlPlaneUrl += "/"; }],
	["same root", (p: any) => { p.destinationRoot = "TEAM"; }],
	["nested root", (p: any) => { p.destinationRoot = "Team/Restored"; }],
	["ancestor root", (p: any) => { p.originalRoot = "Restored Team/Old"; }],
	["recovery target", (p: any) => { p.destinationRoot = RECOVERY_FOLDER + "/Restored"; }],
	["nested recovery target", (p: any) => { p.destinationRoot = "Restored/" + RECOVERY_FOLDER; }],
	["hidden destination", (p: any) => { p.destinationRoot = ".obsidian/restored"; }],
	["traversal", (p: any) => { p.entries[1].path = "Notes/../Note.md"; }],
	["device name", (p: any) => { p.entries[1].path = "Notes/CON.txt"; }],
	["stream path", (p: any) => { p.entries[1].path = "Notes/a:stream"; }],
	["trailing space", (p: any) => { p.entries[1].path = "Notes/Note.md "; }],
	["Unicode alias", (p: any) => { p.entries[1].path = "Notes/e\u0301.md"; }],
	["duplicate identity", (p: any) => { p.entries[1].record.id = p.entries[0].record.id; }],
	["uppercase identity", (p: any) => { p.entries[1].record.id = "00000000-0000-4000-8000-00000000ABCD"; }],
	["oversized path component", (p: any) => { p.entries[1].path = "Notes/" + "é".repeat(128); }],
	["duplicate path", (p: any) => { p.entries[2].path = p.entries[1].path; }],
	["case alias", (p: any) => { p.entries[2].path = "notes/note.md"; }],
	["parent case alias", (p: any) => { p.entries[2].path = "notes/Other.png"; }],
	["file parent", (p: any) => { p.entries[1].path = "Picture.png/Note.md"; }],
	["missing history", (p: any) => { delete p.entries[1].source; }],
	["folder bytes", (p: any) => { p.entries[0].file = p.entries[1].file; }],
	["wrong attachment hash", (p: any) => { p.entries[2].record.hash = "a".repeat(64); }],
	["oversized source", (p: any) => { p.entries[1].source.bytes = 16 * 1024 * 1024 + 1; }],
	["oversized native file", (p: any) => { p.entries[1].file.bytes = 256 * 1024 * 1024 + 1; }],
	["negative bytes", (p: any) => { p.inventory.bytes = -1; }],
	["too many entries", (p: any) => { p.entries = Array(10001).fill(p.entries[0]); }],
])("invalid %s is refused before the plan is encoded", async (_label, change) => {
	const { plan } = await fixture(); change(plan);
	expect(() => parseSourceInstallationPlan(plan)).toThrow(); await expect(encodeSourceInstallationPlan(plan)).rejects.toThrow();
});

test.each(["plan.json", "inventory.yjs", `files/${id(6)}.bin`, `sources/${id(6)}.yjs`, `files/${id(7)}.bin`])("corrupted artifact %s prevents restart verification", async name => {
	const f = await fixture(), target = `${f.directory}/${name}`, bytes = new Uint8Array(await io.readBinary(target)); bytes[0] ^= 1;
	await io.writeBinary(target, bytes.buffer);
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow();
});

test.each(["source", "review", "archive", "id"])("a changed %s association cannot verify", async kind => {
	const f = await fixture();
	if (kind === "source") f.expected.source = { ...f.expected.source, restoreGeneration: id(99) };
	if (kind === "review") f.expected.reviewId = id(99);
	if (kind === "archive") f.expected.archive = { ...f.expected.archive, manifestSha256: "a".repeat(64) };
	if (kind === "id") f.encoded.reference = { ...f.encoded.reference, id: id(99) };
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow();
});

test("a damaged original-work archive prevents verification even with intact installation artifacts", async () => {
	const f = await fixture(); await io.write(`${f.backup.path}/files/Team/Note.md`, "Changed original");
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow("Recovery file verification failed");
});

test.each(["missing", "directory"])("a %s artifact is not a usable installation input", async kind => {
	const f = await fixture(), name = `${f.directory}/inventory.yjs`;
	await fs.unlink(path.join(root, name)); if (kind === "directory") await io.mkdir(name);
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow("inventory.yjs");
});

test("aggregate staged bytes are bounded before any artifact reads", async () => {
	const f = await fixture(), original = f.plan.entries[2];
	f.plan.entries = Array.from({ length: 257 }, (_, n) => ({ ...original, path: `${n}.png`,
		record: { ...original.record, id: id(1000 + n) }, file: { ...original.file!, bytes: 256 * 1024 * 1024 } }));
	expect(() => parseSourceInstallationPlan(f.plan)).toThrow();
});

test("valid hashes cannot hide disagreement between editing history and the native text", async () => {
	const f = await fixture(), doc = new Y.Doc(); doc.getText("contents").insert(0, "Different history");
	const source = new Uint8Array(Y.encodeStateAsUpdate(doc)).buffer; doc.destroy();
	f.plan.entries[1].source = descriptor(source); await io.writeBinary(`${f.directory}/sources/${id(6)}.yjs`, source);
	const encoded = await encodeSourceInstallationPlan(f.plan); await io.writeBinary(`${f.directory}/plan.json`, encoded.bytes);
	await expect(verifySourceInstallationPlan(io, encoded.reference, f.expected)).rejects.toThrow("disagrees with its native file");
});

test("valid hashes cannot carry an old pending inventory conflict into a selected source", async () => {
	const f = await fixture(), doc = new Y.Doc(); Y.applyUpdate(doc, new Uint8Array(await io.readBinary(`${f.directory}/inventory.yjs`)));
	doc.getMap("managed_conflicts_v1").set("old", { retained: true });
	const inventory = new Uint8Array(Y.encodeStateAsUpdate(doc)).buffer; doc.destroy();
	f.plan.inventory = descriptor(inventory); await io.writeBinary(`${f.directory}/inventory.yjs`, inventory);
	const encoded = await encodeSourceInstallationPlan(f.plan); await io.writeBinary(`${f.directory}/plan.json`, encoded.bytes);
	await expect(verifySourceInstallationPlan(io, encoded.reference, f.expected)).rejects.toThrow("retained or unsupported state");
});

test("oversized or growing staged files fail before hashing or continuing", async () => {
	const f = await fixture(), stat = io.stat, read = jest.spyOn(io, "readBinary");
	io.stat = name => name === `${f.directory}/inventory.yjs` ? Promise.resolve({ type: "file", size: 999999999 }) : stat(name);
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow("inventory.yjs");
	expect(read.mock.calls.map(([name]) => name)).not.toContain(`${f.directory}/inventory.yjs`);
	io.stat = stat;
	read.mockImplementation(async name => name === `${f.directory}/inventory.yjs` ? new Uint8Array([0, 0, 0]).buffer : new Uint8Array(await fs.readFile(path.join(root, name))).buffer);
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow("changed during reading");
});

test("cancellation interrupts a pending read and late completion cannot resume verification", async () => {
	const f = await fixture(), abort = new AbortController(); let finish!: (value: ArrayBuffer) => void;
	const started = new Promise<void>(resolve => { io.readBinary = () => { resolve(); return new Promise(done => { finish = done; }); }; });
	const stat = jest.spyOn(io, "stat"), pending = verifySourceInstallationPlan(io, f.encoded.reference, f.expected, { signal: abort.signal });
	await started; abort.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	finish(f.encoded.bytes); await new Promise(resolve => setTimeout(resolve, 0)); expect(stat).toHaveBeenCalledTimes(1);
});

test("a stalled read times out and a changed caller stops subsequent work", async () => {
	const f = await fixture(), read = io.readBinary; io.readBinary = () => new Promise(() => {});
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected, { timeoutMs: 5 })).rejects.toThrow("timed out");
	let current = true; io.readBinary = async name => { const bytes = await read(name); current = false; return bytes; };
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected, { check: () => { if (!current) throw new Error("changed caller"); } })).rejects.toThrow("changed caller");
});

test("replaced plan metadata is detected after the sequential artifact reads", async () => {
	const f = await fixture(), read = io.readBinary;
	io.readBinary = async name => { const bytes = await read(name); if (name === `${f.directory}/inventory.yjs`) await io.write(`${f.directory}/plan.json`, "{}"); return bytes; };
	await expect(verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).rejects.toThrow("plan.json");
});

test("a popout's buffers and empty visible inventory remain verifiable without trusting unlisted files", async () => {
	const f = await fixture(), read = io.readBinary;
	io.readBinary = async name => { const bytes = await read(name); return runInNewContext("Uint8Array.from(data).buffer", { data: [...new Uint8Array(bytes)] }); };
	await io.write(`${f.directory}/extra.txt`, "Never consumed");
	expect((await verifySourceInstallationPlan(io, f.encoded.reference, f.expected)).artifactCount).toBe(4);
	f.plan.entries = [];
	const inventory = new Uint8Array(buildInstallationInventory(f.plan, { records: {}, permissions: {}, activity: {}, owner: false, restore_guard: true, restore_generation: f.plan.source.restoreGeneration })).buffer;
	f.plan.inventory = descriptor(inventory); await io.writeBinary(`${f.directory}/inventory.yjs`, inventory);
	const empty = await encodeSourceInstallationPlan(f.plan); await io.writeBinary(`${f.directory}/plan.json`, empty.bytes);
	expect((await verifySourceInstallationPlan(io, empty.reference, f.expected)).artifactCount).toBe(1);
});

test("encoding snapshots mutable input and generated artifact locations never use native paths", async () => {
	const f = await fixture(), pending = encodeSourceInstallationPlan(f.plan); f.plan.destinationRoot = "Changed";
	const encoded = await pending;
	expect(JSON.parse(new TextDecoder().decode(encoded.bytes)).destinationRoot).toBe("Restored Team");
	expect(Object.isFrozen(encoded.reference)).toBe(true);
	expect(sourceInstallationArtifacts(f.plan).map(row => row.path)).toEqual(["inventory.yjs", `files/${id(6)}.bin`, `sources/${id(6)}.yjs`, `files/${id(7)}.bin`]);
});
