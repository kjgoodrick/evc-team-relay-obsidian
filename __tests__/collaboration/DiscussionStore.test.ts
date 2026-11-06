import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
Object.assign(globalThis, { IDBKeyRange });
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

const identity = { serverId: "server", accountId: "alice", vaultId: "vault", shareId: "share" };
function command(operationId: string, dependsOn: string[] = []): QueuedCommand {
	return { operationId, scopeId: "note", type: "reply.create", payload: { message: operationId }, dependsOn };
}

test("drafts and queued operations survive close/reopen, without crossing account/server boundaries", async () => {
	const db = new IDBFactory(), store = await DiscussionStore.open(identity, db);
	await store.saveDraft({ id: "draft", scopeId: "note", revision: 0, body: "offline text" });
	await store.enqueue(command("send"), 1); store.close();
	const reopened = await DiscussionStore.open(identity, db);
	const other = await DiscussionStore.open({ ...identity, accountId: "bob" }, db);
	const otherServer = await DiscussionStore.open({ ...identity, serverId: "elsewhere" }, db);
	try {
		expect((await reopened.getDraft("draft"))?.body).toBe("offline text");
		expect((await reopened.getOperation("send"))?.state).toBe("queued");
		expect(await other.getDraft("draft")).toBeUndefined();
		expect(await otherServer.getOperation("send")).toBeUndefined();
	} finally { reopened.close(); other.close(); otherServer.close(); }
});

test("same operation ID retries once; conflicting reuse and offline moderation are rejected", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		const first = await store.enqueue(command("send"), 1);
		expect(await store.enqueue(command("send"), 2)).toEqual(first);
		await expect(store.enqueue({ ...command("send"), payload: "changed" })).rejects.toThrow("already used");
		await expect(store.enqueue({ ...command("resolve"), type: "thread.resolve" } as unknown as QueuedCommand)).rejects.toThrow("Invalid queued");
		await expect(store.enqueue(command("dependent", ["missing"]))).rejects.toThrow("dependency");
	} finally { store.close(); }
});

test("dependent replies wait; concurrent workers claim once; expired lease retains the operation ID", async () => {
	const db = new IDBFactory(), first = await DiscussionStore.open(identity, db), second = await DiscussionStore.open(identity, db);
	try {
		await first.enqueue(command("parent"), 1); await first.enqueue(command("reply", ["parent"]), 2);
		const claims = await Promise.all([first.claimNext("one", 3, 10), second.claimNext("two", 3, 10)]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(claims.find(Boolean)?.operationId).toBe("parent");
		const recovered = await second.claimNext("two", 14, 10);
		expect(recovered?.operationId).toBe("parent"); expect(recovered?.attempt).toBe(2);
		await first.fail("parent", claims.find(Boolean)!.lease!, "old timeout", 20);
		expect((await first.getOperation("parent"))?.state).toBe("sending");
		await first.accept("parent", { accepted: true });
		expect((await second.claimNext("two", 15))?.operationId).toBe("reply");
		await second.fail("parent", recovered!.lease!, "late timeout");
		expect((await first.getOperation("parent"))?.state).toBe("accepted");
	} finally { first.close(); second.close(); }
});

test("permanent denial keeps draft/body and blocks dependent work without blocking unrelated replies", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		await store.enqueue(command("denied"), 1); await store.enqueue(command("child", ["denied"]), 2);
		await store.enqueue(command("other"), 3);
		const op = await store.claimNext("worker", 4);
		await store.fail(op!.operationId, op!.lease!, "permission revoked");
		expect((await store.getOperation("denied"))?.payload).toEqual({ message: "denied" });
		expect((await store.claimNext("worker", 5))?.operationId).toBe("other");
	} finally { store.close(); }
});

test("manual retries retain immutable IDs and dependencies and cannot revive an accepted or newer attempt", async () => {
	const db = new IDBFactory(), first = await DiscussionStore.open(identity, db), second = await DiscussionStore.open(identity, db);
	try {
		await first.enqueue(command("parent"), 1); await first.enqueue(command("child", ["parent"]), 2);
		const denied = (await first.claimNext("worker", 3))!;
		await first.fail("parent", denied.lease!, "comment_forbidden");
		expect(await second.retryRejected("parent", "different-note", denied.attempt, 4)).toBe(false);
		const retries = await Promise.all([first.retryRejected("parent", "note", denied.attempt, 4), second.retryRejected("parent", "note", denied.attempt, 4)]);
		expect(retries.filter(Boolean)).toHaveLength(1);
		const retried = (await first.claimNext("worker", 4))!;
		expect(retried).toMatchObject({ ...command("parent"), attempt: 2 });
		await first.fail("parent", retried.lease!, "comment_forbidden");
		expect(await second.retryRejected("parent", "note", denied.attempt, 5)).toBe(false);
		await first.accept("parent", { accepted: true });
		expect(await second.retryRejected("parent", "note", retried.attempt, 6)).toBe(false);
		expect((await first.claimNext("worker", 6))?.operationId).toBe("child");
	} finally { first.close(); second.close(); }
});

test("events persist entities, receipt and checkpoint atomically, reject rewind and roll back invalid batches", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		await store.enqueue(command("send"), 1);
		expect(await store.applyRemoteBatch("note", undefined, "c1", [{ id: "message", revision: 2, value: "new" }], [{ operationId: "send", result: "ok" }])).toBe(true);
		expect((await store.getOperation("send"))?.state).toBe("accepted");
		expect(await store.applyRemoteBatch("note", undefined, "old", [{ id: "message", revision: 1, value: "old" }])).toBe(false);
		expect(await store.applyRemoteBatch("note", "c1", "c2", [{ id: "message", revision: 1, value: "old" }])).toBe(true);
		expect((await store.entity("note", "message"))?.value).toBe("new");
		await store.enqueue({ ...command("foreign"), scopeId: "private" });
		await expect(store.applyRemoteBatch("note", "c2", "c3", [{ id: "message", revision: 3, value: "uncommitted" }], [{ operationId: "foreign", result: "wrong" }])).rejects.toThrow("Cross-scope");
		expect(await store.cursor("note")).toBe("c2");
		expect((await store.entity("note", "message"))?.value).toBe("new");
	} finally { store.close(); }
});

test("older panes cannot overwrite a newer draft and invalid payloads are not silently saved", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		await store.saveDraft({ id: "draft", scopeId: "note", revision: 2, body: "newer" });
		await expect(store.saveDraft({ id: "draft", scopeId: "note", revision: 1, body: "older" })).rejects.toThrow("another view");
		await expect(store.enqueue({ ...command("bad"), payload: { n: NaN } })).rejects.toThrow("JSON");
		expect(await store.getOperation("bad")).toBeUndefined();
	} finally { store.close(); }
});

test("version-1 upgrade preserves drafts/outbox and adds scope cleanup without touching other accounts", async () => {
	const factory = new IDBFactory();
	const name = "team-relay-discussions:" + JSON.stringify([identity.serverId, identity.accountId, identity.vaultId, identity.shareId]);
	await new Promise<void>((resolve, reject) => {
		const opening = factory.open(name, 1);
		opening.onupgradeneeded = () => {
			const db = opening.result;
			db.createObjectStore("drafts", { keyPath: "id" }).add({ id: "old", scopeId: "note", revision: 0, body: "saved text" });
			const outbox = db.createObjectStore("outbox", { keyPath: "operationId" });
			outbox.createIndex("state", "state"); outbox.createIndex("scope", "scopeId");
			db.createObjectStore("entities", { keyPath: ["scopeId", "id"] }).add({ scopeId: "note", id: "message", revision: 1, value: "remote" });
			db.createObjectStore("cursors").put("old-cursor", "note");
		};
		opening.onsuccess = () => { opening.result.close(); resolve(); }; opening.onerror = () => reject(opening.error);
	});
	const store = await DiscussionStore.open(identity, factory);
	const other = await DiscussionStore.open({ ...identity, accountId: "other" }, factory);
	try {
		expect((await store.getDraft("old"))?.body).toBe("saved text");
		await store.clearRemoteScope("note"); expect(await store.entity("note", "message")).toBeUndefined();
		await other.saveDraft({ id: "other", scopeId: "note", revision: 0, body: "other text" });
		await store.enqueue(command("pending")); await store.clearAll();
		expect(await store.getDraft("old")).toBeUndefined(); expect(await store.getOperation("pending")).toBeUndefined();
		expect((await other.getDraft("other"))?.body).toBe("other text");
	} finally { store.close(); other.close(); }
});

test("selection drafts page within a note, preserve targets, and survive reopening the store", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	const target = { version: 1, type: "text", generation: "original" };
	await store.saveDraft({ id: "selection:note:a", scopeId: "note", revision: 0, body: "Alpha", target });
	await store.saveDraft({ id: "selection:note:b", scopeId: "note", revision: 0, body: "Beta", target });
	await store.saveDraft({ id: "selection:other:a", scopeId: "other", revision: 0, body: "Other", target });
	store.close(); store = await DiscussionStore.open(identity, factory);
	try {
		const page = await store.selectionDrafts("note", undefined, 1);
		expect(page.drafts.map(d => d.body)).toEqual(["Alpha"]); expect(page.hasMore).toBe(true);
		expect((await store.selectionDrafts("note", page.drafts[0].id, 1)).drafts.map(d => d.body)).toEqual(["Beta"]);
		await expect(store.saveDraft({ ...page.drafts[0], revision: 1, target: { ...target, generation: "replacement" } }, 0)).rejects.toThrow("Draft target changed");
		expect((await store.getDraft("selection:note:a"))?.target).toEqual(target);
	} finally { store.close(); }
});
