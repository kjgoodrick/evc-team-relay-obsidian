import "fake-indexeddb/auto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Y from "yjs";
import { FileSystemAdapter, type Vault } from "obsidian";
import { ItemKind } from "../../src/ItemKinds";
import { RemoteFolderAddress, ResourceAddress } from "../../src/ResourceAddress";
import { prepareRecoveryBackup } from "../../src/ManagedRecoveryBackup";
import { createDesktopSourceInstallationIO } from "../../src/DesktopSourceInstallationIO";
import { createDesktopSameFolderInspectionIO } from "../../src/DesktopSameFolderInspectionIO";
import { prepareSourceInstallation } from "../../src/SourceInstallationPreparation";
import { inspectSameFolderSource } from "../../src/SameFolderSourceInspection";
import { parseSameFolderReview, sameFolderComparisonDigest, type NativeReviewChoice } from "../../src/SameFolderReview";
import { prepareSameFolderReview, verifySameFolderReview } from "../../src/SameFolderReviewPreparation";
import { SourceSelectionJournal } from "../../src/storage/source-selection-journal";

jest.mock("obsidian", () => ({ Platform: { isMobile: false }, FileSystemAdapter: class {} }));
const encode = (value: string) => new TextEncoder().encode(value).buffer;
let directory: string, vault: Vault;
const journals: SourceSelectionJournal[] = [];
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-native-review-"));
	const adapter = new FileSystemAdapter(); adapter.getBasePath = () => directory;
	adapter.stat = async name => {
		try { const value = await fs.stat(path.join(directory, name)); return { type: value.isDirectory() ? "folder" : "file", size: value.size, ctime: value.ctimeMs, mtime: value.mtimeMs }; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
	};
	adapter.readBinary = async name => new Uint8Array(await fs.readFile(path.join(directory, name))).buffer;
	vault = { adapter } as unknown as Vault;
});
afterEach(async () => { jest.restoreAllMocks(); journals.splice(0).forEach(journal => journal.close()); await fs.rm(directory, { recursive: true, force: true }); });
async function fixture(options: { local?: Record<string, string>; server?: Record<string, string> } = {}) {
	const local = options.local ?? { "Same.md": "same", "Changed.md": "local", "Retired.md": "retained" };
	const server = options.server ?? { "Same.md": "same", "Changed.md": "server", "New.md": "new" };
	await fs.mkdir(path.join(directory, "Team"));
	for (const [name, value] of Object.entries(local)) { await fs.mkdir(path.dirname(path.join(directory, "Team", name)), { recursive: true }); await fs.writeFile(path.join(directory, "Team", name), value); }
	const backup = await prepareRecoveryBackup({ stat: vault.adapter.stat.bind(vault.adapter), readBinary: vault.adapter.readBinary.bind(vault.adapter),
		mkdir: async name => { await fs.mkdir(path.join(directory, name), { recursive: true }); },
		write: (name, text) => fs.writeFile(path.join(directory, name), text), writeBinary: (name, value) => fs.writeFile(path.join(directory, name), new Uint8Array(value)),
	}, async () => ({ files: Object.entries(local).map(([name, value]) => ({ path: `Team/${name}`, bytes: encode(value) })), documents: [], index: new Uint8Array([0, 0]) }), {});
	const source = { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())), restoreGeneration: crypto.randomUUID() };
	const snapshot = { records: Object.fromEntries(Object.keys(server).map(name => [name, { id: crypto.randomUUID(), version: 0 as const, type: ItemKind.Document as const }])),
		permissions: Object.fromEntries(Object.keys(server).map(name => [name, "read" as const])), activity: {}, owner: false, restore_guard: true, restore_generation: source.restoreGeneration };
	const reviewId = crypto.randomUUID(), journal = await SourceSelectionJournal.open(source); journals.push(journal);
	const initial = await journal.apply({ type: "begin", expectedRevision: null, operationId: crypto.randomUUID(), reviewId, restoreGeneration: source.restoreGeneration });
	const staging = createDesktopSourceInstallationIO(vault), native = createDesktopSameFolderInspectionIO(vault, "Team");
	const prepared = await prepareSourceInstallation(journal, staging, { source, reviewId, archive: backup.reference, originalRoot: "Team", destinationRoot: "Team",
		mode: "existing-folder", snapshot, reviewRevision: initial.revision!, operationId: crypto.randomUUID() }, {
		source: async entry => { const doc = new Y.Doc(); doc.getText("contents").insert(0, server[entry.path]); const update = Y.encodeStateAsUpdate(doc); doc.destroy(); return update; },
		attachment: async () => { throw new Error("Unexpected attachment"); }, revalidate: async () => structuredClone(snapshot),
	});
	const expected = { source, reviewId, archive: backup.reference }, inspection = await inspectSameFolderSource(staging, native, prepared.staged.reference, expected);
	const choices: NativeReviewChoice[] = inspection.rows.filter(row => row.change !== "unchanged" && row.change !== "absent")
		.map(row => ({ path: row.path, choice: row.selected ? "use-selected" : "archive-local" }));
	const request = { source, reviewId, revision: prepared.selection.revision!, operationId: crypto.randomUUID(), comparisonDigest: await sameFolderComparisonDigest(inspection), choices };
	const run = () => prepareSameFolderReview(journal, staging, native, request);
	return { source, local, journal, staging, native, expected, prepared, inspection, request, run, backup };
}

test("an explicit whole-folder review is immutable, survives journal/adapter reopen and leaves working files unchanged", async () => {
	const f = await fixture(), result = await f.run();
	expect(result.review.operations.map(row => [row.kind, row.path])).toEqual([["file", "Retired.md"], ["file", "Changed.md"], ["file", "New.md"]]);
	expect(result.selection).toMatchObject({ active: { kind: "legacy" }, pending: { phase: "prepared", preparation: { nativeReview: result.reference } } });
	for (const [name, value] of Object.entries(f.local)) expect(await fs.readFile(path.join(directory, "Team", name), "utf8")).toBe(value);
	f.journal.close(); const journal = await SourceSelectionJournal.open(f.source); journals.push(journal);
	const reopened = createDesktopSourceInstallationIO(vault), saved = (await journal.read()).pending!.preparation!.nativeReview!;
	expect((await verifySameFolderReview(reopened, saved, { ...f.expected, plan: f.prepared.staged.reference })).review).toEqual(result.review);
	await expect(reopened.write(`${result.path}/review.json`, "overwrite")).rejects.toThrow("does not belong");
	expect(await fs.readFile(path.join(directory, result.path, "review.json"), "utf8")).toBe(JSON.stringify(result.review));
});

test("type transitions and case-only parent changes produce a complete ordered recipe", async () => {
	const f = await fixture({ local: { Collision: "old file", "Retired/Deep/Old.md": "old nested", "Case/Old.md": "old case" },
		server: { "Collision/New.md": "new nested", Retired: "now a file", "case/New.md": "new case" } });
	const result = await f.run();
	expect(result.review.operations.map(row => row.kind === "file" ? `${row.after ? "write" : "archive"}:${row.path}` : `${row.action}:${row.path}`)).toEqual([
		"archive:Case/Old.md", "archive:Collision", "archive:Retired/Deep/Old.md", "remove:Retired/Deep", "remove:Case", "remove:Retired",
		"create:Collision", "create:case", "write:Collision/New.md", "write:Retired", "write:case/New.md",
	]);
	expect(await fs.readFile(path.join(directory, "Team", "Collision"), "utf8")).toBe("old file");
});

test("a file edit since the shown comparison requires a fresh review before creating an artifact", async () => {
	const f = await fixture(), create = jest.spyOn(f.staging, "createDirectoryExclusive");
	await fs.writeFile(path.join(directory, "Team", "Changed.md"), "new local work");
	await expect(f.run()).rejects.toThrow("shown comparison"); expect(create).not.toHaveBeenCalled();
	expect(await f.journal.read()).toEqual(f.prepared.selection);
});

test("a fresh comparison cannot approve unbacked-up work, even when it matches the selected source", async () => {
	const f = await fixture(), create = jest.spyOn(f.staging, "createDirectoryExclusive");
	await fs.writeFile(path.join(directory, "Team", "Changed.md"), "server");
	const updated = await inspectSameFolderSource(f.staging, f.native, f.prepared.staged.reference, f.expected);
	f.request.comparisonDigest = await sameFolderComparisonDigest(updated); f.request.choices = f.request.choices.filter(row => row.path !== "Changed.md");
	await expect(f.run()).rejects.toThrow("fresh recovery copy"); expect(create).not.toHaveBeenCalled();
	expect(await fs.readFile(path.join(directory, "Team", "Changed.md"), "utf8")).toBe("server");
});

test.each(["missing choice", "wrong choice", "extra unchanged choice"])("%s cannot turn an observation into a reviewed mutation", async kind => {
	const f = await fixture();
	if (kind === "missing choice") f.request.choices.pop();
	if (kind === "wrong choice") f.request.choices[0].choice = "archive-local";
	if (kind === "extra unchanged choice") f.request.choices.push({ path: "Same.md", choice: "use-selected" });
	await expect(f.run()).rejects.toThrow(); expect(await f.journal.read()).toEqual(f.prepared.selection);
});

test.each(["missing operation", "changed bytes", "wrong entry", "reordered", "duplicate id", "extra field"])("a serialized review with %s cannot verify", async kind => {
	const f = await fixture(), result = await f.run(), review = structuredClone(result.review);
	if (kind === "missing operation") review.operations.pop();
	if (kind === "changed bytes") { const op = review.operations.find(row => row.kind === "file" && row.after)!; if (op.kind === "file") op.after!.sha256 = "f".repeat(64); }
	if (kind === "wrong entry") { const op = review.operations.find(row => row.kind === "file" && row.after)!; if (op.kind === "file") op.entryId = crypto.randomUUID(); }
	if (kind === "reordered") review.operations.reverse();
	if (kind === "duplicate id") review.operations[1].id = review.operations[0].id;
	if (kind === "extra field") Object.assign(review.operations[0], { unknown: true });
	expect(() => parseSameFolderReview(review, result.source.plan, result.source.reference)).toThrow();
});

test("competing reviewers cannot both save choices against the same source revision", async () => {
	const f = await fixture();
	const results = await Promise.allSettled([f.run(), prepareSameFolderReview(f.journal, f.staging, f.native, { ...f.request, operationId: crypto.randomUUID() })]);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect((await f.journal.read()).pending?.phase).toBe("prepared");
});

test("a lost journal-save response is reconciled by reopening instead of creating a new review", async () => {
	const f = await fixture(), apply = f.journal.apply.bind(f.journal);
	jest.spyOn(f.journal, "apply").mockImplementationOnce(async (...args) => { await apply(...args); throw new Error("lost response"); });
	await expect(f.run()).rejects.toThrow("lost response");
	const state = await f.journal.read(); expect(state.pending?.preparation?.nativeReview).toBeDefined();
	await expect(f.run()).rejects.toThrow("source review changed");
	expect((await verifySameFolderReview(f.staging, state.pending!.preparation!.nativeReview!, { ...f.expected, plan: f.prepared.staged.reference })).review.operations).toHaveLength(3);
});

test("an aborted review transaction keeps the previous prepared state and native files", async () => {
	const f = await fixture(), add = IDBObjectStore.prototype.add;
	jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		const request = add.call(this, value, key); if (this.name === "receipts") request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()), { once: true }); return request;
	});
	await expect(f.run()).rejects.toThrow("aborted");
	expect(await f.journal.read()).toEqual(f.prepared.selection);
	expect(await fs.readFile(path.join(directory, "Team", "Changed.md"), "utf8")).toBe("local");
});

test("native completion is ordered, retryable, and required before activation", async () => {
	const f = await fixture(), saved = await f.run(), activation = saved.selection.pending!.preparation!.activation!;
	let state = await f.journal.apply({ type: "start", expectedRevision: saved.selection.revision, operationId: activation.startOperationId, reviewId: f.request.reviewId });
	const commit = () => f.journal.apply({ type: "commit", expectedRevision: state.revision, operationId: activation.commitOperationId, reviewId: f.request.reviewId, destinationRoot: "Team" });
	await expect(commit()).rejects.toThrow("Finish the reviewed native operations");
	await expect(f.journal.apply({ type: "finish-native-operation", expectedRevision: state.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId, nativeReview: saved.reference, index: 1 })).rejects.toThrow("out of order");
	await expect(f.journal.apply({ type: "review-native", expectedRevision: state.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId, nativeReview: saved.reference })).rejects.toThrow("before installation");
	for (let index = 0; index < saved.review.operations.length; index++) {
		// This test records simulated native completions; physical application
		// and final tree verification remain the coordinator's responsibility.
		const command = { type: "finish-native-operation" as const, expectedRevision: state.revision, operationId: saved.review.operations[index].id,
			reviewId: f.request.reviewId, nativeReview: saved.reference, index };
		state = await f.journal.apply(command); expect(state.pending?.completedNativeOperations).toBe(index + 1);
		expect(await f.journal.apply(command)).toEqual(state);
	}
	f.journal.close(); const reopened = await SourceSelectionJournal.open(f.source); journals.push(reopened);
	expect((await reopened.read()).pending?.completedNativeOperations).toBe(3);
	const selected = await reopened.apply({ type: "commit", expectedRevision: state.revision, operationId: activation.commitOperationId, reviewId: f.request.reviewId, destinationRoot: "Team" });
	expect(selected.nativeRoot).toBe("Team"); expect(selected.pending).toBeNull();
});

test("empty and unchanged selected folders need no fabricated native operations", async () => {
	const f = await fixture({ local: {}, server: {} }), result = await f.run();
	expect(result.reference.operations).toBe(0); expect(result.review.operations).toEqual([]);
	const activation = result.selection.pending!.preparation!.activation!;
	const started = await f.journal.apply({ type: "start", expectedRevision: result.selection.revision, operationId: activation.startOperationId, reviewId: f.request.reviewId });
	expect(started.pending?.completedNativeOperations).toBe(0);
	const committed = await f.journal.apply({ type: "commit", expectedRevision: started.revision, operationId: activation.commitOperationId, reviewId: f.request.reviewId, destinationRoot: "Team" });
	expect(committed.pending).toBeNull();
});

test("native review and progress cannot consume reserved activation IDs", async () => {
	const f = await fixture(), activation = f.prepared.selection.pending!.preparation!.activation!, create = jest.spyOn(f.staging, "createDirectoryExclusive");
	for (const operationId of Object.values(activation)) {
		await expect(prepareSameFolderReview(f.journal, f.staging, f.native, { ...f.request, operationId })).rejects.toThrow("reserved activation");
		await expect(f.journal.apply({ type: "review-native", expectedRevision: f.request.revision, operationId, reviewId: f.request.reviewId,
			nativeReview: { id: crypto.randomUUID(), sha256: "a".repeat(64), operations: 0 } })).rejects.toThrow("reserved activation");
	}
	expect(create).not.toHaveBeenCalled(); expect(await f.journal.read()).toEqual(f.prepared.selection);
	const saved = await f.run(), state = await f.journal.apply({ type: "start", expectedRevision: saved.selection.revision, operationId: activation.startOperationId, reviewId: f.request.reviewId });
	await expect(f.journal.apply({ type: "finish-native-operation", expectedRevision: state.revision, operationId: activation.commitOperationId,
		reviewId: f.request.reviewId, nativeReview: saved.reference, index: 0 })).rejects.toThrow("reserved activation");
	expect(await f.journal.read()).toEqual(state);
});

test("an aborted completion can be retried and a superseded receipt cannot move progress backwards", async () => {
	const f = await fixture(), saved = await f.run(), activation = saved.selection.pending!.preparation!.activation!;
	const state = await f.journal.apply({ type: "start", expectedRevision: saved.selection.revision, operationId: activation.startOperationId, reviewId: f.request.reviewId });
	const command = { type: "finish-native-operation" as const, expectedRevision: state.revision, operationId: saved.review.operations[0].id,
		reviewId: f.request.reviewId, nativeReview: saved.reference, index: 0 };
	const add = IDBObjectStore.prototype.add;
	const failure = jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		const request = add.call(this, value, key); if (this.name === "receipts") request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()), { once: true }); return request;
	});
	await expect(f.journal.apply(command)).rejects.toThrow("aborted"); expect(await f.journal.read()).toEqual(state); failure.mockRestore();
	const first = await f.journal.apply(command), second = await f.journal.apply({ ...command, expectedRevision: first.revision, operationId: saved.review.operations[1].id, index: 1 });
	await expect(f.journal.apply(command)).rejects.toThrow("superseded"); expect(await f.journal.read()).toEqual(second);
});

test("choices can be replaced only before starting, and stale review receipts cannot reinstate them", async () => {
	const f = await fixture(), first = await f.run();
	const second = await prepareSameFolderReview(f.journal, f.staging, f.native, { ...f.request, revision: first.selection.revision!, operationId: crypto.randomUUID() });
	expect(second.reference.id).not.toBe(first.reference.id);
	expect((await verifySameFolderReview(f.staging, first.reference, { ...f.expected, plan: f.prepared.staged.reference })).review).toEqual(first.review);
	await expect(f.journal.apply({ type: "review-native", expectedRevision: f.request.revision, operationId: f.request.operationId,
		reviewId: f.request.reviewId, nativeReview: first.reference })).rejects.toThrow("superseded");
	const state = await f.journal.apply({ type: "start", expectedRevision: second.selection.revision, operationId: second.selection.pending!.preparation!.activation!.startOperationId, reviewId: f.request.reviewId });
	await expect(f.journal.apply({ type: "finish-native-operation", expectedRevision: state.revision, operationId: crypto.randomUUID(),
		reviewId: f.request.reviewId, nativeReview: first.reference, index: 0 })).rejects.toThrow("applying native review changed");
	expect(await f.journal.read()).toEqual(state);
});

test.each([-1, 100_001, 0.5, NaN])("invalid native operation count %s does not change the journal", async operations => {
	const f = await fixture();
	await expect(f.journal.apply({ type: "review-native", expectedRevision: f.request.revision, operationId: crypto.randomUUID(), reviewId: f.request.reviewId,
		nativeReview: { id: crypto.randomUUID(), sha256: "a".repeat(64), operations } })).rejects.toThrow("Invalid source selection");
	expect(await f.journal.read()).toEqual(f.prepared.selection);
});
