import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { searchItemScope, type DiscussionSearchRequest } from "../../src/collaboration/DiscussionSearchProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_SEARCH_FIXTURE ? test : test.skip;

run("actual search filters current comments, opens the matching reply and rechecks revocation", async () => {
	const fixture = JSON.parse(readFileSync(process.env.EVC_SEARCH_FIXTURE!, "utf8"));
	expect(new URL(fixture.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: fixture.base, accountId: fixture.reviewer, shareId: fixture.share, vaultId: randomUUID() };
	const owner = new DiscussionTransport({ ...identity, accountId: fixture.owner }, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), fetch);
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetch);
	const store = await DiscussionStore.open(identity, new IDBFactory()), session = new DiscussionSession(store, transport);
	const request: DiscussionSearchRequest = { query: "engine", state: "all", mine: false, mentions: false, cursor: null, limit: 30 };
	const thread = randomUUID(), rootMessage = randomUUID(), reply = randomUUID();
	try {
		await session.start(); expect(session.canSearch).toBe(true);
		await owner.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
			type: "thread.create", thread_id: thread, message_id: rootMessage, anchor: { version: 1, type: "note" }, body: protocolJson(bodyFromText("Engine initial review")) } });
		const body = bodyFromText("Engine reviewer reply");
		body.blocks = [{ type: "paragraph", children: [{ type: "text", text: "Engine reviewer reply", marks: [] }, { type: "mention", user_id: fixture.owner }] }];
		await transport.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "reply.create", dependsOn: [], payload: {
			type: "reply.create", thread_id: thread, message_id: reply, body: protocolJson(body) } });
		const page = await session.search({ ...request, mine: true }); expect(page.items).toHaveLength(1);
		expect(page.items[0]).toMatchObject({ message_id: reply, excerpt: "Engine reviewer reply ", kind: "note", entry_id: fixture.entry });
		expect((await session.search({ ...request, mentions: true })).items).toEqual([]);
		expect((await owner.search({ ...request, mentions: true })).items[0].message_id).toBe(reply);
		const stop = session.watch(fixture.entry, () => {}); await session.scopeReady(fixture.entry);
		expect((await session.linkedThread(searchItemScope(page.items[0]), thread, reply))?.message?.body).toEqual(body); stop();
		await transport.send({ operationId: randomUUID(), scopeId: fixture.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: thread, message_id: reply, expected_revision: 1, body: protocolJson(bodyFromText("Revised gearbox")) } });
		expect((await session.search({ ...request, mine: true })).items).toEqual([]);
		expect((await session.search({ ...request, query: "gearbox" })).items[0].message_revision).toBe(2);
		await transport.sendOnline({ operationId: randomUUID(), scopeId: fixture.entry, payload: { type: "thread.state", thread_id: thread, expected_state_revision: 1, state: "resolved" } });
		expect((await session.search({ ...request, query: "", state: "open" })).items).toEqual([]);
		expect((await session.search({ ...request, state: "resolved" })).items[0].message_id).toBe(rootMessage);
		session.setForeground(false); await expect(session.search(request)).rejects.toThrow("Connect"); session.setForeground(true); await session.refresh();
		const response = await fetch(fixture.base + `/v1/managed/shares/${fixture.share}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + fixture.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: fixture.reviewer, path: "", recursive: true, permission: "none" }]) });
		expect(response.status).toBe(200); expect((await session.search(request)).items).toEqual([]);
		await expect(session.search({ ...request, scopeId: fixture.entry })).rejects.toMatchObject({ status: 404 });
	} finally { await session.close(); }
}, 30_000);
