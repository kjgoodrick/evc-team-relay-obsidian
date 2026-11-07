import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, protocolJson, type MessageRead, type HistoryPage } from "../../src/collaboration/DiscussionProtocol";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "test" };
const entry = id(3);
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true }),
		anchorContext: jest.fn().mockResolvedValue({ entryId: entry, generation: id(30) }),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [{ id: id(1), name: "Alice" }], hasMore: false }),
		changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
		send: jest.fn().mockResolvedValue({ operation_id: id(4), scope_id: id(8), thread_id: id(5), message_id: id(6),
			sequence: 1, state: "open", state_revision: 1, message_revision: 1, message_deleted: false, removed: false, changed: true }),
		sendOnline: jest.fn().mockResolvedValue({ changed: true }),
		uploadPicture: jest.fn().mockResolvedValue({ state: "verified" }),
		withdraw: jest.fn().mockResolvedValue({ status: "withdrawn" }),
		withdrawOnline: jest.fn().mockResolvedValue({ status: "withdrawn" }),
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

function linkedRead(): MessageRead {
	return { thread: { id: id(5), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1, removed: false,
		created_sequence: 1, activity_sequence: 802, created_at: "2026-11-05T00:00:00Z" }, anchor: { version: 1, type: "note" },
		message: { id: id(6), author_id: id(1), revision: 2, deleted: false, body: bodyFromText("Older reply"), created_sequence: 801,
			created_at: "2026-11-05T00:00:00Z", edited_at: "2026-11-06T00:00:00Z", reactions: [] } };
}
async function linkedFixture() {
	const f = await fixture(), read = linkedRead();
	const transport = Object.assign(f.transport, { message: jest.fn().mockResolvedValue(read),
		thread: jest.fn().mockResolvedValue({ thread: read.thread, anchor: read.anchor, messages: [], has_more: false, next_after: 0 }) });
	return { ...f, transport, read };
}

function historyPage(): HistoryPage {
	return { revisions: [1, 2].map(revision => ({ revision, body: bodyFromText("Revision " + revision), actor_id: id(1),
		created_at: "2026-11-07T00:00:00Z", reason: null })), has_more: false, next_after: 2 };
}
test("history reads only the selected pair, verifies the current target and does not persist revisions", async () => {
	const f = await linkedFixture(), page = historyPage();
	const history = jest.fn().mockResolvedValue(page); Object.assign(f.transport, { history });
	try {
		expect(await f.session.historyWindow(entry, id(5), id(6))).toEqual({ latest: 2, selected: page.revisions[1], previous: page.revisions[0] });
		expect(history).toHaveBeenLastCalledWith(entry, id(5), id(6), 0, 2);
		history.mockResolvedValue({ revisions: [page.revisions[0]], has_more: true, next_after: 1 });
		expect(await f.session.historyWindow(entry, id(5), id(6), 1)).toEqual({ latest: 2, selected: page.revisions[0] });
		expect(history).toHaveBeenLastCalledWith(entry, id(5), id(6), 0, 1);
		expect(await f.store.orderedEntities(entry, "message:", 0, 50)).toEqual([]);
		f.session.setForeground(false);
		await expect(f.session.historyWindow(entry, id(5), id(6))).rejects.toThrow("Reconnect");
		expect(history).toHaveBeenCalledTimes(2);
	} finally { await f.close(); }
});

test.each(["generation", "permission", "close", "removed", "deleted", "newer_message"])("late history cannot expose revisions after %s", async change => {
	const f = await linkedFixture(); let release!: (value: HistoryPage) => void, entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	Object.assign(f.transport, { history: jest.fn().mockImplementation(() => new Promise(resolve => { release = resolve; entered(); })) });
	try {
		const reading = f.session.historyWindow(entry, id(5), id(6)); const rejected = expect(reading).rejects.toThrow(); await waiting;
		let closing: Promise<void> | undefined;
		if (change === "generation") await f.store.clearRemoteScope(entry);
		if (change === "permission") { f.transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false }); await f.session.refresh(); }
		if (change === "close") closing = f.session.close();
		if (["removed", "deleted", "newer_message"].includes(change)) {
			const checkpoint = await f.store.checkpoint(entry);
			await f.store.cacheRemoteRead(entry, checkpoint.generation, [
				{ id: "thread:" + id(5), revision: 900, value: { ...f.read.thread, removed: change === "removed" } },
				{ id: `message:${id(5)}:${id(6)}`, revision: 900, value: { ...f.read.message, author_id: id(9),
					revision: change === "newer_message" ? 3 : 2, deleted: change === "deleted" } },
			]);
		}
		release(historyPage()); await rejected; if (closing) await closing;
	} finally { await f.close(); }
});

test("history rejects missing predecessors and propagates authentication loss without broadening access", async () => {
	const f = await linkedFixture(), history = jest.fn().mockResolvedValue({ revisions: [historyPage().revisions[1]], next_after: 2, has_more: false });
	Object.assign(f.transport, { history });
	try {
		await expect(f.session.historyWindow(entry, id(5), id(6))).rejects.toThrow("unavailable");
		history.mockRejectedValue(new DiscussionFailure("authenticate", "session_revoked", 401));
		await expect(f.session.historyWindow(entry, id(5), id(6))).rejects.toBeInstanceOf(DiscussionFailure);
		expect(f.session.status).toBe("authentication_required");
	} finally { await f.close(); }
});

test("authentication loss stops workers and cannot be undone by older sync/capability replies or an offline refresh", async () => {
	const f = await linkedFixture();
	let finishSync!: (value: { events: never[]; cursor: string; has_more: boolean }) => void, syncEntered!: () => void;
	let finishStart!: (value: { discussions: boolean }) => void, startEntered!: () => void;
	const syncing = new Promise<void>(resolve => { syncEntered = resolve; }), initializing = new Promise<void>(resolve => { startEntered = resolve; });
	f.transport.changes.mockImplementationOnce(() => new Promise(resolve => { finishSync = resolve; syncEntered(); }));
	try {
		await f.session.refresh(); await syncing;
		f.transport.capabilities.mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve; startEntered(); }));
		const starting = f.session.start(); await initializing;
		const failure = new DiscussionFailure("authenticate", "session_revoked", 401);
		f.transport.message.mockRejectedValue(failure);
		await expect(f.session.linkedThread(entry, id(5), id(6))).rejects.toBe(failure);
		finishSync({ events: [], cursor: "late", has_more: false }); finishStart({ discussions: true }); await starting;
		expect(f.session.status).toBe("authentication_required"); expect(f.session.canQueue).toBe(false);
		expect(f.session.syncStatus(entry)).toBe("stopped"); expect(f.session.outbox.status).toBe("stopped");
		f.transport.capabilities.mockRejectedValueOnce(new DiscussionFailure("retry", "offline"));
		await f.session.start(); expect(f.session.status).toBe("authentication_required");
		await f.session.refresh(); expect(f.session.status).toBe("ready"); expect(f.session.canQueue).toBe(true);
	} finally { finishSync?.({ events: [], cursor: "late", has_more: false }); finishStart?.({ discussions: true }); await f.close(); }
});

test("history started before authentication loss stays invalid after successful reauthentication", async () => {
	const f = await linkedFixture(); let finish!: (value: HistoryPage) => void, entered!: () => void;
	const waiting = new Promise<void>(resolve => { entered = resolve; });
	Object.assign(f.transport, { history: jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; entered(); })) });
	try {
		const reading = f.session.historyWindow(entry, id(5), id(6)); const rejected = expect(reading).rejects.toThrow(); await waiting;
		f.transport.message.mockRejectedValueOnce(new DiscussionFailure("authenticate", "session_revoked", 401));
		await expect(f.session.linkedThread(entry, id(5), id(6))).rejects.toBeInstanceOf(DiscussionFailure);
		await f.session.refresh(); expect(f.session.online).toBe(true);
		finish(historyPage()); await rejected;
	} finally { finish?.(historyPage()); await f.close(); }
});

test("direct older-message read works without inbox capability and caches without advancing the event cursor", async () => {
	const f = await linkedFixture();
	try {
		const checkpoint = await f.store.checkpoint(entry);
		expect(await f.session.linkedThread(entry, id(5), id(6))).toEqual({ thread: { ...f.read.thread, anchor: f.read.anchor }, message: f.read.message });
		expect(f.transport.message).toHaveBeenCalledTimes(1); expect(f.transport.thread).not.toHaveBeenCalled();
		expect(await f.store.checkpoint(entry)).toEqual(checkpoint);
		expect((await f.session.messages(entry, id(5), 800)).messages).toEqual([f.read.message]);
		f.session.setForeground(false);
		expect((await f.session.linkedThread(entry, id(5), id(6)))?.message?.id).toBe(id(6));
		expect(f.transport.message).toHaveBeenCalledTimes(1);
	} finally { await f.close(); }
});

test("a missing reply falls back once to its thread and does not revive the old cached message", async () => {
	const f = await linkedFixture();
	try {
		await f.session.linkedThread(entry, id(5), id(6));
		f.transport.message.mockRejectedValue(new DiscussionFailure("reject", "missing", 404));
		expect(await f.session.linkedThread(entry, id(5), id(6))).toEqual({ thread: { ...f.read.thread, anchor: f.read.anchor }, message: undefined });
		expect(f.transport.thread).toHaveBeenCalledTimes(1);
	} finally { await f.close(); }
});

test.each(["generation", "permission", "close"])("late direct reads cannot restore content after %s changes", async change => {
	const f = await linkedFixture(); let release!: (value: MessageRead) => void, entered!: () => void;
	const enteredRead = new Promise<void>(resolve => { entered = resolve; });
	f.transport.message.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
	try {
		const opening = f.session.linkedThread(entry, id(5), id(6)); await enteredRead;
		let closing: Promise<void> | undefined;
		if (change === "generation") await f.store.clearRemoteScope(entry);
		if (change === "permission") { f.transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false }); await f.session.refresh(); }
		if (change === "close") closing = f.session.close();
		release(f.read); expect(await opening).toBeUndefined();
		if (closing) await closing;
		else expect(await f.store.entity(entry, "thread:" + id(5))).toBeUndefined();
	} finally { await f.close(); }
});

test.each([403, 404, 401])("a %s direct read clears remote scope and retains local drafts", async status => {
	const f = await linkedFixture();
	try {
		await f.session.linkedThread(entry, id(5), id(6));
		await f.store.saveDraft({ id: "local", scopeId: entry, revision: 0, body: "Unsent" });
		const failure = new DiscussionFailure(status === 401 ? "authenticate" : "reject", "unavailable", status);
		f.transport.message.mockRejectedValue(failure); f.transport.thread.mockRejectedValue(failure);
		await expect(f.session.linkedThread(entry, id(5), id(6))).rejects.toBe(failure);
		expect(await f.store.entity(entry, "thread:" + id(5))).toBeUndefined();
		expect(await f.store.getDraft("local")).toBeDefined();
		if (status !== 404) expect(f.transport.thread).not.toHaveBeenCalled();
		if (status === 401) expect(f.session.status).toBe("authentication_required");
	} finally { await f.close(); }
});

test("a later message revision from synchronization wins over an older direct read", async () => {
	const f = await linkedFixture();
	try {
		const checkpoint = await f.store.checkpoint(entry), newer = { ...f.read.message, revision: 3, body: bodyFromText("Newer") };
		await f.store.cacheRemoteRead(entry, checkpoint.generation, [{ id: "message:" + id(5) + ":" + id(6), revision: 900, value: protocolJson(newer) }]);
		expect((await f.session.linkedThread(entry, id(5), id(6)))?.message?.body).toEqual(newer.body);
	} finally { await f.close(); }
});

test("search is online and capability gated, rejects late account closure, and drops known revoked scopes", async () => {
	const f = await fixture(), request = { query: "Saved", state: "all" as const, mine: false, mentions: false, cursor: null, limit: 30 };
	const read = linkedRead(), item = { thread: read.thread, entry_id: entry, view_id: null, kind: "note", path: "Note.md", message_id: id(6), message_revision: 2, message_sequence: 801, excerpt: "Saved" };
	const search = jest.fn().mockResolvedValue({ items: [item], next_cursor: null }); Object.assign(f.transport, { search });
	try {
		await expect(f.session.search(request)).rejects.toThrow("server"); expect(search).not.toHaveBeenCalled();
		f.transport.capabilities.mockResolvedValue({ discussions: true, ...{ search: true } }); await f.session.start();
		expect((await f.session.search(request)).items).toHaveLength(1);
		f.session.setForeground(false); await expect(f.session.search(request)).rejects.toThrow("Connect"); f.session.setForeground(true); await f.session.refresh();
		f.transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false }); await f.session.refresh();
		expect((await f.session.search(request)).items).toEqual([]);
		let release!: (value: unknown) => void, entered!: () => void;
		const begun = new Promise<void>(resolve => { entered = resolve; });
		search.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
		const pending = f.session.search(request), rejected = expect(pending).rejects.toThrow("access changed"); await begun;
		const closing = f.session.close(); release({ items: [item], next_cursor: null }); await rejected; await closing;
	} finally { await f.close(); }
});

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

test.each(["withdrawn", "accepted", "lost response"])("picture recovery handles %s without duplicating a saved send", async outcome => {
	const { store, session, transport, close } = await fixture();
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, ...{ pictures: true, recovery: true } }); await session.refresh();
		session.outbox.stop(); await session.outbox.settled();
		const source = await prepareLocalPicture(id(40), entry, new TextEncoder().encode("Saved original").buffer);
		const pictures = [{ type: "picture" as const, picture_id: source.id, alt: "Keep" }];
		await store.saveDraft({ id: "recover", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures } }, null, [source]);
		const pending = command(); pending.payload.body = { version: 1, blocks: pictures };
		await store.enqueue(pending, 1, { id: "recover", revision: 0 });
		const op = (await store.getOperation(pending.operationId))!;
		if (outcome === "accepted") transport.withdraw.mockResolvedValue({ status: "accepted", result: await transport.send() });
		if (outcome === "lost response") transport.withdraw.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		if (outcome === "lost response") {
			await expect(session.repairPictures(op)).rejects.toMatchObject({ action: "retry" });
			expect((await store.getOperation(op.operationId))?.state).toBe("queued");
			expect(await store.pictureSource(source.id, entry)).toBeDefined();
		} else {
			expect(await session.repairPictures(op)).toBe(outcome === "accepted" ? "accepted" : "requeued");
			expect((await store.getOperation(op.operationId))?.state).toBe(outcome === "accepted" ? "accepted" : "withdrawn");
			await session.repairPictures(op); expect(transport.withdraw).toHaveBeenCalledTimes(1);
		}
		session.setForeground(false);
		await expect(session.repairPictures(op)).rejects.toThrow("Reconnect");
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

test("Send and reopen uploads pictures before submitting and retries an unconfirmed reply without re-uploading", async () => {
	const { session, store, transport, close } = await fixture();
	const source = await prepareLocalPicture(id(70), entry, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1, blocks: [{ type: "picture", picture_id: source.id }] };
	const operation = { operationId: id(71), scopeId: entry, payload: { type: "reply.create", thread_id: id(5), message_id: id(72), body, reopen: true, expected_state_revision: 2 } };
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, ...{ pictures: true } }); await session.refresh();
		await store.saveDraft({ id: "reply", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures: body.blocks } }, null, [source]);
		transport.sendOnline.mockImplementationOnce(async () => {
			expect(transport.uploadPicture).toHaveBeenCalledTimes(1); expect(await store.preference("online:reply")).toBeDefined();
			throw new DiscussionFailure("retry", "network_unavailable");
		});
		await expect(session.onlineDraft({ id: "reply", revision: 0 }, operation)).rejects.toThrow();
		expect(await store.pictureSource(source.id, entry)).toBeDefined(); expect(await store.pending(entry)).toEqual([]);
		await session.onlineDraft({ id: "reply", revision: 0 }, { ...operation, operationId: id(99) });
		expect(transport.uploadPicture).toHaveBeenCalledTimes(1);
		expect(transport.sendOnline.mock.calls[1][0]).toEqual(operation);
		expect(await store.getDraft("reply")).toBeUndefined(); expect(await store.pictureSource(source.id, entry)).toBeUndefined();
	} finally { await close(); }
});

test("a rejected picture leaves the online draft editable and a concurrent draft change prevents publication", async () => {
	const { session, store, transport, close } = await fixture();
	const source = await prepareLocalPicture(id(70), entry, new Uint8Array([1, 2, 3]).buffer);
	const body = { version: 1, blocks: [{ type: "picture", picture_id: source.id }] };
	const operation = { operationId: id(71), scopeId: entry, payload: { type: "reply.create", thread_id: id(5), message_id: id(72), body, reopen: true, expected_state_revision: 2 } };
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, ...{ pictures: true } }); await session.refresh();
		await store.saveDraft({ id: "reply", scopeId: entry, revision: 0, body: { text: "", mentions: [], pictures: body.blocks } }, null, [source]);
		transport.uploadPicture.mockRejectedValueOnce(new DiscussionFailure("reject", "invalid_picture", 415));
		await expect(session.onlineDraft({ id: "reply", revision: 0 }, operation)).rejects.toThrow();
		expect(await store.preference("online:reply")).toBeUndefined(); expect(transport.sendOnline).not.toHaveBeenCalled();
		transport.uploadPicture.mockImplementationOnce(async () => {
			await store.saveDraft({ id: "reply", scopeId: entry, revision: 1, body: "Other window removed the picture" }, 0);
			return { state: "verified" };
		});
		await expect(session.onlineDraft({ id: "reply", revision: 0 }, operation)).rejects.toThrow("another view");
		expect(await store.preference("online:reply")).toBeUndefined(); expect(transport.sendOnline).not.toHaveBeenCalled();
		expect((await store.getDraft("reply"))?.body).toBe("Other window removed the picture");
	} finally { await close(); }
});

test.each(["withdrawn", "accepted", "lost response"])("online draft recovery handles %s without automatically resending or reopening", async outcome => {
	const { session, store, transport, close } = await fixture();
	const operation = { operationId: id(71), scopeId: entry, payload: { type: "reply.create", thread_id: id(5), message_id: id(72),
		body: bodyFromText("Retain me"), reopen: true, expected_state_revision: 2 } };
	const reference = { id: "reply", scopeId: entry, revision: 0 };
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, ...{ recovery: true } }); await session.refresh();
		await store.saveDraft({ ...reference, body: "Retain me" }, null); await store.prepareOnlineDraft("reply", 0, operation);
		if (outcome === "accepted") transport.withdrawOnline.mockResolvedValue({ status: "accepted", ...{ result: await transport.send() } });
		if (outcome === "lost response") transport.withdrawOnline.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		if (outcome === "lost response") {
			await expect(session.recoverOnlineDraft(reference)).rejects.toMatchObject({ action: "retry" });
			expect(await store.preference("online:reply")).toBeDefined(); expect((await store.getDraft("reply"))?.revision).toBe(0);
		} else {
			expect((await session.recoverOnlineDraft(reference)).status).toBe(outcome === "accepted" ? "accepted" : "editable");
			expect(await store.preference("online:reply")).toBeUndefined();
			expect(await store.getDraft("reply")).toEqual(outcome === "accepted" ? undefined : { ...reference, revision: 1, body: "Retain me" });
		}
		expect(transport.withdrawOnline).toHaveBeenCalledWith(operation); expect(transport.sendOnline).not.toHaveBeenCalled(); expect(await store.pending(entry)).toEqual([]);
		session.setForeground(false); await expect(session.recoverOnlineDraft(reference)).rejects.toThrow("Reconnect");
	} finally { await close(); }
});

test("refreshing an offline draft keeps its originals and never submits the stale preflight from another window", async () => {
	const { session, store, transport, close } = await fixture();
	const source = await prepareLocalPicture(id(70), entry, new Uint8Array([1, 2, 3]).buffer);
	const reference = { id: "reply", scopeId: entry, revision: 0 }, pictures = [{ type: "picture", picture_id: source.id, alt: "Keep" }];
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, ...{ pictures: true } }); await session.refresh();
		await store.saveDraft({ ...reference, body: { text: "Original", mentions: [], pictures } }, null, [source]);
		transport.uploadPicture.mockImplementationOnce(async () => {
			session.setForeground(false);
			await session.refreshDraftPictures(reference);
			return { state: "verified" };
		});
		await expect(session.onlineDraft(reference, { operationId: id(71), scopeId: entry, payload: { type: "reply.create", thread_id: id(5), message_id: id(72),
			body: { version: 1, blocks: pictures }, reopen: true, expected_state_revision: 2 } })).rejects.toThrow("another view");
		const restored = (await store.getDraft("reply"))!;
		expect(restored).toMatchObject({ revision: 1, body: { text: "Original" } });
		expect(transport.sendOnline).not.toHaveBeenCalled(); expect(await store.pending(entry)).toEqual([]);
		expect(await store.preference("online:reply")).toBeUndefined(); expect(await store.pictureSource(source.id, entry)).toBeUndefined();
	} finally { await close(); }
});

test("generation refresh never rewrites a queued selection, and revocation clears its cached context", async () => {
	const { store, session, transport, close } = await fixture();
	const anchor = { version: 1, type: "text", document_id: entry, generation: id(30), start: "AA==", end: "AA==",
		dependency: "AAA=", selected_length: 0, context: { quote: "", prefix: "", suffix: "", truncated: false } };
	try {
		expect(session.canAnchorText).toBe(false); expect(transport.anchorContext).not.toHaveBeenCalled();
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true }); await session.refresh();
		expect(session.documentGeneration(entry)).toBe(id(30));
		session.setForeground(false); await session.outbox.settled();
		await session.queue({ ...command(), payload: { ...command().payload, anchor } });
		transport.anchorContext.mockResolvedValue({ entryId: entry, generation: id(31) });
		transport.send.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session.setForeground(true); await session.refresh(); await session.outbox.settled();
		expect(session.documentGeneration(entry)).toBe(id(31));
		expect((await store.getOperation(id(4)))?.payload).toMatchObject({ anchor: { generation: id(30) } });
		await expect(session.queue({ ...command(), operationId: id(40), payload: { ...command().payload, anchor } })).rejects.toThrow("selection");
		transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false });
		await session.refresh();
		expect(session.documentGeneration(entry)).toBeUndefined();
		expect(await store.preference("documentGeneration:" + entry)).toBeUndefined();
		expect((await store.getOperation(id(4)))?.payload).toMatchObject({ anchor: { generation: id(30) } });
	} finally { await close(); }
});

test("verified text context can be used offline after restart, but disabled text support leaves note comments available", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	await store.setPreference("enabled", true); await store.setPreference("textAnchorsEnabled", true);
	await store.setPreference("permission:" + entry, { read: true, comment: true, edit: false, moderate: false });
	await store.setPreference("documentGeneration:" + entry, id(30));
	transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(entry, () => {}); await session.refresh();
		expect(session.documentGeneration(entry)).toBe(id(30));
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true });
		transport.permissions.mockResolvedValue({ read: true, comment: true, edit: false, moderate: false });
		transport.anchorContext.mockRejectedValue(new DiscussionFailure("pause", "discussion_endpoint_unavailable", 404));
		await session.refresh();
		expect(session.documentGeneration(entry)).toBeUndefined();
		expect(await store.preference("documentGeneration:" + entry)).toBeNull();
		expect(session.permission(entry)?.comment).toBe(true); expect(session.canQueue).toBe(true);
	} finally { await session.close(); }
});

test("block drafts require verified support, persist offline across restart, and keep their immutable target after disable", async () => {
	const factory = new IDBFactory(), transport = remote();
	let store = await DiscussionStore.open(identity, factory);
	let session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	const anchor = { version: 1, type: "text", document_id: entry, generation: id(30), start: "AA==", end: "AA==",
		dependency: "AAA=", selected_length: 4, context: { quote: "Note", prefix: "", suffix: "", truncated: false },
		structure: { kind: "blocks", blocks: [{ kind: "paragraph", explicit_id: "existing" }] } };
	const operation = { ...command(), payload: { ...command().payload, anchor } };
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true });
		await session.start(); session.watch(entry, () => {}); await session.refresh();
		expect(session.canAnchorBlocks).toBe(false);
		await expect(session.queue(operation)).rejects.toThrow("Block comments");
		expect(await store.getOperation(operation.operationId)).toBeUndefined();
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true, blockAnchors: true });
		await session.refresh(); expect(session.canAnchorBlocks).toBe(true);
		await session.close();
		store = await DiscussionStore.open(identity, factory);
		transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.send.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(entry, () => {}); await session.refresh();
		expect(session.status).toBe("offline"); expect(session.canAnchorBlocks).toBe(true);
		await session.queue(operation); await session.outbox.settled();
		expect((await store.getOperation(operation.operationId))?.payload).toEqual(operation.payload);
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true, blockAnchors: false });
		transport.permissions.mockResolvedValue({ read: true, comment: true, edit: false, moderate: false });
		await session.refresh();
		expect(session.canAnchorText).toBe(true); expect(session.canAnchorBlocks).toBe(false);
		await expect(session.queue({ ...operation, operationId: id(41) })).rejects.toThrow("Block comments");
		expect((await store.getOperation(operation.operationId))?.payload).toEqual(operation.payload);
	} finally { await session.close(); }
});

test("image targets persist with offline drafts and outbox dependencies without losing version or coordinates", async () => {
	const factory = new IDBFactory(), transport = remote();
	let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	const anchor = { version: 1, type: "image", occurrence: { version: 1, type: "text", document_id: entry, generation: id(30), start: "AA==", end: "AA==",
		dependency: "AAA=", selected_length: 14, context: { quote: "![[chart.png]]", prefix: "", suffix: "", truncated: false } },
		asset: { kind: "managed", entry_id: id(40), sha256: "a".repeat(64) }, basis: { width: 1200, height: 800, orientation: "display" }, geometry: { type: "pin", x: 0.25, y: 0.75 } };
	const operation = { ...command(), payload: { ...command().payload, anchor } };
	try {
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true });
		await session.start(); session.watch(entry, () => {}); await session.refresh();
		await expect(session.queue(operation)).rejects.toThrow("Image comments");
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true, imageOccurrences: true }); await session.refresh();
		await store.saveDraft({ id: "image-draft", scopeId: entry, revision: 0, body: "Discuss this pin", target: anchor }, null);
		await session.close(); store = await DiscussionStore.open(identity, factory);
		for (const request of [transport.capabilities, transport.permissions, transport.changes, transport.send]) request.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		session = new DiscussionSession(store, transport as unknown as DiscussionTransport); await session.start(); session.watch(entry, () => {}); await session.refresh();
		expect(session.canAnchorImages).toBe(true); expect((await store.getDraft("image-draft"))?.target).toEqual(anchor);
		await session.queue(operation, { id: "image-draft", revision: 0 }); await session.outbox.settled();
		expect(await store.getDraft("image-draft")).toBeUndefined(); expect((await store.getOperation(operation.operationId))?.payload).toEqual(operation.payload);
		transport.capabilities.mockResolvedValue({ discussions: true, textAnchors: true, imageOccurrences: false }); await session.refresh();
		expect(session.canAnchorImages).toBe(false); expect((await store.getOperation(operation.operationId))?.payload).toEqual(operation.payload);
	} finally { await session.close(); }
});
