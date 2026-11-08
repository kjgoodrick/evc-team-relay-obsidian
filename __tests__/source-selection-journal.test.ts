import "fake-indexeddb/auto";
import { SourceSelectionJournal, type SourceSelectionState, type SourceSelectionCommand, type SourcePreparation, type SourceActivationOperations } from "../src/storage/source-selection-journal";
import { RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../src/conflictCopyPath";
import { watchSourceSelection } from "../src/storage/source-selection-events";

const scope = () => ({ hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
	s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())) });
const journals: SourceSelectionJournal[] = [];
async function open(value = scope()) { const journal = await SourceSelectionJournal.open(value); journals.push(journal); return journal; }
const preparation = (): SourcePreparation => ({ archive: { path: `${RECOVERY_FOLDER}/retained-${crypto.randomUUID()}`, manifestSha256: "a".repeat(64) }, plan: { id: crypto.randomUUID(), sha256: "b".repeat(64) } });
function begin(expectedRevision: string | null = null): SourceSelectionCommand {
	return { operationId: crypto.randomUUID(), expectedRevision, type: "begin", reviewId: crypto.randomUUID(), restoreGeneration: crypto.randomUUID() };
}
async function step(journal: SourceSelectionJournal, state: SourceSelectionState, type: "prepare" | "start" | "commit" | "cancel") {
	const base = { operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId };
	return journal.apply(type === "prepare" ? { ...base, type, preparation: preparation() } : { ...base, type });
}
afterEach(() => { journals.splice(0).forEach(journal => journal.close()); jest.restoreAllMocks(); jest.useRealTimers(); });

test("activation stores its native root atomically with the selected generation and exact retry receipt", async () => {
	const journal = await open(); let state = await journal.apply(begin());
	state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	const command = { type: "commit" as const, operationId: crypto.randomUUID(), expectedRevision: state.revision,
		reviewId: state.pending!.reviewId, destinationRoot: "Restored Team" };
	const selected = await journal.apply(command);
	expect(selected.nativeRoot).toBe("Restored Team"); expect(selected.pending).toBeNull();
	await journal.assertActive(selected.revision, selected.active, "Restored Team");
	await expect(journal.assertActive(selected.revision, selected.active)).rejects.toThrow("changed");
	await expect(journal.assertActive(selected.revision, selected.active, "Original Team")).rejects.toThrow("changed");
	expect(await journal.apply(command)).toEqual(selected);
	await expect(journal.apply({ ...command, destinationRoot: "Original Team" })).rejects.toThrow("different work");
	expect(await journal.read()).toEqual(selected);
});

test("read-only commit reconciliation survives reopen without writes or change notifications", async () => {
	const value = scope(); let journal = await open(value), state = await journal.apply(begin());
	state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	const receipt = { operationId: crypto.randomUUID(), reviewId: state.pending!.reviewId, restoreGeneration: state.pending!.restoreGeneration };
	const selected = await journal.apply({ ...receipt, type: "commit", expectedRevision: state.revision, destinationRoot: "Restored Team" });
	journal.close(); journal = await open(value);
	const put = jest.spyOn(IDBObjectStore.prototype, "put"), add = jest.spyOn(IDBObjectStore.prototype, "add"), changed = jest.fn();
	const stop = watchSourceSelection(journal.name, changed);
	try {
		expect(await journal.reconcileCommit(receipt)).toEqual(selected);
		for (const mismatch of [{ operationId: crypto.randomUUID() }, { reviewId: crypto.randomUUID() }, { restoreGeneration: crypto.randomUUID() }]) {
			await expect(journal.reconcileCommit({ ...receipt, ...mismatch })).rejects.toThrow("receipt");
		}
		expect(put).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
	} finally { stop(); }
	const next = await journal.apply(begin(selected.revision));
	await expect(journal.reconcileCommit(receipt)).rejects.toThrow("superseded"); expect(await journal.read()).toEqual(next);
});

test("reconciliation rejects an older rootless activation instead of admitting its source", async () => {
	const journal = await open(); let state = await journal.apply(begin());
	state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	const receipt = { operationId: crypto.randomUUID(), reviewId: state.pending!.reviewId, restoreGeneration: state.pending!.restoreGeneration };
	const selected = await journal.apply({ ...receipt, type: "commit", expectedRevision: state.revision });
	await expect(journal.reconcileCommit(receipt)).rejects.toThrow("does not match"); expect(await journal.read()).toEqual(selected);
});

test("an activation precondition lost while the transaction reads cannot save a commit or receipt", async () => {
	const journal = await open(); let state = await journal.apply(begin());
	state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	const receipt = { operationId: crypto.randomUUID(), reviewId: state.pending!.reviewId, restoreGeneration: state.pending!.restoreGeneration };
	let checks = 0;
	await expect(journal.apply({ ...receipt, type: "commit", expectedRevision: state.revision, destinationRoot: "Restored Team" }, {
		check: () => { if (++checks > 1) throw new Error("Writer isolation was lost"); },
	})).rejects.toThrow("isolation");
	expect(await journal.read()).toEqual(state); await expect(journal.reconcileCommit(receipt)).rejects.toThrow("missing");
});

test("prepared activation operations survive reopen and bind both installation transitions", async () => {
	const value = scope(); let journal = await open(value), state = await journal.apply(begin());
	const activation = { startOperationId: crypto.randomUUID(), commitOperationId: crypto.randomUUID() };
	state = await journal.apply({ type: "prepare", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId,
		preparation: { ...preparation(), activation } });
	journal.close(); journal = await open(value); expect((await journal.read()).pending!.preparation!.activation).toEqual(activation);
	await expect(step(journal, state, "start")).rejects.toThrow("saved source installation operation");
	state = await journal.apply({ type: "start", operationId: activation.startOperationId, expectedRevision: state.revision, reviewId: state.pending!.reviewId });
	await expect(step(journal, state, "commit")).rejects.toThrow("saved source activation operation");
	const receipt = { operationId: activation.commitOperationId, reviewId: state.pending!.reviewId, restoreGeneration: state.pending!.restoreGeneration };
	const selected = await journal.apply({ ...receipt, type: "commit", expectedRevision: state.revision, destinationRoot: "Restored Team" });
	expect(await journal.reconcileCommit(receipt)).toEqual(selected);
});

test.each(["prepared", "applying"])("an older %s preview can durably reserve operations once without changing its artifacts", async phase => {
	const journal = await open(); let state = await journal.apply(begin()); state = await step(journal, state, "prepare");
	if (phase === "applying") state = await step(journal, state, "start");
	const prior = structuredClone(state), activation = { startOperationId: crypto.randomUUID(), commitOperationId: crypto.randomUUID() };
	const change = { type: "reserve-activation" as const, operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId, activation };
	state = await journal.apply(change);
	expect(state.pending).toEqual({ ...prior.pending, preparation: { ...prior.pending!.preparation, activation } }); expect(state.active).toEqual(prior.active);
	expect(await journal.apply(change)).toEqual(state);
	await expect(journal.apply({ ...change, operationId: crypto.randomUUID(), expectedRevision: state.revision })).rejects.toThrow("already has saved");
});

test.each(["same", "current operation", "used operation"])("activation reservation refuses %s IDs without changing the prepared artifacts", async kind => {
	const journal = await open(), beginning = begin(); let state = await journal.apply(beginning); state = await step(journal, state, "prepare");
	const operationId = crypto.randomUUID(), activation: SourceActivationOperations = { startOperationId: crypto.randomUUID(), commitOperationId: crypto.randomUUID() };
	if (kind === "same") activation.commitOperationId = activation.startOperationId;
	if (kind === "current operation") activation.commitOperationId = operationId;
	if (kind === "used operation") activation.startOperationId = beginning.operationId;
	await expect(journal.apply({ type: "reserve-activation", operationId, expectedRevision: state.revision, reviewId: state.pending!.reviewId, activation })).rejects.toThrow();
	expect(await journal.read()).toEqual(state);
});

test("a late operation-reservation abort retains the prepared review without a partial intent", async () => {
	const journal = await open(); let state = await journal.apply(begin()); state = await step(journal, state, "prepare");
	const add = IDBObjectStore.prototype.add;
	const spy = jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		const request = add.call(this, value, key); if (this.name === "receipts") request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()), { once: true }); return request;
	});
	await expect(journal.apply({ type: "reserve-activation", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId,
		activation: { startOperationId: crypto.randomUUID(), commitOperationId: crypto.randomUUID() } })).rejects.toThrow("aborted");
	spy.mockRestore(); expect(await journal.read()).toEqual(state);
});

test.each(["", "/Team", "../Team", "Team/../Other", ".obsidian", "Team/.hidden", "TEAM/Relay Recovery (local only)", "Relay Recovery (local only)/Child", "Team/CON", "Team/e\u0301"])("unsafe activation root is refused: %s", async destinationRoot => {
	const journal = await open(); let state = await journal.apply(begin()); state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	await expect(journal.apply({ type: "commit", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId, destinationRoot })).rejects.toThrow();
	expect(await journal.read()).toEqual(state);
});

test("an older commit caller cannot carry the previous generation's root into a new choice", async () => {
	const journal = await open(); let state = await journal.apply(begin()); state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	state = await journal.apply({ type: "commit", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId, destinationRoot: "First restore" });
	state = await journal.apply(begin(state.revision)); state = await step(journal, state, "prepare"); state = await step(journal, state, "start");
	state = await step(journal, state, "commit"); expect(state.nativeRoot).toBeUndefined();
});

test("every interrupted phase survives reopening and denies admission until committed", async () => {
	const value = scope(); let journal = await open(value), state = await journal.read();
	await journal.assertActive(null, { kind: "legacy" });
	state = await journal.apply(begin());
	const generation = state.pending!.restoreGeneration;
	for (const phase of ["review", "prepared", "applying"] as const) {
		expect(state.pending!.phase).toBe(phase); journal.close(); journal = await open(value);
		expect(await journal.read()).toEqual(state);
		await expect(journal.assertActive(state.revision, state.active)).rejects.toThrow("awaiting recovery");
		if (phase !== "applying") state = await step(journal, state, phase === "review" ? "prepare" : "start");
	}
	const held = state; state = await step(journal, state, "commit");
	expect(state.active).toEqual({ kind: "source", restoreGeneration: generation }); expect(state.pending).toBeNull();
	await journal.assertActive(state.revision, state.active);
	await expect(journal.assertActive(held.revision, held.active)).rejects.toThrow("changed");
	journal.close(); journal = await open(value); expect(await journal.read()).toEqual(state);
});

test.each(["review", "prepared"])("cancelling %s preserves the previous source choice and requires a new admission revision", async phase => {
	const journal = await open(); let state = await journal.apply(begin());
	if (phase === "prepared") state = await step(journal, state, "prepare");
	state = await step(journal, state, "cancel"); expect(state.active).toEqual({ kind: "legacy" }); expect(state.pending).toBeNull();
	await expect(journal.assertActive(null, { kind: "legacy" })).rejects.toThrow("changed");
	await journal.assertActive(state.revision, { kind: "legacy" });
});

test("an installation cannot be abandoned or committed before preparation and start", async () => {
	const journal = await open(); let state = await journal.apply(begin());
	await expect(step(journal, state, "start")).rejects.toThrow("Prepare");
	await expect(step(journal, state, "commit")).rejects.toThrow("not started");
	state = await step(journal, state, "prepare"); await expect(step(journal, state, "commit")).rejects.toThrow("not started");
	state = await step(journal, state, "start"); await expect(step(journal, state, "cancel")).rejects.toThrow("native files");
	expect(await journal.read()).toEqual(state);
});

test("lost acknowledgment retries return the exact committed decision across reopen; obsolete receipts cannot rewind it", async () => {
	const value = scope(); let journal = await open(value); const change = begin(), state = await journal.apply(change);
	journal.close(); journal = await open(value); expect(await journal.apply(change)).toEqual(state);
	await expect(journal.apply({ ...change, reviewId: crypto.randomUUID() })).rejects.toThrow("different work");
	const prepared = await step(journal, state, "prepare");
	await expect(journal.apply(change)).rejects.toThrow("superseded"); expect(await journal.read()).toEqual(prepared);
});

test("concurrent reviewers cannot overwrite each other and stale revisions cannot start installation", async () => {
	const value = scope(), [a, b] = await Promise.all([open(value), open(value)]);
	const results = await Promise.allSettled([a.apply(begin()), b.apply(begin())]);
	expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
	const state = await a.read(); expect(await b.read()).toEqual(state);
	const prepared = await step(a, state, "prepare");
	await expect(step(b, state, "start")).rejects.toThrow("changed"); expect(await b.read()).toEqual(prepared);
});

test("a later generation retires the previous cache selection permanently, including the explicit null lineage", async () => {
	const journal = await open(); let state = await journal.read();
	const generations = [null, crypto.randomUUID(), crypto.randomUUID()];
	for (const generation of generations) {
		state = await journal.apply({ ...begin(state.revision), type: "begin", restoreGeneration: generation });
		state = await step(journal, state, "prepare"); state = await step(journal, state, "start"); state = await step(journal, state, "commit");
	}
	expect(state.retired).toEqual(generations.slice(0, -1));
	for (const generation of generations) await expect(journal.apply({ ...begin(state.revision), type: "begin", restoreGeneration: generation })).rejects.toThrow("active or retired");
	expect(await journal.read()).toEqual(state);
});

test.each(["begin", "commit"])("a late %s transaction abort preserves the prior choice/hold and leaves no retry receipt", async type => {
	const journal = await open(); let prior = await journal.read(), change = begin();
	if (type === "commit") {
		prior = await journal.apply(change); prior = await step(journal, prior, "prepare"); prior = await step(journal, prior, "start");
		change = { type: "commit", operationId: crypto.randomUUID(), expectedRevision: prior.revision, reviewId: prior.pending!.reviewId, destinationRoot: "Restored Team" };
	}
	const add = IDBObjectStore.prototype.add;
	const spy = jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
		const request = add.call(this, value, key);
		if (this.name === "receipts") request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()), { once: true });
		return request;
	});
	await expect(journal.apply(change)).rejects.toThrow("aborted"); spy.mockRestore();
	expect(await journal.read()).toEqual(prior);
	const saved = await journal.apply(change); expect(saved.revision).not.toBe(prior.revision);
	if (type === "commit") { expect(saved.pending).toBeNull(); expect(saved.nativeRoot).toBe("Restored Team"); } else expect(saved.pending!.reviewId).toBe(change.reviewId);
	expect(await journal.apply(change)).toEqual(saved);
});

test("input and returned objects cannot mutate a pending or persisted decision", async () => {
	const journal = await open(), change = begin(), review = change.reviewId;
	const pending = journal.apply(change); change.reviewId = crypto.randomUUID();
	const state = await pending; expect(state.pending!.reviewId).toBe(review);
	const saved = JSON.parse(JSON.stringify(state)); state.pending!.reviewId = crypto.randomUUID(); state.retired.push(null);
	expect(await journal.read()).toEqual(saved);
});

test("scope identity separates vault, configured server, endpoint and share while equivalent endpoints reuse the journal", async () => {
	const value = scope(), first = await open(value), state = await first.apply(begin());
	const equivalent = await open({ ...value, controlPlaneUrl: "https://FIXTURE.test:443/" }); expect(await equivalent.read()).toEqual(state);
	for (const other of [ { ...value, hostAppId: crypto.randomUUID() }, { ...value, serverId: "other" },
		{ ...value, controlPlaneUrl: "https://other.test" }, { ...value, s3rn: scope().s3rn } ]) {
		const journal = await open(other); expect(journal.name).not.toBe(first.name); expect((await journal.read()).revision).toBeNull();
	}
});

async function corrupt(journal: SourceSelectionJournal, value?: unknown) {
	const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(journal.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
	try { await new Promise<void>((resolve, reject) => {
		const tx = db.transaction("selection", "readwrite"), store = tx.objectStore("selection");
		if (value === undefined) store.delete("state"); else store.put(value, "state");
		tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
	}); } finally { db.close(); }
}
test.each(["missing", "version", "scope", "extra", "phase", "revision", "retired"])("a %s journal corruption cannot fall back to the legacy cache", async kind => {
	const journal = await open(), state = await journal.apply(begin());
	const row = JSON.parse(JSON.stringify(state));
	if (kind === "version") row.version = 2;
	if (kind === "scope") row.scopeIdentity = "other";
	if (kind === "extra") row.unknown = "future schema";
	if (kind === "phase") row.pending.phase = "finished";
	if (kind === "revision") row.revision = null;
	if (kind === "retired") row.retired = [row.pending.restoreGeneration];
	await corrupt(journal, kind === "missing" ? undefined : row);
	await expect(journal.read()).rejects.toThrow("Invalid source selection");
	await expect(journal.apply(begin())).rejects.toThrow("Invalid source selection");
});

test("the retired-history bound refuses a new review before native installation can begin", async () => {
	const journal = await open(); let state = await journal.apply(begin());
	state = await step(journal, state, "prepare"); state = await step(journal, state, "start"); state = await step(journal, state, "commit");
	state.retired = Array.from({ length: 1024 }, () => crypto.randomUUID()); await corrupt(journal, state);
	await expect(journal.apply(begin(state.revision))).rejects.toThrow("needs maintenance");
	expect(await journal.read()).toEqual(state); expect(state.pending).toBeNull();
});

test.each(["archive path", "archive hash", "plan id", "plan hash"])("invalid %s references cannot move review into preparation", async kind => {
	const journal = await open(), state = await journal.apply(begin()), ref = preparation();
	if (kind === "archive path") ref.archive.path = `${RECOVERY_FOLDER}/../escape`;
	if (kind === "archive hash") ref.archive.manifestSha256 = "bad";
	if (kind === "plan id") ref.plan.id = "bad";
	if (kind === "plan hash") ref.plan.sha256 = "bad";
	await expect(journal.apply({ operationId: crypto.randomUUID(), expectedRevision: state.revision, type: "prepare", reviewId: state.pending!.reviewId, preparation: ref })).rejects.toThrow();
	expect(await journal.read()).toEqual(state);
});

test("a closed journal cannot return authority or accept new decisions", async () => {
	const journal = await open(); journal.close();
	await expect(journal.read()).rejects.toThrow("closed"); await expect(journal.apply(begin())).rejects.toThrow("closed");
});

test("a read blocked behind another transaction times out without granting legacy admission", async () => {
	const journal = await open();
	const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(journal.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
	const blocker = db.transaction("selection", "readwrite"), store = blocker.objectStore("selection");
	let waiting = true;
	const keepAlive = () => { if (waiting) store.get("state").onsuccess = keepAlive; }; keepAlive();
	jest.useFakeTimers({ doNotFake: ["setImmediate", "clearImmediate"] });
	try {
		const pending = journal.assertActive(null, { kind: "legacy" });
		jest.advanceTimersByTime(5001);
		await expect(pending).rejects.toThrow("did not respond");
	} finally { waiting = false; blocker.abort(); db.close(); jest.useRealTimers(); }
	await journal.assertActive(null, { kind: "legacy" });
});

test("a newer journal schema closes the old client and cannot be downgraded into an empty legacy selection", async () => {
	const value = scope(), journal = await open(value); await journal.apply(begin());
	const newer = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(journal.name, 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
	});
	try {
		await expect(journal.read()).rejects.toThrow("closed");
		await expect(open(value)).rejects.toThrow();
	} finally { newer.close(); }
});
