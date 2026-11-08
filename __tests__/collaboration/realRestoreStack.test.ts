import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";

const fixturePath = process.env.EVC_RESTORE_FIXTURE;
const integration = fixturePath ? test : test.skip;
Object.assign(globalThis, { IDBKeyRange });

integration("a real restored server fences legacy work while explicit new-lineage commands and read-only receipts work", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
		base: string; share: string; entry: string; reviewer: string; token: string; restoreGeneration: string;
	};
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: "synthetic-restore" };
	const store = await DiscussionStore.open(identity, new IDBFactory());
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetch);
	const worker = new DiscussionOutbox(store, transport, "restore-proof");
	const thread = randomUUID(), message = randomUUID();
	const legacy: QueuedCommand = { operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [],
		payload: protocolJson({ type: "thread.create", thread_id: thread, message_id: message,
			anchor: { version: 1, type: "note" }, body: bodyFromText("Preserve this legacy queued comment") }) };
	try {
		await store.enqueue(legacy);
		await expect(transport.send(legacy)).rejects.toMatchObject({ code: "restore_generation_changed", action: "pause" });
		await expect(transport.withdraw(legacy)).rejects.toMatchObject({ code: "restore_generation_changed", action: "pause" });
		expect(await transport.commandStatus(legacy)).toEqual({ status: "unknown" });
		const capabilities = await transport.capabilities();
		expect(capabilities.restoreContext).toEqual({ supported: true, generation: fixture.restoreGeneration });
		await store.observeRestoreContext(capabilities.restoreContext, 0);
		worker.resume(); await worker.settled();
		expect(await store.getOperation(legacy.operationId)).toMatchObject({ state: "rejected", error: "restore_generation_changed", attempt: 0, payload: legacy.payload });
		expect((await transport.threads(fixture.entry)).threads).toHaveLength(0);
		const fresh = { ...legacy, operationId: randomUUID(), restoreGeneration: fixture.restoreGeneration,
			payload: protocolJson({ type: "thread.create", thread_id: thread, message_id: message,
				anchor: { version: 1, type: "note" }, body: bodyFromText("Explicit new work after restore") }) };
		await store.enqueue(fresh); worker.wake(); await worker.settled();
		expect((await store.getOperation(fresh.operationId))?.state).toBe("accepted");
		expect((await transport.threads(fixture.entry)).threads).toHaveLength(1);
		const oldBinding = { ...fresh, restoreGeneration: null };
		await expect(transport.send(oldBinding)).rejects.toMatchObject({ code: "restore_generation_changed" });
		await expect(transport.withdraw(oldBinding)).rejects.toMatchObject({ code: "restore_generation_changed" });
		expect((await transport.commandStatus(oldBinding)).status).toBe("accepted");
		expect((await transport.withdraw(fresh)).status).toBe("accepted");
		expect((await transport.thread(fixture.entry, thread)).messages).toHaveLength(1);
		const reply = { operationId: randomUUID(), scopeId: fixture.entry, restoreGeneration: fixture.restoreGeneration,
			payload: protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Online reply") }) };
		const accepted = await transport.sendOnline(reply);
		expect(await transport.sendOnline(reply)).toEqual(accepted);
		expect((await transport.thread(fixture.entry, thread)).messages).toHaveLength(2);
		expect(await transport.commandStatus(legacy)).toEqual({ status: "unknown" });
	} finally { worker.stop(); await worker.settled(); store.close(); }
});

integration("the ordinary session reconciles restore before delivery and preserves its binding offline", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
		base: string; share: string; entry: string; reviewer: string; token: string; restoreGeneration: string;
	};
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: "synthetic-restore-session" };
	const store = await DiscussionStore.open(identity, new IDBFactory()); let offline = false;
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }),
		(url, options) => { if (offline) return Promise.reject(new Error("Synthetic offline")); return fetch(url, options); });
	const session = new DiscussionSession(store, transport), thread = randomUUID();
	const legacy: QueuedCommand = { operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [],
		payload: protocolJson({ type: "thread.create", thread_id: thread, message_id: randomUUID(),
			anchor: { version: 1, type: "note" }, body: bodyFromText("Preserve original queued text") }) };
	try {
		await store.enqueue(legacy); await session.start(); session.watch(fixture.entry, () => {}); await session.refresh(); await session.outbox.settled();
		expect(await store.getOperation(legacy.operationId)).toMatchObject({ state: "rejected", attempt: 0, error: "restore_generation_changed" });
		expect(session.restoreBinding).toEqual({ restoreGeneration: fixture.restoreGeneration });
		expect(await session.checkSavedCommand(legacy, () => true)).toEqual({ status: "unknown" });
		const fresh = { ...legacy, operationId: randomUUID(), ...session.restoreBinding };
		await session.queue(fresh); await session.outbox.settled();
		expect((await store.getOperation(fresh.operationId))?.state).toBe("accepted");
		await session.onlineAction({ operationId: randomUUID(), scopeId: fixture.entry, ...session.restoreBinding,
			payload: { type: "thread.state", thread_id: thread, state: "resolved", expected_state_revision: 1 } });
		expect((await transport.state(fixture.entry, thread)).thread.state).toBe("resolved");
		offline = true; await session.refresh(); session.setForeground(false); await session.outbox.settled();
		const reply: QueuedCommand = { operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [], ...session.restoreBinding,
			payload: protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Saved while offline") }) };
		await session.queue(reply);
		expect(await store.getOperation(reply.operationId)).toMatchObject({ state: "queued", restoreGeneration: fixture.restoreGeneration });
		offline = false; session.setForeground(true); await session.refresh(); await session.outbox.settled();
		expect((await store.getOperation(reply.operationId))?.state).toBe("accepted");
		expect((await transport.thread(fixture.entry, thread)).messages).toHaveLength(2);
		expect((await store.getOperation(legacy.operationId))?.state).toBe("rejected");
	} finally { await session.close(); }
});
