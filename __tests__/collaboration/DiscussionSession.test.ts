import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";
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
