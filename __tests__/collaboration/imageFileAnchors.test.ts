import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { bodyFromText, parseAnchor, protocolJson, sourceAnchor, type ImageFileAnchor } from "../../src/collaboration/DiscussionProtocol";
import { DiscussionFailure, DiscussionTransport, queuedEnvelope } from "../../src/collaboration/DiscussionTransport";
import { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "image-file-test" };
const anchor = (): ImageFileAnchor => ({ version: 1, type: "image_file", generation: id(30),
	asset: { kind: "managed", entry_id: id(3), sha256: "a".repeat(64) },
	basis: { width: 800, height: 500, orientation: "display" }, geometry: { type: "pin", x: 0.25, y: 0.75 } });
const command = () => ({ operationId: id(4), scopeId: id(3), type: "thread.create" as const, dependsOn: [], payload: {
	type: "thread.create", thread_id: id(5), message_id: id(6), anchor: protocolJson(anchor()), body: protocolJson(bodyFromText("Saved pin")) } });
function remote() {
	return { identity, capabilities: jest.fn().mockResolvedValue({ discussions: true, imageFiles: true }),
		anchorContext: jest.fn().mockResolvedValue({ entryId: id(3), generation: id(30) }),
		permissions: jest.fn().mockResolvedValue({ read: true, comment: true, edit: false, moderate: false }),
		participants: jest.fn().mockResolvedValue({ participants: [], hasMore: false }),
		changes: jest.fn().mockResolvedValue({ events: [], cursor: "current", has_more: false }),
		send: jest.fn().mockRejectedValue(new DiscussionFailure("retry", "network_unavailable")),
	};
}

test("direct-image protocol binds the managed file and rejects external sources, invalid lineage and geometry", () => {
	expect(parseAnchor(anchor())).toEqual(anchor()); expect(sourceAnchor(anchor())).toBeUndefined();
	expect(JSON.parse(queuedEnvelope(id(2), command())).command.anchor).toEqual(anchor());
	expect(() => queuedEnvelope(id(2), { ...command(), scopeId: id(9) })).toThrow("invalid_local_anchor");
	expect(() => queuedEnvelope(id(2), { ...command(), payload: { ...command().payload, body: "x".repeat(65536) } })).toThrow("command_too_large");
	for (const change of [{ generation: "file.png" }, { asset: { kind: "external", url: "https://example.test/chart.png", version_evidence: "unknown" } },
		{ geometry: { type: "pin", x: true, y: 0 } }, { geometry: { type: "region", x: 0.8, y: 0, width: 0.5, height: 0.5 } },
		{ basis: { width: 0, height: 500, orientation: "display" } }]) expect(() => parseAnchor({ ...anchor(), ...change })).toThrow();
});

test("direct-image read responses are bound to their requested file", async () => {
	const thread = { id: id(5), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1,
		removed: false, created_sequence: 1, activity_sequence: 1, created_at: "2026-11-06T00:00:00Z" };
	const fetcher = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ thread, anchor: anchor(), messages: [], has_more: false, next_after: 0 })));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	expect((await transport.thread(id(3), id(5))).anchor).toEqual(anchor());
	await expect(transport.thread(id(9), id(5))).rejects.toMatchObject({ action: "pause", code: "invalid_read_response" });
});

test("image-file capability is independent of text barriers and rejects nonboolean advertisements", async () => {
	const fetcher = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ protocol_version: 1,
		features: { discussion_commands: true, discussion_image_files: true } })));
	const transport = new DiscussionTransport(identity, async () => ({ accountId: id(1), accessToken: "synthetic" }), fetcher);
	expect(await transport.capabilities()).toMatchObject({ discussions: true, textAnchors: false, imageFiles: true });
	fetcher.mockImplementation(async () => new Response(JSON.stringify({ protocol_version: 1,
		features: { discussion_commands: true, discussion_image_files: "true" } })));
	await expect(transport.capabilities()).rejects.toMatchObject({ code: "invalid_read_response" });
});

test("cached image-file context supports offline capture after restart without changing queued version evidence", async () => {
	const factory = new IDBFactory(), transport = remote();
	let store = await DiscussionStore.open(identity, factory), session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(id(3), () => {}, "image"); await session.refresh();
		expect(session.canAnchorText).toBe(false); expect(session.canAnchorImageFiles).toBe(true);
		expect(session.documentGeneration(id(3))).toBe(id(30));
		await session.close();
		transport.capabilities.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		transport.permissions.mockRejectedValue(new DiscussionFailure("retry", "network_unavailable"));
		store = await DiscussionStore.open(identity, factory); session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
		await session.start(); session.watch(id(3), () => {}, "image"); await session.refresh();
		session.setForeground(false); await session.outbox.settled();
		await store.saveDraft({ id: "image-draft", scopeId: id(3), revision: 0, body: "Saved pin", target: protocolJson(anchor()) });
		await session.queue(command(), { id: "image-draft", revision: 0 });
		expect((await store.getOperation(id(4)))?.payload).toEqual(command().payload);
		expect(await store.getDraft("image-draft")).toBeUndefined();
		transport.capabilities.mockResolvedValue({ discussions: true, imageFiles: true });
		transport.permissions.mockResolvedValue({ read: true, comment: true, edit: false, moderate: false });
		transport.anchorContext.mockResolvedValue({ entryId: id(3), generation: id(31) });
		session.setForeground(true); await session.refresh(); await session.outbox.settled();
		await expect(session.queue({ ...command(), operationId: id(9) })).rejects.toThrow("context");
		expect((await store.getOperation(id(4)))?.payload).toEqual(command().payload);
		transport.capabilities.mockResolvedValue({ discussions: true, imageFiles: false }); await session.refresh();
		await expect(session.queue({ ...command(), operationId: id(9) })).rejects.toThrow("not enabled");
		expect((await store.getOperation(id(4)))?.payload).toEqual(command().payload);
	} finally { await session.close(); }
});

test("file-kind confusion and current revocation cannot create an image-file discussion", async () => {
	const store = await DiscussionStore.open(identity, new IDBFactory()), transport = remote();
	const session = new DiscussionSession(store, transport as unknown as DiscussionTransport);
	try {
		await session.start(); session.watch(id(3), () => {}, "image"); await session.refresh();
		expect(() => session.watch(id(3), () => {}, "note")).toThrow("file type");
		await expect(session.queue({ ...command(), payload: { ...command().payload, anchor: { version: 1, type: "note" } } })).rejects.toThrow("target");
		transport.permissions.mockResolvedValue({ read: false, comment: false, edit: false, moderate: false }); await session.refresh();
		expect(session.documentGeneration(id(3))).toBeUndefined();
		expect(await store.preference("documentGeneration:" + id(3))).toBeUndefined();
		await expect(session.queue(command())).rejects.toThrow("permission");
		expect(await store.getOperation(id(4))).toBeUndefined();
	} finally { await session.close(); }
});
