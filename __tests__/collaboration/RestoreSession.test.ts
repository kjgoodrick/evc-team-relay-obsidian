import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionFailure, type DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "restore-session" }, scope = id(3);
const command = (n = 4): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: "thread.create", dependsOn: [],
	payload: protocolJson({ type: "thread.create", thread_id: id(10), message_id: id(11), anchor: { version: 1, type: "note" }, body: bodyFromText("Saved") }) });
const caps = (generation: string | null = null) => ({ discussions: true, restoreContext: { supported: true, generation }, commandStatus: true });
const remote = () => ({ identity, capabilities: jest.fn().mockResolvedValue(caps()),
	permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
	participants: jest.fn().mockResolvedValue({ participants: [{ id: id(1), name: "Current member" }], hasMore: false }),
	changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
	send: jest.fn(async (op: QueuedCommand) => ({ operation_id: op.operationId, scope_id: id(12), thread_id: id(10), sequence: 1,
		state: "open", state_revision: 1, removed: false, changed: true })),
	sendOnline: jest.fn().mockResolvedValue({ changed: true }), commandStatus: jest.fn().mockResolvedValue({ status: "unknown" }),
});
async function until(check: () => boolean | Promise<boolean>) {
	for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
	throw new Error("Expected fixture activity did not occur");
}
async function fixture(generation: string | null = null) {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory), transport = remote();
	transport.capabilities.mockResolvedValue(caps(generation));
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	return { factory, store, transport, session, ready: async () => { await session.start(); session.watch(scope, () => {}); await session.refresh(); }, close: () => session.close() };
}

test("startup quarantines legacy queued work before the first send and binds explicit new work", async () => {
	const f = await fixture(id(90));
	try {
		await f.store.enqueue(command(), 1); await f.ready(); await f.session.outbox.settled();
		expect(f.transport.send).not.toHaveBeenCalled();
		expect(await f.store.getOperation(id(4))).toMatchObject({ state: "rejected", error: "restore_generation_changed", attempt: 0 });
		expect(f.session.restoreBinding).toEqual({ restoreGeneration: id(90) });
		await f.session.queue({ ...command(5), ...f.session.restoreBinding }); await f.session.outbox.settled();
		expect(f.transport.send).toHaveBeenCalledWith(expect.objectContaining({ operationId: id(5), restoreGeneration: id(90) }), expect.any(Function));
		expect((await f.store.getOperation(id(5)))?.state).toBe("accepted");
		await expect(f.session.queue(command(6))).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(await f.session.checkSavedCommand(command(), () => true)).toEqual({ status: "unknown" });
		expect((await f.store.getOperation(id(4)))?.state).toBe("rejected");
	} finally { await f.close(); }
});

test("reconnect rejects an old captured intent without rebinding it to the new generation", async () => {
	const f = await fixture();
	try {
		await f.ready(); const captured = { ...command(), ...f.session.restoreBinding };
		f.transport.capabilities.mockResolvedValue(caps(id(90))); await f.session.refresh();
		await expect(f.session.queue(captured)).rejects.toMatchObject({ code: "restore_generation_changed" });
		await expect(f.session.onlineAction({ operationId: id(5), scopeId: scope, payload: { type: "thread.state" } })).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect(f.transport.send).not.toHaveBeenCalled(); expect(f.transport.sendOnline).not.toHaveBeenCalled();
		expect(f.session.restoreBinding).toEqual({ restoreGeneration: id(90) });
	} finally { await f.close(); }
});

test("permission results already in flight cannot restore old authority after a restore", async () => {
	const f = await fixture(); let finish: (() => void) | undefined;
	try {
		await f.ready();
		f.transport.permissions.mockImplementationOnce(() => new Promise(resolve => {
			finish = () => resolve({ read: true, comment: true, edit: true, moderate: true });
		}));
		const oldRefresh = f.session.refresh(); await until(() => !!finish);
		f.transport.capabilities.mockResolvedValue(caps(id(90)));
		f.transport.permissions.mockResolvedValue({ read: true, comment: false, edit: false, moderate: false });
		const restoring = f.session.start();
		await until(async () => (await f.store.restoreCheckpoint()).context.generation === id(90));
		expect(f.session.online).toBe(false); expect(f.session.canQueue).toBe(false);
		finish!(); await oldRefresh; await restoring; await f.session.refresh();
		expect(f.session.permission(scope)).toEqual({ read: true, comment: false, edit: false, moderate: false });
		expect(await f.store.preference("permission:" + scope)).toEqual({ read: true, comment: false, edit: false, moderate: false });
	} finally { finish?.(); await f.close(); }
});

test("a restore observed by another window is adopted before returning to ready", async () => {
	const f = await fixture(), other = await DiscussionStore.open(identity, f.factory);
	try {
		await f.ready(); const captured = { ...command(), ...f.session.restoreBinding };
		await other.observeRestoreContext({ supported: true, generation: id(90) }, (await other.restoreCheckpoint()).revision);
		f.transport.capabilities.mockResolvedValue(caps(id(90))); await f.session.refresh();
		expect(f.session.restoreBinding).toEqual({ restoreGeneration: id(90) });
		await expect(f.session.queue(captured)).rejects.toMatchObject({ code: "restore_generation_changed" });
	} finally { other.close(); await f.close(); }
});

test("offline startup retains the last learned binding and saved authority", async () => {
	const f = await fixture(id(90)); let offline: DiscussionSession | undefined;
	try {
		await f.ready(); await f.close();
		const store = await DiscussionStore.open(identity, f.factory);
		f.transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		f.transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		f.transport.send.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		f.transport.changes.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		offline = new DiscussionSession(store, f.transport as unknown as DiscussionTransport);
		await offline.start(); offline.watch(scope, () => {}); await offline.scopeReady(scope); offline.setForeground(false);
		expect(offline.restoreBinding).toEqual({ restoreGeneration: id(90) });
		expect(offline.permission(scope)?.comment).toBe(true);
		await offline.queue({ ...command(), ...offline.restoreBinding });
		expect(await store.getOperation(id(4))).toMatchObject({ state: "queued", restoreGeneration: id(90) });
	} finally { await offline?.close(); await f.close(); }
});

test("a server downgrade cannot silently turn a bound session into a legacy sender", async () => {
	const f = await fixture(id(90));
	try {
		await f.ready(); f.transport.capabilities.mockResolvedValue({ discussions: true }); await f.session.refresh();
		expect(f.session.canQueue).toBe(false); expect(f.session.online).toBe(false);
		expect((await f.store.restoreCheckpoint()).context.generation).toBe(id(90));
		expect(f.transport.send).not.toHaveBeenCalled();
	} finally { await f.close(); }
});
