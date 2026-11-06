import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSync, messageKey, threadKey, type DiscussionReader } from "../../src/collaboration/DiscussionSync";
import { bodyFromText, type ChangesPage, type MessageRead } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "test" };
const entry = id(3), thread = id(4), message = id(5);
const read = (sequence = 1, text = "First"): MessageRead => ({
	thread: { id: thread, author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: sequence, created_at: "2026-11-05T00:00:00Z" },
	anchor: { type: "note", version: 1 }, message: { id: message, author_id: id(1), revision: 1, deleted: false,
		body: bodyFromText(text), created_sequence: 1, created_at: "2026-11-05T00:00:00Z", edited_at: null, reactions: [] },
});
function changes(sequence = 1, kind = "thread.create"): ChangesPage {
	const hasMessage = !["thread.state", "thread.remove"].includes(kind);
	return { cursor: "cursor" + sequence, has_more: false, events: [{ sequence, kind, data: {
		sequence, operation_id: id(sequence + 100), scope_id: id(6), thread_id: thread, actor_id: id(1), state: "open",
		state_revision: 1, removed: kind === "thread.remove", changed: true,
		...(hasMessage ? { message_id: message, message_revision: 1, message_deleted: false } : {}),
	} }] };
}
function reader() {
	const value = read();
	return { identity, changes: jest.fn().mockResolvedValue(changes()), message: jest.fn().mockResolvedValue(value),
		state: jest.fn().mockResolvedValue({ thread: value.thread, anchor: value.anchor }) };
}
async function setup(remote: DiscussionReader = reader()) {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const worker = new DiscussionSync(store, remote, entry);
	return { store, worker, close: async () => { worker.stop(); await worker.settled(); store.close(); } };
}

test("replays into an atomic cache/checkpoint and refreshes reactions without an edit revision", async () => {
	const remote = reader(), { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await worker.settled();
		expect(worker.status).toBe("current"); expect(await store.cursor(entry)).toBe("cursor1");
		expect((await store.entity(entry, messageKey(thread, message)))?.value).toMatchObject({ body: bodyFromText("First"), thread_id: thread });
		const updated = read(2); updated.message.reactions = [{ emoji: "heart", count: 1, mine: true }];
		remote.message.mockResolvedValue(updated); remote.changes.mockResolvedValue(changes(2, "reaction.set"));
		worker.wake(); await worker.settled();
		expect(remote.changes).toHaveBeenLastCalledWith(entry, "cursor1");
		expect(await store.entity(entry, messageKey(thread, message))).toMatchObject({ revision: 2, value: { revision: 1, reactions: updated.message.reactions } });
	} finally { await close(); }
});

test("collapses repeated message events and never infers deletion from an empty changes page", async () => {
	const remote = reader(), page = changes(2, "message.edit"); page.events.unshift(...changes().events);
	remote.changes.mockResolvedValue(page); remote.message.mockResolvedValue(read(2));
	const { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await worker.settled(); expect(remote.message).toHaveBeenCalledTimes(1);
		remote.changes.mockResolvedValue({ cursor: "empty", events: [], has_more: false });
		worker.wake(); await worker.settled();
		expect(await store.entity(entry, threadKey(thread))).toBeDefined();
	} finally { await close(); }
});

test("removal erases cached messages atomically and retains locally authored recovery text", async () => {
	const remote = reader(), { store, worker, close } = await setup(remote);
	try {
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 1, body: "Keep me" });
		worker.resume(); await worker.settled();
		remote.changes.mockResolvedValue(changes(2, "thread.remove"));
		worker.wake(); await worker.settled();
		expect(await store.entity(entry, messageKey(thread, message))).toBeUndefined();
		expect((await store.entity(entry, threadKey(thread)))?.value).toEqual({ id: thread, removed: true });
		expect((await store.getDraft("draft"))?.body).toBe("Keep me");
		expect(remote.message).toHaveBeenCalledTimes(1);
	} finally { await close(); }
});

test("authorization loss on changes clears remote data but keeps drafts", async () => {
	const remote = reader(), { store, worker, close } = await setup(remote);
	try {
		await store.saveDraft({ id: "draft", scopeId: entry, revision: 1, body: "Keep me" });
		worker.resume(); await worker.settled();
		remote.changes.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
		worker.wake(); await worker.settled();
		expect(worker.status).toBe("unavailable"); expect(await store.entities(entry, "")).toEqual([]);
		expect(await store.cursor(entry)).toBeUndefined(); expect(await store.getDraft("draft")).toBeDefined();
	} finally { await close(); }
});

test("cursor reset clears old generations and replays current data without discarding local drafts", async () => {
	const remote = reader(), { store, worker, close } = await setup(remote);
	try {
		await store.applyRemoteBatch(entry, undefined, "old", [{ id: "thread:obsolete", revision: 999, value: "old generation" }]);
		remote.changes.mockRejectedValueOnce(new DiscussionFailure("reject", "snapshot_required", 409));
		worker.resume(); await worker.settled();
		expect(remote.changes.mock.calls).toEqual([[entry, "old"], [entry, undefined]]);
		expect(await store.entity(entry, "thread:obsolete")).toBeUndefined();
		expect(await store.checkpoint(entry)).toEqual({ cursor: "cursor1", generation: 1 });
	} finally { await close(); }
});

test("stop during an HTTP read cannot populate a closed account's cache", async () => {
	const remote = reader(); let release!: (value: MessageRead) => void;
	const reached = new Promise<void>(resolve => remote.message.mockImplementation(() => {
		resolve(); return new Promise<MessageRead>(r => { release = r; });
	}));
	const { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await reached; worker.stop(); release(read()); await worker.settled();
		expect(await store.cursor(entry)).toBeUndefined(); expect(await store.entities(entry, "")).toEqual([]);
	} finally { await close(); }
});

test("a missing thread is distinguished from revocation before committing the event page", async () => {
	const remote = reader(); remote.message.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
	remote.state.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
	const { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await worker.settled();
		expect(worker.status).toBe("unavailable"); expect(await store.cursor(entry)).toBeUndefined();
	} finally { await close(); }
});

test("removal during hydration purges even a newer cached revision using authorized tombstone metadata", async () => {
	const remote = reader(); remote.message.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", 404));
	remote.state.mockResolvedValue({ thread: { ...read(10).thread, removed: true } });
	const { store, worker, close } = await setup(remote);
	try {
		await store.applyRemoteBatch(entry, undefined, "old", [
			{ id: threadKey(thread), revision: 9, value: { id: thread, removed: false } },
			{ id: messageKey(thread, message), revision: 9, value: "Old private body" },
		]);
		worker.resume(); await worker.settled();
		expect(worker.status).toBe("current");
		expect(await store.entity(entry, messageKey(thread, message))).toBeUndefined();
		expect(await store.entity(entry, threadKey(thread))).toMatchObject({ revision: 10, value: { removed: true } });
	} finally { await close(); }
});

test("failed hydration does not acknowledge a page, and manual wake cannot bypass backoff", async () => {
	const remote = reader(); remote.message.mockRejectedValue(new DiscussionFailure("retry", "server_unavailable", 429, 60_000));
	const { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await worker.settled();
		expect(worker.status).toBe("offline"); expect(await store.cursor(entry)).toBeUndefined();
		worker.wake(); await worker.settled(); expect(remote.message).toHaveBeenCalledTimes(1);
	} finally { await close(); }
});

test("read older than its event fails closed without advancing or endlessly retrying", async () => {
	const remote = reader(); remote.changes.mockResolvedValue(changes(2));
	const { store, worker, close } = await setup(remote);
	try {
		worker.resume(); await worker.settled();
		expect(worker.status).toBe("protocol_error"); expect(await store.cursor(entry)).toBeUndefined();
		worker.wake(); await worker.settled(); expect(remote.changes).toHaveBeenCalledTimes(1);
	} finally { await close(); }
});

test("cache invalidation fences a response even when both old and new cursors are empty", async () => {
	const factory = new IDBFactory(), one = await DiscussionStore.open(identity, factory), two = await DiscussionStore.open(identity, factory);
	try {
		const before = await one.checkpoint(entry);
		await two.clearRemoteScope(entry);
		expect(await one.applyRemoteBatch(entry, before.cursor, "late", [{ id: "secret", revision: 1, value: "private" }], [], before.generation)).toBe(false);
		expect(await one.entity(entry, "secret")).toBeUndefined();
		const current = await two.checkpoint(entry);
		await two.applyRemoteBatch(entry, undefined, "fresh", [], [], current.generation);
		expect(await one.clearRemoteScope(entry, before)).toBe(false);
		expect(await two.cursor(entry)).toBe("fresh");
	} finally { one.close(); two.close(); }
});
