import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "restore-store" };
const scope = id(3), generation = id(90);
const command = (n = 4): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: "thread.create", dependsOn: [],
	payload: protocolJson({ type: "thread.create", thread_id: id(10), message_id: id(11), body: bodyFromText("Saved work"), anchor: { version: 1, type: "note" } }) });
let store: DiscussionStore, factory: IDBFactory;
beforeEach(async () => { factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory); });
afterEach(() => store.close());
const restore = async (value = generation) => store.observeRestoreContext({ supported: true, generation: value }, (await store.restoreCheckpoint()).revision);

test("learning support in the original lineage preserves queued work and cached discussions", async () => {
	await store.enqueue(command(), 1);
	await store.cacheRemoteRead(scope, 0, [{ id: "message:a", revision: 1, value: "visible" }]);
	expect(await store.observeRestoreContext({ supported: true, generation: null }, 0)).toEqual({ checkpoint: { revision: 1, context: { supported: true, generation: null } }, changed: false });
	expect((await store.getOperation(id(4)))?.state).toBe("queued");
	expect((await store.entity(scope, "message:a"))?.value).toBe("visible");
	expect((await store.claimNext("owner", 2))?.operationId).toBe(id(4));
});

test("restore preserves local drafts, original pictures and exports while fencing in-flight acceptance", async () => {
	const picture = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1 as const, blocks: [...bodyFromText("Keep this").blocks, { type: "picture" as const, picture_id: picture.id, alt: "Original" }] };
	const draft = { id: "local", scopeId: scope, revision: 0, body: protocolJson(editableCommentDraft(body, () => "Member")) };
	await store.saveDraft(draft, null, [picture]);
	const operation = { ...command(), payload: { ...(command().payload as object), body: protocolJson(body) } };
	await store.enqueue(operation, 1);
	const claimed = (await store.claimNext("owner", 2))!;
	const capture = await store.captureLocalWork(id(30), 3);
	await restore();
	await store.accept(claimed.operationId, { accepted: true });
	await store.fail(claimed.operationId, claimed.lease!, "late_timeout", 10);
	expect(await store.getDraft("local")).toEqual(draft);
	expect(await store.pictureSource(id(20), scope)).toEqual(picture);
	expect(await store.localWorkSnapshot(id(30))).toEqual(capture);
	for (const key of [id(4), id(20)]) expect(await store.getOperation(key)).toMatchObject({ state: "rejected", error: "restore_generation_changed" });
	expect((await store.getOperation(claimed.operationId))?.lease).toBeUndefined();
	expect(await store.claimNext("another", 200_000)).toBeUndefined();
	expect(await store.nextWakeAt()).toBeUndefined();
	await expect(store.retryRejected(claimed.operationId, scope, claimed.attempt)).rejects.toMatchObject({ code: "restore_generation_changed" });
});

test("new sends must explicitly retain the current lineage and cannot restamp an old identity", async () => {
	await store.enqueue(command(), 1); await restore();
	await expect(store.enqueue(command(5), 2)).rejects.toMatchObject({ code: "restore_generation_changed" });
	await expect(store.enqueue({ ...command(), restoreGeneration: generation }, 2)).rejects.toThrow("already used");
	const fresh = { ...command(5), restoreGeneration: generation };
	const queued = await store.enqueue(fresh, 2);
	expect(await store.enqueue(fresh, 3)).toEqual(queued);
	expect((await store.claimNext("owner", 4))?.restoreGeneration).toBe(generation);
	await store.accept(fresh.operationId, { accepted: true });
	expect((await store.getOperation(fresh.operationId))?.state).toBe("accepted");
	expect((await store.getOperation(id(4)))?.restoreGeneration).toBeUndefined();
});

test("accepted pre-restore dependencies cannot authorize a new request", async () => {
	await store.enqueue(command(), 1); await store.accept(id(4), { accepted: true }); await restore();
	await expect(store.enqueue({ ...command(5), dependsOn: [id(4)], restoreGeneration: generation }, 2)).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect(await store.getOperation(id(5))).toBeUndefined();
	expect((await store.getOperation(id(4)))?.state).toBe("accepted");
});

test("picture upload dependencies inherit the parent's immutable lineage", async () => {
	await restore();
	const picture = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1 as const, blocks: [{ type: "picture" as const, picture_id: picture.id, alt: "Original" }] };
	await store.saveDraft({ id: "local", scopeId: scope, revision: 0, body: protocolJson(editableCommentDraft(body, () => "Member")) }, null, [picture]);
	await store.enqueue({ ...command(), restoreGeneration: generation, payload: { ...(command().payload as object), body: protocolJson(body) } }, 1);
	expect(await store.getOperation(id(20))).toMatchObject({ type: "picture.upload", restoreGeneration: generation });
	await restore(id(91));
	expect((await store.getOperation(id(20)))?.restoreGeneration).toBe(generation);
	expect(await store.pictureSource(id(20), scope)).toEqual(picture);
});

test("scope generation fallback fences reads of scopes that have never been cached", async () => {
	const unseen = id(40), before = await store.checkpoint(unseen);
	await store.clearRemoteScope(scope);
	const permission = await store.beginPreferenceVerification(unseen, "baseContext:" + unseen, id(50));
	await store.cacheRemoteRead(scope, 1, [{ id: "message:a", revision: 1, value: "old" }]);
	await restore();
	expect((await store.checkpoint(unseen)).generation).toBe(1);
	expect((await store.checkpoint(scope)).generation).toBe(2);
	expect(await store.cacheRemoteRead(unseen, before.generation, [{ id: "message:a", revision: 1, value: "late" }])).toBe(false);
	expect(await store.applyRemoteBatch(unseen, undefined, "late-cursor", [], [], before.generation)).toBe(false);
	expect(await store.finishPreferenceVerification(unseen, "baseContext:" + unseen, permission, { stale: true })).toBe(false);
	expect(await store.clearRemoteScope(unseen, before)).toBe(false);
	expect(await store.entity(scope, "message:a")).toBeUndefined();
	await restore(id(91));
	expect((await store.checkpoint(unseen)).generation).toBe(2);
	expect((await store.checkpoint(scope)).generation).toBe(3);
	expect(await store.cacheRemoteRead(unseen, 2, [{ id: "message:a", revision: 1, value: "new" }])).toBe(true);
});

test("downloaded pictures are cleared and late downloads cannot repopulate a restored cache", async () => {
	const picture = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
	const rendition = { sha256: picture.sha256, size: picture.size, mime: "image/png" as const, width: 1, height: 1 };
	expect(await store.cachePicture(scope, id(20), "content", rendition, picture.bytes, 0)).toBe(true);
	await restore();
	expect(await store.cachedPicture(scope, id(20), "content")).toBeUndefined();
	expect(await store.preference("pictureCacheBytes")).toBe(0);
	expect(await store.cachePicture(id(40), id(20), "content", rendition, picture.bytes, 0)).toBe(false);
	expect(await store.cachePicture(id(40), id(20), "content", rendition, picture.bytes, 1, 0)).toBe(false);
	expect(await store.cachePicture(id(40), id(20), "content", rendition, picture.bytes, 1, 1)).toBe(true);
});

test("another window's restore prevents an older capability response from rewriting context", async () => {
	const other = await DiscussionStore.open(identity, factory);
	try {
		const before = await other.restoreCheckpoint(); await restore();
		await expect(other.observeRestoreContext({ supported: true, generation: id(91) }, before.revision)).rejects.toMatchObject({ code: "action_context_changed" });
		await expect(other.enqueue(command())).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(await other.restoreCheckpoint()).toEqual(await store.restoreCheckpoint());
	} finally { other.close(); }
});

test.each([undefined, { supported: false, generation }, { supported: true, generation: null }])("a learned nonnull lineage cannot downgrade to %j", async context => {
	await restore(); const before = await store.restoreCheckpoint();
	await expect(store.observeRestoreContext(context, before.revision)).rejects.toMatchObject({ code: "restore_guard_unavailable" });
	expect(await store.restoreCheckpoint()).toEqual(before);
});

test("a context change during the transaction rolls back quarantine and cache invalidation", async () => {
	await store.enqueue(command(), 1); await store.cacheRemoteRead(scope, 0, [{ id: "message:a", revision: 1, value: "old" }]);
	let checks = 0;
	await expect(store.observeRestoreContext({ supported: true, generation }, 0, () => ++checks === 1)).rejects.toMatchObject({ code: "action_context_changed" });
	expect((await store.getOperation(id(4)))?.state).toBe("queued");
	expect((await store.entity(scope, "message:a"))?.value).toBe("old");
	expect((await store.restoreCheckpoint()).revision).toBe(0);
	expect((await store.checkpoint(id(40))).generation).toBe(0);
});

test("online draft completion and retry preserve unconfirmed work across restore", async () => {
	const draft = { id: "online", scopeId: scope, revision: 0, body: "Saved reopen reply" };
	await store.saveDraft(draft);
	const operation = { operationId: id(4), scopeId: scope, payload: { type: "reply.create", reopen: true } };
	await store.prepareOnlineDraft(draft.id, 0, operation); await restore();
	await expect(store.completeOnlineDraft(draft.id, 0, id(4))).rejects.toMatchObject({ code: "restore_generation_changed" });
	await expect(store.prepareOnlineDraft(draft.id, 0, { ...operation, restoreGeneration: generation })).rejects.toMatchObject({ code: "restore_generation_changed" });
	await expect(store.withdrawOnlineDraft(draft.id, 0, operation)).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect(await store.getDraft(draft.id)).toEqual(draft);
	expect(await store.preference("online:" + draft.id)).toEqual({ operation, revision: 0 });
});

test("a late withdrawal response cannot relabel old work as safe to resend", async () => {
	const operation = await store.enqueue(command(), 1);
	await restore();
	const body = protocolJson(editableCommentDraft(bodyFromText("Saved work"), () => "Member"));
	await expect(store.restoreCommandForReview(operation, body)).rejects.toMatchObject({ code: "restore_generation_changed" });
	expect(await store.getDraft("recovery:" + operation.operationId)).toBeUndefined();
	expect(await store.getOperation(operation.operationId)).toMatchObject({ state: "rejected", error: "restore_generation_changed", payload: operation.payload });
});

test("inbox pending choices are preserved for review and old leases lose their epoch", async () => {
	await store.updateInbox(state => {
		state.lease = { token: id(40), expiresAt: 1000 };
		state.operations.push({ id: id(41), scopeId: scope, threadId: id(10), state: "queued", attempted: true,
			change: { type: "subscription", expected_version: 1, following: true, muted: false } });
	});
	const before = await store.inboxState();
	await store.setPreference("baseRecords:" + scope, [id(10)]);
	await store.setPreference("timelineMarkerCommand:" + scope, { unconfirmed: true });
	await restore(); const after = await store.inboxState();
	expect(after.epoch).toBe(before.epoch + 1); expect(after.lease).toBeUndefined();
	expect(after.operations).toEqual([{ ...before.operations[0], state: "rejected", error: "restore_generation_changed" }]);
	expect(await store.preference("baseRecords:" + scope)).toBeUndefined();
	expect(await store.preference("timelineMarkerCommand:" + scope)).toEqual({ unconfirmed: true });
});

test("lineage and quarantine survive reopen and stay isolated to their account", async () => {
	await store.enqueue(command(), 1); await restore(); store.close();
	store = await DiscussionStore.open(identity, factory);
	expect((await store.restoreCheckpoint()).context.generation).toBe(generation);
	expect(await store.claimNext("owner", 10)).toBeUndefined();
	const other = await DiscussionStore.open({ ...identity, accountId: id(99) }, factory);
	try { expect((await other.restoreCheckpoint()).context.generation).toBeNull(); } finally { other.close(); }
});
