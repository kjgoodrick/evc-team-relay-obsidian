/** Opt-in actual control-plane/MinIO integration; no live vault or credentials. */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionDelivery } from "../../src/collaboration/DiscussionDelivery";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";
import type { PlatformRequestInit } from "../../src/platformFetch";

Object.assign(globalThis, { IDBKeyRange });
const fixturePath = process.env.EVC_PICTURE_FIXTURE;
const integration = fixturePath ? test : test.skip;

integration("offline picture dependencies recover a lost upload ack against real HTTP and MinIO", async () => {
	const fixture = JSON.parse(readFileSync(fixturePath!, "utf8")) as { base: string; share: string; entry: string; reviewer: string; owner: string; token: string; ownerToken: string; picturePath: string };
	if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.base)) throw new Error("Only the disposable loopback fixture is allowed");
	const identity = { serverId: fixture.base, shareId: fixture.share, accountId: fixture.reviewer, vaultId: randomUUID() };
	const factory = new IDBFactory(); let store = await DiscussionStore.open(identity, factory), time = Date.now(), online = false, loseUpload = true, puts = 0;
	const fetcher = async (url: string, init: PlatformRequestInit): Promise<Response> => {
		if (!online) throw new Error("Synthetic offline period");
		const response = await fetch(url, init);
		if (init.method === "PUT" && url.includes("/pictures/") && response.ok) {
			puts++;
			if (loseUpload) { loseUpload = false; throw new Error("Synthetic lost upload acknowledgment"); }
		}
		return response;
	};
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.reviewer, accessToken: fixture.token }), fetcher);
	const owner = new DiscussionTransport({ ...identity, accountId: fixture.owner }, async () => ({ accountId: fixture.owner, accessToken: fixture.ownerToken }), (url, init) => fetch(url, init));
	const makeWorker = () => new DiscussionOutbox(store, new DiscussionDelivery(store, transport), randomUUID(), undefined, () => time, () => 0.5);
	let worker = makeWorker();
	const raw = readFileSync(fixture.picturePath), original = new Uint8Array(raw).buffer;
	const pictureId = randomUUID(), source = await prepareLocalPicture(pictureId, fixture.entry, original);
	const threadId = randomUUID(), messageId = randomUUID(), operationId = randomUUID();
	const body = { version: 1, blocks: [{ type: "picture", picture_id: pictureId, alt: "Fixture diagram" }] };
	const command: QueuedCommand = { operationId, scopeId: fixture.entry, type: "thread.create", dependsOn: [], payload: {
		type: "thread.create", thread_id: threadId, message_id: messageId, anchor: { version: 1, type: "note" }, body,
	} };
	try {
		await store.saveDraft({ id: "picture-draft", scopeId: fixture.entry, revision: 0, body: { text: "", mentions: [], pictures: body.blocks } }, null, [source]);
		await store.enqueue(command, time, { id: "picture-draft", revision: 0 });
		worker.resume(); await worker.settled();
		expect((await store.getOperation(pictureId))?.state).toBe("queued");
		expect((await store.getOperation(operationId))?.state).toBe("queued");
		worker.stop(); await worker.settled(); store.close();
		store = await DiscussionStore.open(identity, factory); worker = makeWorker();
		expect((await store.pictureSource(pictureId, fixture.entry))?.bytes).toEqual(original);
		online = true; time += 1001;
		expect((await transport.capabilities()).pictures).toBe(true);
		expect(await transport.permissions(fixture.entry)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		worker.resume(); await worker.settled();
		expect(puts).toBe(1);
		expect((await store.getOperation(pictureId))?.state).toBe("queued");
		expect((await transport.picture(fixture.entry, pictureId)).state).toBe("verified");
		await expect(owner.picture(fixture.entry, pictureId)).rejects.toMatchObject({ status: 404 });
		expect((await transport.threads(fixture.entry)).threads).toHaveLength(0);
		time += 2001; worker.wake(); await worker.settled();
		expect((await store.getOperation(operationId))?.state).toBe("accepted");
		expect(puts).toBe(1); // The second stage request recovered the verified upload.
		expect(await store.pictureSource(pictureId, fixture.entry)).toBeUndefined();
		const read = await transport.message(fixture.entry, threadId, messageId);
		expect(read.message.body).toEqual(body);
		const picture = await owner.picture(fixture.entry, pictureId);
		expect(picture.state).toBe("attached");
		expect(picture.renditions.content).toMatchObject({ width: 800, height: 600, mime: "image/png" });
		const content = await owner.pictureContent(fixture.entry, pictureId, "content", picture.renditions.content!);
		expect(new Uint8Array(content).slice(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
		expect(Buffer.from(content).includes(Buffer.from("Remove fixture metadata"))).toBe(false);
		expect((await owner.pictureContent(fixture.entry, pictureId, "thumbnail", picture.renditions.thumbnail!)).byteLength).toBeGreaterThan(0);
		const editId = randomUUID();
		await store.enqueue({ operationId: editId, scopeId: fixture.entry, type: "message.edit", dependsOn: [], payload: {
			type: "message.edit", thread_id: threadId, message_id: messageId, expected_revision: 1, body: protocolJson(bodyFromText("Edited, picture remains in history")),
		} }, time);
		worker.wake(); await worker.settled();
		expect((await transport.history(fixture.entry, threadId, messageId)).revisions[0].body).toEqual(body);
		await expect(owner.pictureContent(fixture.entry, pictureId, "content", picture.renditions.content!)).resolves.toBeInstanceOf(ArrayBuffer);

		const secondId = randomUUID(), second = await prepareLocalPicture(secondId, fixture.entry, original);
		await store.saveDraft({ id: "revoked-picture", scopeId: fixture.entry, revision: 0, body: { text: "Keep my picture", mentions: [], pictures: [{ type: "picture", picture_id: secondId }] } }, null, [second]);
		const queuedId = randomUUID();
		await store.enqueue({ ...command, operationId: queuedId, payload: { type: "reply.create", thread_id: threadId, message_id: randomUUID(), body: { version: 1, blocks: [{ type: "picture", picture_id: secondId }] } }, type: "reply.create" }, time, { id: "revoked-picture", revision: 0 });
		const rulesPath = fixture.base + `/v1/collaboration/shares/${fixture.share}/comment-rules`;
		const auth = { Authorization: "Bearer " + fixture.ownerToken, "Content-Type": "application/json" };
		const rules = await (await fetch(rulesPath, { headers: auth })).json();
		const revoked = await fetch(rulesPath, { method: "PUT", headers: auth, body: JSON.stringify({ expected_revision: rules.revision,
			rules: [{ user_id: fixture.reviewer, path: "", recursive: true, allowed: false }] }) });
		expect(revoked.status).toBe(200);
		worker.wake(); await worker.settled();
		expect((await store.getOperation(secondId))?.state).toBe("rejected");
		expect((await store.getOperation(queuedId))?.state).toBe("queued");
		expect((await store.pictureSource(secondId, fixture.entry))?.bytes).toEqual(original);
	} finally { worker.stop(); await worker.settled(); store.close(); }
}, 45_000);
