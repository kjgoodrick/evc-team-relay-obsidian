import "fake-indexeddb/auto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { YSweetProvider } from "../../src/client/provider";
import { ProviderBacked } from "../../src/ProviderBacked";
import { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../../src/auth/RelayOnPremTokenProvider";
import { RemoteDocumentAddress } from "../../src/ResourceAddress";
import { SystemClock } from "../../src/Clock";
import type { AuthSession } from "../../src/AuthSession";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { LocalDocumentStore } from "../../src/storage/local-document-store";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { DiscussionOutbox } from "../../src/collaboration/DiscussionOutbox";
import { bodyFromText, localTextAnchor, protocolJson, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";
import { captureTextAnchor, resolveTextAnchor } from "../../src/collaboration/anchors/text";
import { prepareLocalPicture } from "../../src/collaboration/PictureProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const integration = process.env.EVC_COLD_RESTORE_FIXTURE ? test : test.skip;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string, timeout = 15_000) {
	const end = Date.now() + timeout;
	while (!check()) { if (Date.now() >= end) throw new Error("Timed out: " + label); await delay(25); }
}
class StoredDocument extends ProviderBacked {
	attachStore(store: LocalDocumentStore) { this.retainRestoreReviewIn(store); }
}

integration("cold backup and rollback retain actual CRDT, discussions and pictures while old clients stay fenced", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_COLD_RESTORE_FIXTURE!, "utf8")) as Record<string, string>;
	if (new URL(f.base).hostname !== "127.0.0.1") throw new Error("Only a disposable loopback fixture is allowed");
	const identity = { serverId: f.base, accountId: f.reviewerId, shareId: f.share, vaultId: randomUUID() };
	const transport = new DiscussionTransport(identity, async () => ({ accountId: f.reviewerId, accessToken: f.reviewerToken }), fetch);
	const store = await DiscussionStore.open(identity);
	const worker = new DiscussionOutbox(store, transport, "cold-restore-proof");
	const session = { getCurrentUserForServer: () => undefined, on: () => () => {} } as unknown as AuthSession;
	const auth = { getToken: () => f.ownerToken, getValidToken: async () => f.ownerToken } as IAuthProvider;
	const credentials = new RelayCredentialCache(session, new SystemClock(), "disposable", 5, new Map([
		["fixture", new RelayOnPremTokenProvider({ controlPlaneUrl: f.base, authProvider: auth })],
	]));
	const writer = new StoredDocument(f.note, new RemoteDocumentAddress("relay-onprem", f.share, f.note), credentials, session, "fixture");
	const documentStore = new LocalDocumentStore("cold-original-" + randomUUID(), writer.crdtDoc); writer.attachStore(documentStore);
	const providers: YSweetProvider[] = [], docs: Y.Doc[] = [];
	async function grant(token: string, mode: "read" | "write", generation?: string, entry = f.note, expected = 200) {
		const response = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: {
			Authorization: "Bearer " + token, "Content-Type": "application/json",
			...(generation ? { "X-Relay-Restore-Generation": generation } : {}),
		}, body: JSON.stringify({ share_id: f.share, doc_id: entry, mode }) });
		expect(response.status).toBe(expected);
		return response.json() as Promise<{ token: string; relay_url: string }>;
	}
	async function peer(generation?: string) {
		const auth = await grant(f.ownerToken, "write", generation), doc = new Y.Doc({ gc: false }); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		providers.push(provider); provider.connect(); await until(() => provider.synced, "document sync");
		return { doc, provider, text: doc.getText("contents"), auth };
	}
	const command = (payload: QueuedCommand["payload"], type: QueuedCommand["type"] = "thread.create", generation?: string): QueuedCommand => ({
		operationId: randomUUID(), scopeId: f.note, dependsOn: [], type, payload, ...(generation ? { restoreGeneration: generation } : {}),
	});
	async function restore(number: number) {
		writeFileSync(join(f.restartDir, `restore-${number}-request`), "restore");
		const done = join(f.restartDir, `restore-${number}-done`);
		await until(() => existsSync(done), "complete cold restore " + number, 240_000);
		return (JSON.parse(readFileSync(done, "utf8")) as { generation: string }).generation;
	}
	try {
		expect(await transport.permissions(f.note)).toEqual({ read: true, comment: true, edit: false, moderate: false });
		await expect(transport.threads(f.hidden)).rejects.toMatchObject({ status: 404 });
		expect(await writer.bringOnline()).toBe(true);
		await until(() => writer._liveProvider.synced, "original persisted writer");
		const text = writer.crdtDoc.getText("contents"); text.insert(0, "alpha beta gamma");
		const reader = await peer(); await until(() => reader.text.toString() === text.toString(), "initial CRDT bytes");
		const context = await transport.anchorContext(f.note);
		const anchor = wireTextAnchor(captureTextAnchor(reader.text, f.note, context.generation, 6, 10));
		const thread = randomUUID(), message = randomUUID(), pictureId = randomUUID();
		const source = await prepareLocalPicture(pictureId, f.note, new Uint8Array(readFileSync(f.picturePath)).buffer);
		await transport.uploadPicture(f.note, { type: "picture.upload", picture_id: pictureId, sha256: source.sha256, size: source.size }, source.bytes);
		const originalBody = { version: 1, blocks: [{ type: "picture", picture_id: pictureId, alt: "Cold backup proof" }] };
		const create = command(protocolJson({ type: "thread.create", thread_id: thread, message_id: message, anchor, body: originalBody }));
		await store.enqueue(create);
		const lossy = new DiscussionTransport(identity, async () => ({ accountId: f.reviewerId, accessToken: f.reviewerToken }), async (url, init) => {
			const response = await fetch(url, init);
			if (response.ok && init.method === "POST") { await response.text(); throw new Error("Synthetic lost accepted acknowledgment"); }
			return response;
		});
		await expect(lossy.send(create)).rejects.toMatchObject({ code: "network_unavailable" });
		expect((await transport.commandStatus(create)).status).toBe("accepted");
		await transport.send(command(protocolJson({ type: "message.edit", thread_id: thread, message_id: message, expected_revision: 1,
			body: bodyFromText("Edited before backup; picture retained in history") }), "message.edit"));
		await transport.send(command(protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Reply before backup") }), "reply.create"));
		await transport.send(command({ type: "reaction.set", thread_id: thread, message_id: message, emoji: "heart", present: true }, "reaction.set"));
		// A deletion changes the delete set without advancing the state vector.
		text.delete(0, 6); await until(() => reader.text.toString() === "beta gamma", "delete-only CRDT edit");
		const baseline = await transport.thread(f.note, thread), history = await transport.history(f.note, thread, message);
		expect(history.revisions[0].body).toEqual(originalBody);
		expect(baseline.messages[0].reactions).toContainEqual({ emoji: "heart", count: 1, mine: true });
		const picture = await transport.picture(f.note, pictureId);
		const pixels = await transport.pictureContent(f.note, pictureId, "content", picture.renditions.content!);
		const thumbnail = await transport.pictureContent(f.note, pictureId, "thumbnail", picture.renditions.thumbnail!);
		const unsent = command(protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Offline original reply") }), "reply.create");
		await store.enqueue(unsent);
		writer.goOffline(); text.insert(text.length, " OLD OFFLINE EDIT");
		const generation1 = await restore(1);
		const generations = [generation1];
		let postRestore: QueuedCommand | undefined;
		let current = await peer(generation1);
		for (let round = 0; round < 2; round++) {
			const generation = generations[round];
			expect(current.text.toString()).toBe("beta gamma");
			expect(await transport.anchorContext(f.note)).toEqual(context);
			expect(await transport.thread(f.note, thread)).toEqual(baseline);
			expect(await transport.history(f.note, thread, message)).toEqual(history);
			expect(await transport.picture(f.note, pictureId)).toEqual(picture);
			expect(new Uint8Array(await transport.pictureContent(f.note, pictureId, "content", picture.renditions.content!))).toEqual(new Uint8Array(pixels));
			expect(new Uint8Array(await transport.pictureContent(f.note, pictureId, "thumbnail", picture.renditions.thumbnail!))).toEqual(new Uint8Array(thumbnail));
			expect(resolveTextAnchor(current.text, f.note, context.generation, localTextAnchor(anchor))).toEqual({ status: "attached", from: 0, to: 4 });
			expect(await transport.permissions(f.note)).toEqual({ read: true, comment: true, edit: false, moderate: false });
			await expect(transport.threads(f.hidden)).rejects.toMatchObject({ status: 404 });
			await grant(f.reviewerToken, "read", generation, f.hidden, 403);
			await grant(f.reviewerToken, "write", generation, f.note, 403);
			await grant(f.ownerToken, "write", undefined, f.note, 409);
			await expect(transport.send(create)).rejects.toMatchObject({ code: "restore_generation_changed" });
			await expect(transport.send(unsent)).rejects.toMatchObject({ code: "restore_generation_changed" });
			expect((await transport.commandStatus(create)).status).toBe("accepted");
			expect(await transport.commandStatus(unsent)).toEqual({ status: "unknown" });
			await store.observeRestoreContext((await transport.capabilities()).restoreContext, round);
			worker.resume(); await worker.settled(); worker.stop();
			expect(await store.getOperation(unsent.operationId)).toMatchObject({ state: "rejected", error: "restore_generation_changed", payload: unsent.payload, attempt: 0 });
			if (!round) {
				await writer.bringOnline(); await until(() => writer.restoreReviewRequired, "old persistent client held after restore");
				expect(writer._liveProvider.shouldConnect).toBe(false);
				expect(text.toString()).toBe("beta gamma OLD OFFLINE EDIT");
				expect(await writer.bringOnline()).toBe(false);
				postRestore = command(protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("Accepted after first restore") }), "reply.create", generation);
				await transport.send(postRestore); await store.enqueue(postRestore);
				current.text.insert(current.text.length, " POST RESTORE EDIT");
				const observer = await peer(generation);
				await until(() => observer.text.toString() === current.text.toString(), "new-generation CRDT write");
				current.provider.disconnect();
				current.text.insert(current.text.length, " LATER OFFLINE EDIT");
				const generation2 = await restore(2); expect(generation2).not.toBe(generation1); generations.push(generation2);
				await grant(f.ownerToken, "write", generation1, f.note, 409);
				// The old restored client's valid, cached socket grant is fenced too.
				let closed = 0; current.provider.on("connection-close", (event: CloseEvent | null) => { closed = event?.code ?? 0; });
				current.provider.connect(); await until(() => closed === 4412, "first restore's cached socket grant rejected"); current.provider.disconnect();
				expect(current.text.toString()).toContain("LATER OFFLINE EDIT");
				current = await peer(generation2);
			} else {
				expect(postRestore).toBeDefined();
				await expect(transport.send(postRestore!)).rejects.toMatchObject({ code: "restore_generation_changed" });
				expect(await transport.commandStatus(postRestore!)).toEqual({ status: "unknown" });
				expect(await store.getOperation(postRestore!.operationId)).toMatchObject({ state: "rejected", error: "restore_generation_changed", restoreGeneration: generation1 });
				const fresh = command(protocolJson({ type: "reply.create", thread_id: thread, message_id: randomUUID(), body: bodyFromText("New work after rollback") }), "reply.create", generation);
				await transport.send(fresh);
				expect((await transport.thread(f.note, thread)).messages).toHaveLength(3);
			}
		}
	} finally {
		worker.stop(); await worker.settled(); store.close();
		writer.dismantle(); await documentStore.close(); writer.crdtDoc.destroy(); credentials.destroy();
		providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy());
	}
}, 600_000);
