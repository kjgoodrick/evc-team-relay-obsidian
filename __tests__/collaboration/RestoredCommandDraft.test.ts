import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "restored-copy" }, scope = id(3), generation = id(90);
const body = bodyFromText("Saved before restoration"), draftBody = protocolJson(editableCommentDraft(body, () => "Member"));
const command: QueuedCommand = { operationId: id(4), scopeId: scope, type: "thread.create", dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" }, body: protocolJson(body) } };
async function fixture() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory);
	await store.enqueue(command, 1);
	await store.enqueue({ operationId: id(7), scopeId: scope, type: "reply.create", dependsOn: [id(4)], payload: { type: "reply.create", thread_id: id(5), message_id: id(8), body: protocolJson(bodyFromText("Dependent reply")) } }, 2);
	await store.observeRestoreContext({ supported: true, generation }, 0);
	return { store, factory, original: (await store.getOperation(id(4)))!, close: () => store.close() };
}

test("a restored request becomes a local draft without a target, preserving originals and dependent work", async () => {
	const f = await fixture();
	try {
		const before = await f.store.pending(scope), copy = await f.store.copyRestoredCommandDraft(f.original, draftBody, generation);
		expect(copy.created).toBe(true); expect(copy.draft).toMatchObject({ scopeId: scope, revision: 0, body: draftBody }); expect(copy.draft?.target).toBeUndefined();
		expect(copy.draft?.id).toBe(`restored:${id(4)}:${generation}`);
		expect(await f.store.pending(scope)).toEqual(before); expect(await f.store.claimNext("worker", 1000)).toBeUndefined();
		expect(await f.store.selectionDrafts(scope)).toEqual({ drafts: [], hasMore: false });
		const snapshot = await f.store.captureLocalWork(id(99), 10);
		expect(snapshot.drafts).toEqual([copy.draft]); expect(snapshot.actions).toContainEqual({ key: "restoredDraft:" + copy.draft!.id, value: expect.objectContaining({ sourceOperationId: id(4), sourceGeneration: null, copiedGeneration: generation, sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }) });
	} finally { f.close(); }
});

test("competing windows create one copy and later attempts preserve edits and discarded copies", async () => {
	const f = await fixture(), other = await DiscussionStore.open(identity, f.factory);
	try {
		const results = await Promise.all([f.store.copyRestoredCommandDraft(f.original, draftBody, generation), other.copyRestoredCommandDraft(f.original, draftBody, generation)]);
		expect(results.filter(result => result.created)).toHaveLength(1); expect(results[0].draft).toEqual(results[1].draft);
		const edited = { ...results[0].draft!, revision: 1, body: protocolJson(editableCommentDraft(bodyFromText("Edited local copy"), () => "Member")) };
		await f.store.saveDraft(edited, 0);
		expect(await other.copyRestoredCommandDraft(f.original, draftBody, generation)).toEqual({ draft: edited, created: false });
		await f.store.removeDraft(edited.id, 1, edited);
		expect(await f.store.copyRestoredCommandDraft(f.original, draftBody, generation)).toEqual({ draft: undefined, created: false });
		expect(await f.store.getDraft(edited.id)).toBeUndefined(); expect(await f.store.getOperation(id(4))).toEqual(f.original);
	} finally { other.close(); f.close(); }
});

test.each(["current lineage", "changed body", "changed request", "unquarantined", "unavailable context"])("copying rejects %s and leaves saved work untouched", async kind => {
	const f = await fixture();
	try {
		const selected = { ...f.original };
		let content = draftBody;
		if (kind === "current lineage") selected.restoreGeneration = generation;
		if (kind === "changed body") content = protocolJson(editableCommentDraft(bodyFromText("Other"), () => "Member"));
		if (kind === "changed request") selected.dependsOn = [id(50)];
		if (kind === "unquarantined") delete selected.error;
		await expect(f.store.copyRestoredCommandDraft(selected, content, generation, () => kind !== "unavailable context")).rejects.toThrow();
		expect((await f.store.localDraftPage()).items).toEqual([]); expect(await f.store.getOperation(id(4))).toEqual(f.original);
	} finally { f.close(); }
});

test("another restore invalidates the selected generation while preserving previous local copies", async () => {
	const f = await fixture();
	try {
		const first = await f.store.copyRestoredCommandDraft(f.original, draftBody, generation);
		await f.store.observeRestoreContext({ supported: true, generation: id(91) }, 1);
		await expect(f.store.copyRestoredCommandDraft(f.original, draftBody, generation)).rejects.toThrow("restore_generation_changed");
		const next = await f.store.copyRestoredCommandDraft((await f.store.getOperation(id(4)))!, draftBody, id(91));
		expect(next.created).toBe(true); expect(next.draft!.id).not.toBe(first.draft!.id); expect(await f.store.getDraft(first.draft!.id)).toEqual(first.draft);
	} finally { f.close(); }
});

test.each(["quota", "cancelled"])("a %s failure after draft insertion rolls back the copy and its provenance", async kind => {
	const f = await fixture(), add = IDBObjectStore.prototype.add; let changed = false;
	const spy = jest.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: globalThis.IDBObjectStore, value, key) {
		if (this.name === "preferences" && typeof key === "string" && key.startsWith("restoredDraft:")) {
			if (kind === "quota") throw new DOMException("Fixture quota", "QuotaExceededError"); changed = true;
		}
		return add.call(this, value, key);
	});
	try {
		await expect(f.store.copyRestoredCommandDraft(f.original, draftBody, generation, () => !changed)).rejects.toThrow();
		expect((await f.store.localDraftPage()).items).toEqual([]); expect(await f.store.preference(`restoredDraft:restored:${id(4)}:${generation}`)).toBeUndefined();
		expect(await f.store.getOperation(id(4))).toEqual(f.original);
	} finally { spy.mockRestore(); f.close(); }
});

test("original pictures are pinned by the local copy without restamping or sending their uploads", async () => {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory);
	try {
		const picture = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const rich = { version: 1 as const, blocks: [...body.blocks, { type: "picture" as const, picture_id: picture.id, alt: "Retained original" }] };
		const content = protocolJson(editableCommentDraft(rich, () => "Member"));
		await store.saveDraft({ id: "source", scopeId: scope, revision: 0, body: content }, null, [picture]);
		await store.enqueue({ ...command, payload: { ...(command.payload as object), body: protocolJson(rich) } }, 1, { id: "source", revision: 0 });
		await store.observeRestoreContext({ supported: true, generation }, 0);
		const original = (await store.getOperation(id(4)))!, before = await store.pending(scope), copy = await store.copyRestoredCommandDraft(original, content, generation);
		expect(copy.draft?.body).toEqual(content); expect(await store.pending(scope)).toEqual(before);
		expect(await store.pictureSource(picture.id, scope)).toMatchObject({ sha256: picture.sha256, size: 3 }); expect(await store.preference("pictureSourceBytes")).toBe(3);
		const snapshot = await store.captureLocalWork(id(98)); expect(snapshot.pictures).toHaveLength(1);
		expect(await store.claimNext("worker", 1000)).toBeUndefined();
	} finally { store.close(); }
});
