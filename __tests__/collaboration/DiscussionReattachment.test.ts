import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionReattachment } from "../../src/collaboration/DiscussionReattachment";
import type { OnlineOperation, WithdrawalResult } from "../../src/collaboration/DiscussionTransport";
Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "test" };
const scope = id(3), thread = id(4), note = { version: 1 as const, type: "note" as const };
const outcome = (op: OnlineOperation) => ({ operation_id: op.operationId, scope_id: id(8), thread_id: thread,
	sequence: 3, state: "resolved" as const, state_revision: 2, removed: false, changed: true, anchor_revision: 2 });

async function fixture() {
	const factory = new IDBFactory(), store = await DiscussionStore.open(identity, factory);
	const sendOnline = jest.fn(async (operation: OnlineOperation) => outcome(operation));
	const withdrawOnline = jest.fn(async (_operation: OnlineOperation): Promise<WithdrawalResult> => ({ status: "withdrawn" }));
	const transport = { sendOnline, withdrawOnline }, controller = new DiscussionReattachment(store, transport);
	return { factory, store, transport, controller, close: () => store.close() };
}

test("an interrupted move persists exact intent across reload and never enters the outbox", async () => {
	const f = await fixture();
	try {
		const op = await f.controller.prepare(scope, thread, 1, note, () => true);
		f.transport.sendOnline.mockRejectedValueOnce(new Error("lost response"));
		await expect(f.controller.send(op, () => true)).rejects.toThrow("lost response");
		expect(await f.store.pending(scope)).toEqual([]);
		await expect(f.controller.prepare(scope, thread, 1, note, () => true)).rejects.toThrow("unconfirmed move");
		const other = await DiscussionStore.open(identity, f.factory);
		try {
			const reopened = new DiscussionReattachment(other, f.transport);
			expect(await reopened.pending(scope, thread)).toEqual(op);
			// Caller mutation cannot alter the retained request's target or revision.
			const supplied = { ...op, payload: { ...(op.payload as object), expected_anchor_revision: 8 } };
			await reopened.send(supplied, () => true);
			expect(f.transport.sendOnline.mock.calls.map(call => call[0])).toEqual([op, op]);
			expect(await f.controller.pending(scope, thread)).toBeUndefined();
			await expect(f.controller.send(op, () => true)).rejects.toThrow("completed or replaced");
		} finally { other.close(); }
	} finally { f.close(); }
});

test("competing windows preserve one request and withdrawal cannot retire a replacement", async () => {
	const f = await fixture();
	try {
		const results = await Promise.allSettled([f.controller.prepare(scope, thread, 1, note, () => true), f.controller.prepare(scope, thread, 1, note, () => true)]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		const original = (await f.controller.pending(scope, thread))!;
		expect(await f.controller.recover(original, () => true)).toBe("withdrawn");
		const replacement = await f.controller.prepare(scope, thread, 1, note, () => true);
		await expect(f.controller.send(original, () => true)).rejects.toThrow("replaced");
		expect(await f.controller.pending(scope, thread)).toEqual(replacement);
		expect(f.transport.sendOnline).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("lost withdrawal stays recoverable and an accepted result clears without another send", async () => {
	const f = await fixture();
	try {
		const op = await f.controller.prepare(scope, thread, 1, note, () => true);
		f.transport.withdrawOnline.mockRejectedValueOnce(new Error("network"));
		await expect(f.controller.recover(op, () => true)).rejects.toThrow("network");
		expect(await f.controller.pending(scope, thread)).toEqual(op);
		f.transport.withdrawOnline.mockResolvedValueOnce({ status: "accepted", result: outcome(op) });
		expect(await f.controller.recover(op, () => true)).toBe("accepted");
		expect(await f.controller.pending(scope, thread)).toBeUndefined(); expect(f.transport.sendOnline).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("closing or losing access while reading local intent prevents a new network action", async () => {
	const f = await fixture();
	try {
		await expect(f.controller.prepare(scope, thread, 1, note, () => false)).rejects.toThrow("Reconnect");
		expect(await f.controller.pending(scope, thread)).toBeUndefined();
		const op = await f.controller.prepare(scope, thread, 1, note, () => true);
		await expect(f.controller.send(op, () => false)).rejects.toThrow("Reconnect");
		await expect(f.controller.recover(op, () => false)).rejects.toThrow("Reconnect");
		expect(f.transport.sendOnline).not.toHaveBeenCalled(); expect(f.transport.withdrawOnline).not.toHaveBeenCalled();
		expect(await f.controller.pending(scope, thread)).toEqual(op);
	} finally { f.close(); }
});
