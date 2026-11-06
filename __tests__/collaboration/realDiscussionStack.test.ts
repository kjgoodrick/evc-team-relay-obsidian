import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionSync, messageKey, threadKey } from "../../src/collaboration/DiscussionSync";
import { DiscussionStore, type Json, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";

const fixturePath = process.env.EVC_DISCUSSION_FIXTURE;
const integration = fixturePath ? test : test.skip;
Object.assign(globalThis, { IDBKeyRange });

integration("real HTTP commands recover lost replies, persist history/reactions, and recheck comment revocation", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as {
		base: string; share: string; entry: string; reviewer: string; token: string; ownerToken: string;
	};
	if (new URL(fixture.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback server is allowed");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: "synthetic-vault" };
	const store = await DiscussionStore.open(identity, new IDBFactory());
	let time = Date.now(), lostResponse = true;
	const fetcher = jest.fn(async (url: string, config: RequestInit) => {
		const response = await fetch(url, config);
		if (lostResponse && response.ok && config.method === "POST") { lostResponse = false; await response.text(); throw new Error("Lost accepted response"); }
		return response;
	});
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetcher);
	const worker = new DiscussionOutbox(store, transport, "integration-worker", undefined, () => time, () => 0.5);
	const incoming = new DiscussionSync(store, transport, fixture.entry);
	const body = (text: string) => ({ version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text }] }] });
	const thread = randomUUID(), message = randomUUID(), root = randomUUID();
	const enqueue = (type: QueuedCommand["type"], payload: Json, dependsOn: string[] = [], operationId = randomUUID()) =>
		store.enqueue({ operationId, scopeId: fixture.entry, type, payload, dependsOn }, time);
	const api = async (path: string, options: RequestInit = {}, owner = false) => {
		const response = await fetch(fixture.base + "/v1/collaboration/" + path, { ...options,
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner ? fixture.ownerToken : fixture.token}` } });
		expect(response.status).toBe(200); return response.json();
	};
	const scopePath = `shares/${fixture.share}/entries/${fixture.entry}`;
	try {
		expect(await transport.capabilities()).toEqual({ discussions: true });
		await enqueue("thread.create", { type: "thread.create", thread_id: thread, message_id: message,
			anchor: { version: 1, type: "note" }, body: body("First") }, [], root);
		await enqueue("reply.create", { type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Reply") }, [root]);
		worker.resume(); await worker.settled();
		expect((await store.getOperation(root))?.state).toBe("queued");
		time += 1001; worker.wake(); await worker.settled();
		expect((await store.getOperation(root))?.state).toBe("accepted");
		expect(fetcher.mock.calls.filter(([, config]) => config.method === "POST")).toHaveLength(3); // two root attempts, one dependent reply
		let view = await api(`${scopePath}/threads/${thread}`);
		expect(view.messages).toHaveLength(2); expect(view.messages[0].body.blocks[0].children[0].text).toBe("First");
		const edit = await enqueue("message.edit", { type: "message.edit", thread_id: thread, message_id: message,
			expected_revision: 1, body: body("Revised") });
		await enqueue("reaction.set", { type: "reaction.set", thread_id: thread, message_id: message, emoji: "heart", present: true });
		worker.wake(); await worker.settled();
		expect((await store.getOperation(edit.operationId))?.state).toBe("accepted");
		view = await api(`${scopePath}/threads/${thread}`);
		expect(view.messages[0]).toMatchObject({ revision: 2, reactions: [{ emoji: "heart", count: 1, mine: true }] });
		const history = await api(`${scopePath}/threads/${thread}/messages/${message}/history`);
		expect(history.revisions.map((r: { revision: number }) => r.revision)).toEqual([1, 2]);
		const changes = await api(`${scopePath}/changes`);
		expect(changes.events).toHaveLength(4); // duplicate retry produced no extra event
		incoming.resume(); await incoming.settled();
		expect(incoming.status).toBe("current");
		expect((await store.entity(fixture.entry, messageKey(thread, message)))?.value).toMatchObject({
			revision: 2, body: body("Revised"), reactions: [{ emoji: "heart", count: 1, mine: true }],
		});
		expect((await transport.history(fixture.entry, thread, message)).revisions.map(r => r.revision)).toEqual([1, 2]);
		expect((await transport.threads(fixture.entry)).threads).toHaveLength(1);
		expect((await transport.state(fixture.entry, thread)).thread.state).toBe("open");
		incoming.stop(); await incoming.settled();
		const rules = await api(`shares/${fixture.share}/comment-rules`, {}, true);
		await api(`shares/${fixture.share}/comment-rules`, { method: "PUT", body: JSON.stringify({
			expected_revision: rules.revision, rules: [{ user_id: fixture.reviewer, path: "", recursive: true, allowed: false }],
		}) }, true);
		const denied = await enqueue("reply.create", { type: "reply.create", thread_id: thread, message_id: randomUUID(), body: body("Keep my draft") });
		worker.wake(); await worker.settled();
		expect(await store.getOperation(denied.operationId)).toMatchObject({ state: "rejected", error: "comment_forbidden", payload: { body: body("Keep my draft") } });
		expect(await store.entity(fixture.entry, messageKey(thread, message))).toBeUndefined();
		expect((await api(`${scopePath}/threads/${thread}`)).messages).toHaveLength(2);
		await api("commands", { method: "POST", body: JSON.stringify({ protocol_version: 1, operation_id: randomUUID(),
			share_id: fixture.share, entry_id: fixture.entry, command: { type: "thread.remove", thread_id: thread,
				expected_state_revision: 1, reason: "Synthetic moderation" } }) }, true);
		incoming.resume(); await incoming.settled();
		expect(incoming.status).toBe("current");
		expect((await store.entity(fixture.entry, threadKey(thread)))?.value).toMatchObject({ removed: true });
		expect(await store.entity(fixture.entry, messageKey(thread, message))).toBeUndefined();
		expect((await store.getOperation(denied.operationId))?.payload).toMatchObject({ body: body("Keep my draft") });
	} finally { worker.stop(); incoming.stop(); await Promise.all([worker.settled(), incoming.settled()]); store.close(); }
}, 30_000);
