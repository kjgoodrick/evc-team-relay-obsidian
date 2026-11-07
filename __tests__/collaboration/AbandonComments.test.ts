import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "abandon" };
const body = bodyFromText("Original text"), initial = protocolJson(editableCommentDraft(body, () => "Member"));
const command = (n: number, dependsOn: string[] = []): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: dependsOn.length ? "reply.create" : "thread.create", dependsOn,
	payload: { type: dependsOn.length ? "reply.create" : "thread.create", thread_id: id(5), message_id: id(n + 100), body: protocolJson(body), ...(dependsOn.length ? {} : { anchor: { version: 1, type: "note" } }) } });
async function fixture() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory), root = await store.enqueue(command(10), 1);
	const child = await store.enqueue(command(11, [root.operationId]), 2), grandchild = await store.enqueue(command(12, [child.operationId]), 3);
	return { factory, store, root, child, grandchild };
}

test("only server-fenced work can be reviewed; explicit discard atomically retires every unsent dependent", async () => {
	const f = await fixture();
	try {
		await expect(f.store.reviewAbandonment(f.root.operationId)).rejects.toThrow("Check delivery");
		const root = await f.store.restoreCommandForReview(f.root, initial), child = await f.store.restoreCommandForReview(f.child, initial);
		const revised = { ...root, revision: 1, body: protocolJson(editableCommentDraft(bodyFromText("Reviewed correction"), () => "Member")) };
		await f.store.saveDraft(revised, 0);
		const review = await f.store.reviewAbandonment(f.root.operationId);
		expect(review.operations).toHaveLength(3); expect(review.drafts).toEqual([revised, child]);
		await f.store.abandonReviewedWork(review);
		for (const operation of [f.root, f.child, f.grandchild]) expect(await f.store.getOperation(operation.operationId)).toMatchObject({ state: "withdrawn", payload: operation.payload });
		expect(await f.store.getDraft(root.id)).toBeUndefined(); expect(await f.store.getDraft(child.id)).toBeUndefined();
		expect(await f.store.preference("recovery:" + root.id)).toBeUndefined();
		expect(await f.store.claimNext("worker", 10)).toBeUndefined();
		await f.store.accept(f.root.operationId, { late: true }); expect((await f.store.getOperation(f.root.operationId))?.state).toBe("withdrawn");
		await expect(f.store.saveDraft({ ...revised, revision: 2 }, 1)).rejects.toThrow("Draft changed");
	} finally { f.store.close(); }
});

test.each(["draft", "dependent", "replacement"])("a competing %s change invalidates the entire review", async change => {
	const f = await fixture(), other = await DiscussionStore.open(identity, f.factory);
	try {
		const draft = await f.store.restoreCommandForReview(f.root, initial), review = await f.store.reviewAbandonment(f.root.operationId);
		if (change === "draft") await other.saveDraft({ ...draft, revision: 1, body: protocolJson(editableCommentDraft(bodyFromText("Newer text"), () => "Member")) }, 0);
		else if (change === "dependent") await other.enqueue(command(13, [f.grandchild.operationId]), 4);
		else await other.enqueue({ ...command(10), operationId: id(14) }, 4, draft);
		await expect(f.store.abandonReviewedWork(review)).rejects.toThrow();
		expect((await other.getOperation(f.child.operationId))?.state).toBe("queued"); expect((await other.getOperation(f.grandchild.operationId))?.state).toBe("queued");
		if (change !== "replacement") expect(await other.getDraft(draft.id)).toBeDefined();
		else expect((await other.getOperation(id(14)))?.state).toBe("queued");
	} finally { other.close(); f.store.close(); }
});

test("an uncertain predecessor outside the dependent group and its posted parent stay unchanged", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const root = await store.enqueue(command(10), 1); await store.accept(root.operationId, { accepted: true });
		const child = await store.enqueue(command(11, [root.operationId]), 2); const flight = (await store.claimNext("worker", 3))!;
		await store.fail(child.operationId, flight.lease!, "retry", 4);
		const draft = await store.restoreCommandForReview(await store.enqueue(command(12), 4), initial);
		// Another saved change can depend on both a reviewed root and an uncertain
		// command. Its predecessor must not be discarded as part of this review.
		await store.enqueue(command(13, [id(12), child.operationId]), 5);
		const review = await store.reviewAbandonment(id(12));
		expect(review.operations.map(op => op.operationId)).toEqual([id(12), id(13)]);
		await store.abandonReviewedWork(review);
		expect((await store.getOperation(child.operationId))?.state).toBe("queued");
		expect((await store.getOperation(root.operationId))?.state).toBe("accepted"); expect(await store.getDraft(draft.id)).toBeUndefined();
		await expect(store.reviewAbandonment(child.operationId)).rejects.toThrow("Check delivery");
	} finally { store.close(); }
});

test("an attempted dependent from another worker requires its own delivery review", async () => {
	const f = await fixture();
	try {
		await f.store.restoreCommandForReview(f.root, initial);
		// Simulate retained state from an older worker. The discard must prove
		// safety from durable state, not assume a dependency was never attempted.
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = f.factory.open("team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]));
			request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction("outbox", "readwrite"); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
				tx.objectStore("outbox").put({ ...f.child, attempt: 1, state: "queued" });
			});
		} finally { db.close(); }
		await expect(f.store.reviewAbandonment(f.root.operationId)).rejects.toThrow("own delivery review");
		expect((await f.store.getOperation(f.root.operationId))?.state).toBe("review"); expect((await f.store.getOperation(f.child.operationId))?.attempt).toBe(1);
	} finally { f.store.close(); }
});

test.each([false, true])("discard releases unused pictures but preserves other draft/export ownership (shared draft %s)", async shared => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const source = await prepareLocalPicture(id(20), scope, new Uint8Array([1, 2, 3]).buffer);
		const rich = { version: 1 as const, blocks: [...body.blocks, { type: "picture" as const, picture_id: source.id }] }, content = protocolJson(editableCommentDraft(rich, () => "Member"));
		await store.saveDraft({ id: "picture", scopeId: scope, revision: 0, body: content }, null, [source]);
		if (shared) await store.saveDraft({ id: "other", scopeId: scope, revision: 0, body: content }, null);
		const original = await store.enqueue({ ...command(10), payload: { ...(command(10).payload as object), body: protocolJson(rich) } }, 1, { id: "picture", revision: 0 });
		await store.restoreCommandForReview(original, content); await store.captureLocalWork(id(30));
		await store.abandonReviewedWork(await store.reviewAbandonment(original.operationId));
		expect(await store.pictureSource(source.id, scope)).toBeDefined(); expect(await store.preference("pictureSourceBytes")).toBe(3);
		expect((await store.getOperation(source.id))?.state).toBe(shared ? "queued" : "withdrawn");
		await store.releaseLocalWork(id(30));
		expect(await store.preference("pictureSourceBytes")).toBe(shared ? 3 : 0);
		if (shared) expect(await store.getDraft("other")).toBeDefined();
	} finally { store.close(); }
});

test("account/window loss rolls back even after mutations began", async () => {
	const f = await fixture();
	try {
		const draft = await f.store.restoreCommandForReview(f.root, initial), review = await f.store.reviewAbandonment(f.root.operationId);
		let checks = 0;
		await expect(f.store.abandonReviewedWork(review, () => ++checks === 1)).rejects.toThrow("Nothing was discarded");
		expect(await f.store.getDraft(draft.id)).toEqual(draft); expect((await f.store.getOperation(f.root.operationId))?.state).toBe("review");
		expect((await f.store.getOperation(f.child.operationId))?.state).toBe("queued");
	} finally { f.store.close(); }
});
