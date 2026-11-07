import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_INBOX_FIXTURE ? test : test.skip;

run("actual server worker projects inbox entries and recovers offline preferences after a lost acknowledgment", async () => {
	const fixture = JSON.parse(readFileSync(process.env.EVC_INBOX_FIXTURE!, "utf8"));
	expect(new URL(fixture.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: randomUUID() };
	const owner = new DiscussionTransport({ ...identity, accountId: fixture.owner }, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), fetch);
	let lose = true;
	const bodies: string[] = [];
	const fetcher: typeof fetch = async (url, init) => {
		const result = await fetch(url, init);
		if (String(url).endsWith("/subscription") && init?.method === "POST") {
			bodies.push(String(init.body));
			if (result.ok && lose) { lose = false; await result.text(); throw new Error("Synthetic lost acknowledgment"); }
		}
		return result;
	};
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetcher);
	const factory = new IDBFactory();
	let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport);
	const tid = randomUUID(), mid = randomUUID();
	async function poll(check: () => boolean) {
		for (let attempt = 0; attempt < 40; attempt++) {
			session.inbox.wake(); await session.inbox.settled(); if (check()) return;
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		throw new Error("Server inbox projection did not arrive");
	}
	try {
		expect(await transport.capabilities()).toMatchObject({ inbox: true });
		expect(await transport.permissions(fixture.entry)).toMatchObject({ read: true, comment: true, edit: false });
		const body = bodyFromText("Please review this discussion");
		body.blocks = [{ type: "paragraph", children: [{ type: "text", text: "Please review", marks: [] }, { type: "mention", user_id: fixture.reviewer }] }];
		const op = { operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create" as const, dependsOn: [], payload: {
			type: "thread.create", thread_id: tid, message_id: mid, anchor: { version: 1, type: "note" }, body: protocolJson(body),
		} };
		const receipt = await owner.send(op); expect(await owner.send(op)).toEqual(receipt);
		await session.start(); await poll(() => session.inbox.items.length === 1);
		expect(session.inbox.items[0]).toMatchObject({ thread_id: tid, reason: "mention", version: 1, unread: true });
		const stop = session.watch(fixture.entry, () => {}); await session.scopeReady(fixture.entry);
		expect((await session.inboxThread(session.inbox.items[0]))?.anchor?.type).toBe("note"); stop();
		await session.inbox.configure(true, "offline", true);
		await session.inbox.queue(session.inbox.items[0], { type: "state", action: "read", seen_version: 1 });
		await session.inbox.queue(session.inbox.items[0], { type: "subscription", expected_version: 0, following: true, muted: false });
		await session.inbox.configure(true, "online", true); await session.inbox.settled();
		expect(session.inbox.pending).toHaveLength(1);
		expect(await transport.inboxSubscription(fixture.entry, tid)).toEqual({ version: 1, following: true, muted: false });
		const before = session.inbox.pending[0];
		await session.close();
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport);
		await session.start(); await session.inbox.settled();
		expect(session.inbox.pending[0].id).toBe(before.id);
		// Respect the persisted retry window rather than resetting it on reload.
		const retryAt = (await store.inboxState()).retryAt;
		await new Promise(resolve => setTimeout(resolve, Math.max(0, retryAt - Date.now()) + 50));
		await poll(() => session.inbox.pending.length === 0);
		expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
		expect(await transport.inboxSubscription(fixture.entry, tid)).toEqual({ version: 1, following: true, muted: false });
		await owner.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: tid, message_id: randomUUID(), body: protocolJson(bodyFromText("Reply without a mention")),
		} });
		await poll(() => session.inbox.items[0]?.version === 2);
		expect(session.inbox.items[0]).toMatchObject({ reason: "reply", read_version: 1, unread: true });
		const revoked = await fetch(fixture.base + `/v1/managed/shares/${fixture.share}/rules`, { method: "PUT", headers: {
			Authorization: "Bearer " + fixture.ownerToken, "Content-Type": "application/json",
		}, body: JSON.stringify([{ user_id: fixture.reviewer, path: "", recursive: true, permission: "none" }]) });
		expect(revoked.status).toBe(200);
		await poll(() => session.inbox.items.length === 0);
		expect((await store.inboxState()).items).toEqual([]);
	} finally { await session.close(); }
}, 75000);
