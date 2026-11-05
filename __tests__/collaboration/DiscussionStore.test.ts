import { IDBFactory } from "fake-indexeddb";
import { DiscussionStore, QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

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
