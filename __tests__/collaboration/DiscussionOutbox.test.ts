import { IDBFactory } from "fake-indexeddb";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionFailure, type CommandResult } from "../../src/collaboration/DiscussionTransport";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

const identity = { serverId: "https://relay.example", accountId: "alice", shareId: "share", vaultId: "vault" };
const command = (operationId: string, dependsOn: string[] = []): QueuedCommand => ({ operationId, scopeId: "note",
	type: "reply.create", payload: { type: "reply.create", body: "original draft" }, dependsOn });
const accepted = (operationId: string): CommandResult => ({ operation_id: operationId, scope_id: "scope", thread_id: "thread",
	sequence: 1, state: "open", state_revision: 1, removed: false, changed: true });
let store: DiscussionStore;
let workers: DiscussionOutbox[];
let time: number;
beforeEach(async () => { store = await DiscussionStore.open(identity, new IDBFactory()); workers = []; time = 100; });
afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.map(w => w.settled())); store.close(); });
function worker(send: jest.Mock, owner = "worker") {
	const item = new DiscussionOutbox(store, { identity, send }, owner, undefined, () => time, () => 0.5);
	workers.push(item); return item;
}

test("duplicate wakeups and competing workers deliver a dependency chain once", async () => {
	await store.enqueue(command("parent"), 1); await store.enqueue(command("reply", ["parent"]), 2);
	const send = jest.fn(async op => accepted(op.operationId)), a = worker(send, "a"), b = worker(send, "b");
	a.resume(); a.wake(); b.resume();
	await Promise.all([a.settled(), b.settled()]);
	expect(send.mock.calls.map(([op]) => op.operationId)).toEqual(["parent", "reply"]);
	expect((await store.getOperation("reply"))?.state).toBe("accepted");
});

test("lost response retries the identical durable payload with bounded backoff", async () => {
	await store.enqueue(command("send"), 1);
	const send = jest.fn().mockRejectedValueOnce(new DiscussionFailure("retry", "network_unavailable")).mockResolvedValue(accepted("send"));
	const item = worker(send); item.resume(); await item.settled();
	expect(await store.getOperation("send")).toMatchObject({ state: "queued", nextAttemptAt: 1100, attempt: 1 });
	item.wake(); await item.settled(); expect(send).toHaveBeenCalledTimes(1);
	time = 1100; item.wake(); await item.settled();
	expect(send).toHaveBeenCalledTimes(2);
	expect(send.mock.calls[1][0].payload).toEqual(send.mock.calls[0][0].payload);
	expect(send.mock.calls[1][0].operationId).toBe("send");
});

test("Retry-After defers the entire worker instead of flooding a limited server with offline work", async () => {
	await store.enqueue(command("limited"), 1); await store.enqueue(command("other"), 2);
	const send = jest.fn().mockRejectedValueOnce(new DiscussionFailure("retry", "server_unavailable", 429, 120_000))
		.mockImplementation(async op => accepted(op.operationId));
	const item = worker(send); item.resume(); await item.settled();
	expect((await store.getOperation("limited"))?.nextAttemptAt).toBe(120100);
	expect((await store.getOperation("other"))?.state).toBe("queued");
	item.wake(); await item.settled(); expect(send).toHaveBeenCalledTimes(1);
	time = 120100; item.wake(); await item.settled();
	expect((await store.getOperation("other"))?.state).toBe("accepted");
});

test.each(["authenticate", "pause"] as const)("%s preserves a pending send and requires explicit resume", async action => {
	await store.enqueue(command("send"), 1);
	const send = jest.fn().mockRejectedValueOnce(new DiscussionFailure(action, "repair_required")).mockResolvedValue(accepted("send"));
	const item = worker(send); item.resume(); await item.settled();
	expect(item.status).toBe(action === "authenticate" ? "authentication_required" : "protocol_error");
	expect((await store.getOperation("send"))?.state).toBe("queued");
	item.wake(); await item.settled(); expect(send).toHaveBeenCalledTimes(1);
	item.resume(); await item.settled(); expect((await store.getOperation("send"))?.state).toBe("accepted");
});

test("permission loss removes only remote scope data and preserves rejected text/dependencies", async () => {
	await store.saveDraft({ id: "draft", scopeId: "note", revision: 0, body: "unsent draft" });
	await store.applyRemoteBatch("note", undefined, "cursor", [{ id: "message", revision: 1, value: "cached body" }]);
	await store.applyRemoteBatch("other", undefined, "other-cursor", [{ id: "message", revision: 1, value: "other body" }]);
	await store.enqueue(command("denied"), 1); await store.enqueue(command("child", ["denied"]), 2);
	const item = worker(jest.fn().mockRejectedValue(new DiscussionFailure("reject", "comment_forbidden", 403)));
	item.resume(); await item.settled();
	expect(await store.getOperation("denied")).toMatchObject({ state: "rejected", payload: { body: "original draft" } });
	expect((await store.getOperation("child"))?.state).toBe("queued");
	expect(await store.nextWakeAt()).toBeUndefined();
	expect(await store.entity("note", "message")).toBeUndefined(); expect(await store.cursor("note")).toBeUndefined();
	expect((await store.entity("other", "message"))?.value).toBe("other body");
	expect((await store.getDraft("draft"))?.body).toBe("unsent draft");
});

test("stop ignores an in-flight success; restart recovers the same ID after lease expiry", async () => {
	await store.enqueue(command("send"), 1);
	let finish!: (result: CommandResult) => void, started!: () => void;
	const began = new Promise<void>(resolve => { started = resolve; });
	const send = jest.fn().mockImplementationOnce(() => { started(); return new Promise<CommandResult>(resolve => { finish = resolve; }); }).mockResolvedValue(accepted("send"));
	const item = worker(send); item.resume(); await began; item.stop();
	finish(accepted("send")); await item.settled();
	expect((await store.getOperation("send"))?.state).toBe("sending");
	time = 30101; item.resume(); await item.settled();
	expect((await store.getOperation("send"))?.state).toBe("accepted"); expect(send).toHaveBeenCalledTimes(2);
});

test("local acknowledgment failure pauses delivery without rejecting or losing the original command", async () => {
	await store.enqueue(command("send"), 1);
	const save = jest.spyOn(store, "accept").mockRejectedValueOnce(new Error("Storage full"));
	const item = worker(jest.fn().mockResolvedValue(accepted("send"))); item.resume(); await item.settled();
	expect(item.status).toBe("storage_error"); expect((await store.getOperation("send"))?.state).toBe("sending");
	save.mockRestore();
});

test("worker refuses a store from another account before claiming work", () => {
	expect(() => new DiscussionOutbox(store, { identity: { ...identity, accountId: "bob" }, send: jest.fn() }, "worker"))
		.toThrow("identity");
});

test("caller mutation cannot change a queued payload during IndexedDB persistence", async () => {
	const op = command("send"), pending = store.enqueue(op, 1);
	(op.payload as Record<string, unknown>).body = "changed"; await pending;
	expect((await store.getOperation("send"))?.payload).toMatchObject({ body: "original draft" });
	await expect(store.enqueue({ ...command("reopen"), payload: { reopen: true } })).rejects.toThrow("online");
});
