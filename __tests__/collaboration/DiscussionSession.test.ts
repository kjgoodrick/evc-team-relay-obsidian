import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "test" };
const entry = id(3);
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true }),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [{ id: id(1), name: "Alice" }], hasMore: false }),
		changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
		send: jest.fn().mockResolvedValue({ operation_id: id(4), scope_id: id(8), thread_id: id(5), message_id: id(6),
			sequence: 1, state: "open", state_revision: 1, message_revision: 1, message_deleted: false, removed: false, changed: true }),
		sendOnline: jest.fn().mockResolvedValue({ changed: true }),
	};
}
const command = () => ({ operationId: id(4), scopeId: entry, type: "thread.create" as const, dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: { version: 1, type: "note" }, body: bodyFromText("Saved") } });
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	await session.start(); const unwatch = session.watch(entry, () => {}); await session.refresh();
	return { store, transport, session, close: async () => { unwatch(); await session.close(); } };
}

test("queues a comment-only user's draft atomically and does not require note-write access", async () => {
	const { store, session, transport, close } = await fixture();
	try {
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 1, body: "Saved" });
		await session.queue(command(), { id: "draft", revision: 1 }); await session.outbox.settled();
		expect(session.permission(entry)).toMatchObject({ comment: true, edit: false });
		expect(await store.getDraft("draft")).toBeUndefined();
		expect((await store.getOperation(id(4)))?.state).toBe("accepted"); expect(transport.send).toHaveBeenCalledTimes(1);
		expect(session.displayName(entry, id(1))).toBe("Alice");
	} finally { await close(); }
});

test("two windows cannot overwrite or submit a newer draft using stale revisions", async () => {
	const { store, session, close } = await fixture();
	try {
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Original" }, null);
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 1, body: "Other window" }, 0);
		await expect(store.saveDraft({ id: "draft", scopeId: entry, revision: 2, body: "Stale writer" }, 0)).rejects.toThrow("another view");
		await expect(session.queue(command(), { id: "draft", revision: 0 })).rejects.toThrow("another view");
		expect((await store.getDraft("draft"))?.body).toBe("Other window"); expect(await store.getOperation(id(4))).toBeUndefined();
	} finally { await close(); }
});

test("backgrounding stops delivery, foreground refresh resumes, and moderation cannot queue offline", async () => {
	const { store, session, transport, close } = await fixture();
	try {
		session.setForeground(false); await session.outbox.settled();
		await session.queue(command()); expect(transport.send).not.toHaveBeenCalled();
		await expect(session.onlineAction({ operationId: id(10), scopeId: entry, payload: { type: "thread.state" } })).rejects.toThrow("Reconnect");
		expect(await store.pending(entry)).toHaveLength(1);
		session.setForeground(true); await session.refresh(); await session.outbox.settled();
		expect((await store.getOperation(id(4)))?.state).toBe("accepted");
	} finally { await close(); }
});

test("revoked access clears remote content and names while preserving local drafts", async () => {
	const { store, session, transport, close } = await fixture();
	try {
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 0, body: "Private local draft" });
		transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false });
		await session.refresh();
		expect(await store.preference("people:" + entry)).toBeUndefined();
		expect(session.participants(entry)).toEqual([]); expect(session.permission(entry)?.read).toBe(false);
		await expect(session.queue(command())).rejects.toThrow("permission");
		expect(await store.getDraft("draft")).toBeDefined();
	} finally { await close(); }
});

test("manual recovery retries the same command after permission restoration and is disabled offline", async () => {
	const { store, session, transport, close } = await fixture();
	try {
		transport.send.mockRejectedValueOnce(new DiscussionFailure("reject", "comment_forbidden", 403));
		await session.queue(command()); await session.outbox.settled();
		const rejected = (await store.getOperation(id(4)))!; expect(rejected.state).toBe("rejected");
		session.setForeground(false);
		await expect(session.retryRejected(rejected)).rejects.toThrow("Reconnect");
		session.setForeground(true); await session.refresh();
		expect(await session.retryRejected(rejected)).toBe(true); await session.outbox.settled();
		expect(transport.send).toHaveBeenCalledTimes(2);
		expect(transport.send.mock.calls[1][0]).toMatchObject(command());
		expect((await store.getOperation(id(4)))?.state).toBe("accepted");
		expect(await session.retryRejected(rejected)).toBe(false);
	} finally { await close(); }
});

test("previously verified capabilities/permissions support offline drafts, but not an unknown server", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	await store.setPreference("enabled", true); await store.setPreference("permission:" + entry, { read: true, comment: true, edit: false, moderate: false });
	store.close(); store = await DiscussionStore.open(identity, factory);
	const transport = remote(); transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	transport.send.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(entry, () => {}); await session.refresh();
		expect(session.status).toBe("offline"); expect(session.canQueue).toBe(true);
		await session.queue(command()); await session.outbox.settled(); expect((await store.getOperation(id(4)))?.state).toBe("queued");
	} finally { await session.close(); }
});

test("account shutdown waits for queued local saves and ignores a late capability response", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	let release!: (value: { discussions: boolean }) => void;
	transport.capabilities.mockImplementation(() => new Promise(resolve => { release = resolve; }));
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	const starting = session.start();
	while (!release) await new Promise(resolve => setTimeout(resolve, 0));
	let write!: () => void;
	const saved = session.trackLocal(new Promise<void>(resolve => { write = resolve; }).then(() => store.saveDraft({ id: "final", scopeId: entry, revision: 1, body: "Kept" })));
	const closing = session.close(); expect(session.status).toBe("closed");
	write(); release({ discussions: true }); await saved; await starting; await closing;
		expect(transport.send).not.toHaveBeenCalled(); expect(session.canQueue).toBe(false);
});

test("ordered cache pages follow creation sequence instead of random UUID order", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	try {
		await store.applyRemoteBatch(entry, undefined, "page", [
			{ id: "message:" + id(5) + ":" + id(99), revision: 10, value: { created_sequence: 1, text: "First" } },
			{ id: "message:" + id(5) + ":" + id(10), revision: 2, value: { created_sequence: 2, text: "Second" } },
			{ id: "message:" + id(6) + ":" + id(11), revision: 3, value: { created_sequence: 3, text: "Other thread" } },
			{ id: "thread:" + id(7), revision: 999, value: { id: id(7), removed: true } },
		]);
		const first = await store.orderedEntities(entry, "message:" + id(5) + ":", 0, 1);
		expect(first[0].value).toMatchObject({ text: "First" });
		expect((await store.orderedEntities(entry, "message:" + id(5) + ":", 1, 1))[0].value).toMatchObject({ text: "Second" });
		expect(await store.orderedEntities(entry, "thread:", 0)).toEqual([]); // Future deletion sequences cannot jump a live creation cursor.
	} finally { store.close(); }
});

test("an unconfirmed online reply retains its exact operation across restart and never enters the offline queue", async () => {
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory);
	const body = bodyFromText("Reply and reopen");
	await store.saveDraft({ id: "reply", scopeId: entry, revision: 0, body: "Reply and reopen" });
	const operation = { operationId: id(40), scopeId: entry, payload: { type: "reply.create", thread_id: id(5), message_id: id(41),
		body, reopen: true, expected_state_revision: 2 } };
	const first = await store.prepareOnlineDraft("reply", 0, operation);
	expect(await store.pending(entry)).toEqual([]);
	await expect(store.enqueue(command(), Date.now(), { id: "reply", revision: 0 })).rejects.toThrow("unconfirmed");
	store.close(); store = await DiscussionStore.open(identity, factory);
	try {
		expect(await store.prepareOnlineDraft("reply", 0, { ...operation, operationId: id(99) })).toEqual(first);
		await expect(store.saveDraft({ id: "reply", scopeId: entry, revision: 1, body: "Other window's edit" }, 0)).rejects.toThrow("unconfirmed");
		await expect(store.removeDraft("reply", 0)).rejects.toThrow("unconfirmed");
		expect((await store.getDraft("reply"))?.body).toBe("Reply and reopen");
		await expect(store.prepareOnlineDraft("reply", 0, { ...operation, payload: { ...operation.payload, expected_state_revision: 3 } })).rejects.toThrow("unconfirmed");
		await store.completeOnlineDraft("reply", 0, first.operationId);
		expect(await store.getDraft("reply")).toBeUndefined(); expect(await store.preference("online:reply")).toBeUndefined();
	} finally { store.close(); }
});
