import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson, type ImageFileAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { ImageGeometry } from "../../src/collaboration/anchors/imageGeometry";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
Object.assign(globalThis, { IDBKeyRange });
const run = process.env.EVC_IMAGE_FILE_FIXTURE ? test : test.skip;

run("real image-file discussions queue offline and replay through comment-only access without a text barrier", async () => {
	const fixture = JSON.parse(readFileSync(process.env.EVC_IMAGE_FILE_FIXTURE!, "utf8"));
	expect(new URL(fixture.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: fixture.base, accountId: fixture.bobId, shareId: fixture.share, vaultId: randomUUID() };
	const transport = new DiscussionTransport(identity, async () => ({ accountId: fixture.bobId, accessToken: fixture.bobToken }), fetch);
	const store = await DiscussionStore.open(identity, new IDBFactory()), session = new DiscussionSession(store, transport);
	try {
		expect(await transport.capabilities()).toMatchObject({ imageFiles: true, textAnchors: false, imageOccurrences: false });
		await session.start(); session.watch(fixture.image, () => {}, "image"); await session.refresh();
		expect(session.permission(fixture.image)).toMatchObject({ read: true, comment: true, edit: false });
		const generation = session.documentGeneration(fixture.image); expect(generation).toBeDefined();
		session.setForeground(false); await session.outbox.settled();
		const operations = [];
		for (const geometry of [{ type: "whole" }, { type: "pin", x: 0.25, y: 0.75 },
			{ type: "region", x: 0.1, y: 0.2, width: 0.4, height: 0.5 }] as ImageGeometry[]) {
			const anchor: ImageFileAnchor = { version: 1, type: "image_file", generation: generation!,
				asset: { kind: "managed", entry_id: fixture.image, sha256: "b".repeat(64) },
				basis: { width: 1200, height: 800, orientation: "display" }, geometry };
			const operation = { operationId: randomUUID(), scopeId: fixture.image, type: "thread.create" as const, dependsOn: [], payload: {
				type: "thread.create", thread_id: randomUUID(), message_id: randomUUID(), anchor: protocolJson(anchor), body: protocolJson(bodyFromText("Review the image file")) } };
			operations.push(operation); await session.queue(operation);
		}
		expect(await store.pending(fixture.image)).toHaveLength(3);
		expect((await transport.threads(fixture.image)).threads).toHaveLength(0);
		session.setForeground(true); await session.refresh(); await session.outbox.settled();
		for (const operation of operations) {
			expect((await store.getOperation(operation.operationId))?.state).toBe("accepted");
			const receipt = await transport.send(operation); expect(await transport.send(operation)).toEqual(receipt);
			const page = await transport.thread(fixture.image, receipt.thread_id);
			expect(page.anchor).toEqual(operation.payload.anchor);
		}
		expect((await transport.threads(fixture.image)).threads).toHaveLength(3);
		expect((await transport.threads(fixture.note)).threads).toHaveLength(0);
	} finally { await session.close(); }
}, 45000);
