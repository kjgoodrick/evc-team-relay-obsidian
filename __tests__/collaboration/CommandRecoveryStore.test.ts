import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import * as Y from "yjs";
import { captureTextAnchor } from "../../src/collaboration/anchors/text";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "recovery" };
const scope = id(3), body = bodyFromText("Saved text"), anchor = { version: 1, type: "note" };
const initial = protocolJson(editableCommentDraft(body, () => "Member"));
function command(n = 4): QueuedCommand {
	return { operationId: id(n), scopeId: scope, type: "thread.create", dependsOn: [],
		payload: { type: "thread.create", thread_id: id(5), message_id: id(6), body: protocolJson(body), anchor } };
}
async function fixture() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory);
	const original = await store.enqueue(command(), 1);
	return { store, original, factory, close: () => store.close() };
}

test("withdrawn work becomes an editable durable draft; stale worker outcomes cannot send or discard it", async () => {
	const f = await fixture();
	try {
		const flight = (await f.store.claimNext("worker", 10))!;
		const draft = await f.store.restoreCommandForReview(flight, initial);
		expect(draft).toMatchObject({ scopeId: scope, revision: 0, body: initial, target: anchor });
		expect(await f.store.pending(scope)).toEqual([expect.objectContaining({ state: "review", reviewDraftId: draft.id })]);
		expect(await f.store.claimNext("other", 20)).toBeUndefined();
		await f.store.fail(flight.operationId, flight.lease!, "late failure", 30);
		await f.store.accept(flight.operationId, { late: true });
		expect((await f.store.getOperation(flight.operationId))?.state).toBe("review");
		const edited = { ...draft, revision: 1, body: protocolJson(editableCommentDraft(bodyFromText("Revised draft"), () => "Member")) };
		await f.store.saveDraft(edited, 0);
		const reopened = await DiscussionStore.open(identity, f.factory);
		try { expect(await reopened.restoreCommandForReview(f.original, initial)).toEqual(edited); }
		finally { reopened.close(); }
		await expect(f.store.removeDraft(draft.id, 1)).rejects.toThrow("dependents");
	} finally { f.close(); }
});

test("replacement preserves identities and rewires an unsent dependent reply atomically", async () => {
	const f = await fixture();
	try {
		const reply = { ...command(8), type: "reply.create" as const, payload: { type: "reply.create", thread_id: id(5), message_id: id(9), body: protocolJson(body) }, dependsOn: [id(4)] };
		await f.store.enqueue(reply, 2);
		const draft = await f.store.restoreCommandForReview(f.original, initial);
		const replacement = command(10);
		await expect(f.store.enqueue({ ...replacement, payload: { ...(replacement.payload as object), thread_id: id(99) } }, 3, draft)).rejects.toThrow("identity");
		await expect(f.store.enqueue({ ...replacement, dependsOn: [reply.operationId] }, 3, draft)).rejects.toThrow("unrelated dependency");
		await f.store.enqueue(replacement, 3, draft);
		expect(await f.store.getDraft(draft.id)).toBeUndefined();
		expect(await f.store.getOperation(id(4))).toMatchObject({ state: "withdrawn", replacementId: id(10), payload: f.original.payload });
		expect(await f.store.getOperation(id(8))).toMatchObject({ dependsOn: [id(10)], attempt: 0, payload: reply.payload });
		expect((await f.store.claimNext("worker", 4))?.operationId).toBe(id(10));
		await f.store.accept(id(10), { accepted: true });
		expect((await f.store.claimNext("worker", 5))?.operationId).toBe(id(8));
		await expect(f.store.enqueue(command(11), 6, draft)).rejects.toThrow("Draft changed");
	} finally { f.close(); }
});

test("competing recovery panes can enqueue only one replacement", async () => {
	const f = await fixture();
	try {
		const draft = await f.store.restoreCommandForReview(f.original, initial);
		const other = await DiscussionStore.open(identity, f.factory);
		try {
			const results = await Promise.allSettled([f.store.enqueue(command(10), 3, draft), other.enqueue(command(11), 3, draft)]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			expect(await f.store.pending(scope)).toHaveLength(1);
			expect((await f.store.getOperation(id(4)))?.state).toBe("withdrawn");
		} finally { other.close(); }
	} finally { f.close(); }
});

test("picture originals and rich body survive review and atomic replacement without double storage accounting", async () => {
	const f = await fixture();
	try {
		const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const rich = { version: 1 as const, blocks: [...body.blocks, { type: "picture" as const, picture_id: source.id, alt: "Saved picture" }] };
		const content = protocolJson(editableCommentDraft(rich, () => "Member"));
		await f.store.saveDraft({ id: "picture-draft", scopeId: scope, revision: 0, body: content }, null, [source]);
		const op = await f.store.enqueue({ ...command(21), payload: { ...(command(21).payload as object), body: protocolJson(rich) } }, 2, { id: "picture-draft", revision: 0 });
		const draft = await f.store.restoreCommandForReview(op, content);
		expect(await f.store.preference("pictureSourceBytes")).toBe(3);
		await f.store.enqueue({ ...command(22), payload: { ...(command(22).payload as object), body: protocolJson(rich) } }, 3, draft);
		expect(await f.store.pictureSource(id(20), scope)).toMatchObject({ size: 3 });
		expect(await f.store.preference("pictureSourceBytes")).toBe(3);
		expect(await f.store.getOperation(id(22))).toMatchObject({ dependsOn: [id(20)] });
	} finally { f.close(); }
});

test("accepted commands and changed group preparation cannot be restored as a fresh send", async () => {
	const f = await fixture();
	try {
		await expect(f.store.restoreCommandForReview(f.original, initial, true)).rejects.toThrow("Group capture advanced");
		await expect(f.store.restoreCommandForReview({ ...f.original, preparedAnchor: { changed: true } }, initial)).rejects.toThrow("Group capture changed");
		await f.store.accept(id(4), { accepted: true });
		await expect(f.store.restoreCommandForReview(f.original, initial)).rejects.toThrow("already completed");
		expect(await f.store.getDraft("recovery:" + id(4))).toBeUndefined();
	} finally { f.close(); }
});

test("recovering parent and reply separately preserves their ordering in either editing order", async () => {
	const f = await fixture();
	try {
		const reply = { ...command(8), type: "reply.create" as const, payload: { type: "reply.create", thread_id: id(5), message_id: id(9), body: protocolJson(body) }, dependsOn: [id(4)] };
		const pending = await f.store.enqueue(reply, 2);
		const childDraft = await f.store.restoreCommandForReview(pending, initial), parentDraft = await f.store.restoreCommandForReview(f.original, initial);
		await f.store.enqueue(command(10), 3, parentDraft);
		expect(await f.store.getOperation(id(8))).toMatchObject({ state: "review", dependsOn: [id(10)] });
		await f.store.enqueue({ ...reply, operationId: id(11), dependsOn: [] }, 4, childDraft);
		expect(await f.store.getOperation(id(11))).toMatchObject({ state: "queued", dependsOn: [id(10)] });
	} finally { f.close(); }
});

test.each([false, true])("removing a picture retires only abandoned uploads (shared draft: %s)", async shared => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const rich = { version: 1 as const, blocks: [...body.blocks, { type: "picture" as const, picture_id: source.id, alt: "Picture" }] };
		const content = protocolJson(editableCommentDraft(rich, () => "Member"));
		await store.saveDraft({ id: "original", scopeId: scope, revision: 0, body: content }, null, [source]);
		if (shared) await store.saveDraft({ id: "shared", scopeId: scope, revision: 0, body: content }, null);
		const op = await store.enqueue({ ...command(), payload: { ...(command().payload as object), body: protocolJson(rich) } }, 1, { id: "original", revision: 0 });
		const draft = await store.restoreCommandForReview(op, content);
		await store.enqueue(command(10), 2, draft);
		expect((await store.getOperation(id(20)))?.state).toBe(shared ? "queued" : "withdrawn");
		expect(await store.preference("pictureSourceBytes")).toBe(shared ? 3 : 0);
		expect(await store.getOperation(id(10))).toMatchObject({ dependsOn: [] });
	} finally { store.close(); }
});

test("version-20 upgrade preserves saved work and closes workers that cannot understand review drafts", async () => {
	const factory = new IDBFactory();
	const opening = jest.spyOn(factory, "open").mockImplementationOnce(name => IDBFactory.prototype.open.call(factory, name, 20));
	const old = await DiscussionStore.open(identity, factory); opening.mockRestore();
	const original = await old.enqueue(command(), 1);
	const current = await DiscussionStore.open(identity, factory);
	try {
		const recovered = await current.restoreCommandForReview(original, initial);
		expect(await current.getDraft(recovered.id)).toEqual(recovered);
		await expect(old.claimNext("old-worker", 2)).rejects.toThrow();
		const name = "team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
		await expect(new Promise((resolve, reject) => {
			const request = factory.open(name, 20); request.onerror = () => reject(request.error); request.onsuccess = () => { request.result.close(); resolve(undefined); };
		})).rejects.toMatchObject({ name: "VersionError" });
	} finally { current.close(); old.close(); }
});

test("only reviewed creation drafts can change targets; body, operation and ordinary selection rules stay intact", async () => {
	const f = await fixture(), document = new Y.Doc();
	try {
		const text = document.getText("contents"); text.insert(0, "alpha beta gamma");
		const selected = protocolJson(wireTextAnchor(captureTextAnchor(text, scope, id(20), 6, 10)));
		const draft = await f.store.restoreCommandForReview(f.original, initial);
		await expect(f.store.saveDraft({ ...draft, revision: 1, target: selected }, 0)).rejects.toThrow("Draft target changed");
		const moved = await f.store.retargetRecoveredDraft(draft.id, 0, selected);
		expect(moved).toMatchObject({ revision: 1, body: initial, target: selected });
		expect((await f.store.getOperation(id(4)))?.payload).toEqual(f.original.payload);
		await expect(f.store.retargetRecoveredDraft(draft.id, 0, anchor)).rejects.toThrow("Draft changed");
		await expect(f.store.retargetRecoveredDraft(draft.id, 1, protocolJson(wireTextAnchor(captureTextAnchor(text, id(99), id(20), 6, 10))))).rejects.toThrow("same note");
		const whole = await f.store.retargetRecoveredDraft(draft.id, 1, anchor);
		expect(whole).toMatchObject({ revision: 2, body: initial, target: anchor });
		await f.store.enqueue(command(10), 2, whole);
		await expect(f.store.retargetRecoveredDraft(draft.id, 2, selected)).rejects.toThrow("Draft changed");
		await f.store.saveDraft({ id: "ordinary", scopeId: scope, revision: 0, body: initial, target: anchor }, null);
		await expect(f.store.retargetRecoveredDraft("ordinary", 0, selected)).rejects.toThrow("Only a recovered");
	} finally { document.destroy(); f.close(); }
});

test("recovered Bases targets stay within their saved view and replies cannot be retargeted", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const scopeId = baseDiscussionScope(id(3), id(4));
		const target = { version: 1, type: "base", definition_id: id(20), view_id: id(4), generation: id(21), registry_revision: 1, target: { type: "view" } };
		const original = await store.enqueue({ ...command(), scopeId, payload: { ...(command().payload as object), anchor: target } }, 1);
		const draft = await store.restoreCommandForReview(original, initial);
		const header = { ...target, target: { type: "property", property: { source: "note", name: "status" } } };
		expect((await store.retargetRecoveredDraft(draft.id, 0, header)).target).toEqual(header);
		await expect(store.retargetRecoveredDraft(draft.id, 1, { ...target, view_id: id(99) })).rejects.toThrow("same note");
		await expect(store.retargetRecoveredDraft(draft.id, 1, anchor)).rejects.toThrow("same note");
		const reply = await store.enqueue({ ...command(30), type: "reply.create", payload: { type: "reply.create", thread_id: id(5), message_id: id(6), body: protocolJson(body) } }, 2);
		const replyDraft = await store.restoreCommandForReview(reply, initial);
		await expect(store.retargetRecoveredDraft(replyDraft.id, 0, anchor)).rejects.toThrow("Only a recovered");
	} finally { store.close(); }
});
