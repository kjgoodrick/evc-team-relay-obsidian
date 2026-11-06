import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type Draft } from "../../src/collaboration/storage/DiscussionStore";
import { prepareLocalPicture, PICTURE_SOURCE_QUOTA } from "../../src/collaboration/PictureProtocol";
import { DiscussionTransport } from "../../src/collaboration/DiscussionTransport";

Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "draft-recovery" };
const entry = id(3), oldId = id(4), newId = id(5);
const raw = () => new TextEncoder().encode("Retained picture original").buffer;
const picture = (picture_id: string) => ({ type: "picture", picture_id, alt: "Preserved description" });
const draft = (): Draft => ({ id: "draft", scopeId: entry, revision: 0,
	body: { text: "Hi @Alice", mentions: [{ start: 3, end: 9, userId: id(1) }], pictures: [picture(oldId), picture(id(80))] },
	target: { version: 1, type: "note" } });
const operation = () => ({ operationId: id(6), scopeId: entry, payload: { type: "reply.create", thread_id: id(7), message_id: id(8),
	body: { version: 1, blocks: [picture(oldId)] }, reopen: true, expected_state_revision: 2 } });
let store: DiscussionStore, factory: IDBFactory;
beforeEach(async () => {
	factory = new IDBFactory(); store = await DiscussionStore.open(identity, factory);
	await store.saveDraft(draft(), null, [await prepareLocalPicture(oldId, entry, raw())]);
});
afterEach(() => store.close());

test("offline picture refresh preserves the complete draft and published pictures without enqueuing a send", async () => {
	const refreshed = await store.refreshDraftPictures("draft", 0, [{ oldId, newId }]);
	expect(refreshed).toEqual({ ...draft(), revision: 1, body: { ...draft().body as object, pictures: [picture(newId), picture(id(80))] } });
	expect(await store.pictureSource(oldId, entry)).toBeUndefined(); expect((await store.pictureSource(newId, entry))?.bytes).toEqual(raw());
	expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength); expect(await store.pending(entry)).toEqual([]);
	await expect(store.prepareOnlineDraft("draft", 0, operation())).rejects.toThrow("another view");
	await expect(store.saveDraft({ ...draft(), revision: 1, body: "Stale editor" }, 0)).rejects.toThrow("another view");
});

test("shared originals survive refresh and quota failure leaves every draft/reference intact", async () => {
	await store.saveDraft({ ...draft(), id: "other" }, null);
	await store.setPreference("pictureSourceBytes", PICTURE_SOURCE_QUOTA);
	await expect(store.refreshDraftPictures("draft", 0, [{ oldId, newId }])).rejects.toThrow("100 MiB");
	expect(await store.getDraft("draft")).toEqual(draft()); expect(await store.pictureSource(newId, entry)).toBeUndefined();
	await store.setPreference("pictureSourceBytes", raw().byteLength);
	await store.refreshDraftPictures("draft", 0, [{ oldId, newId }]);
	expect((await store.pictureSource(oldId, entry))?.bytes).toEqual(raw());
	expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength * 2);
});

test("unshared originals refresh at the quota limit without transiently doubling their charge", async () => {
	await store.setPreference("pictureSourceBytes", PICTURE_SOURCE_QUOTA);
	await store.refreshDraftPictures("draft", 0, [{ oldId, newId }]);
	expect(await store.preference("pictureSourceBytes")).toBe(PICTURE_SOURCE_QUOTA);
});

test("competing windows cannot replace a newer draft, reuse picture identities, or alter a pending online send", async () => {
	const other = await DiscussionStore.open(identity, factory);
	try {
		const outcomes = await Promise.allSettled([
			store.refreshDraftPictures("draft", 0, [{ oldId, newId }]), other.refreshDraftPictures("draft", 0, [{ oldId, newId: id(90) }]),
		]);
		expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(await store.preference("pictureSourceBytes")).toBe(raw().byteLength);
		const current = (await store.getDraft("draft"))!;
		await store.prepareOnlineDraft("draft", current.revision, operation());
		await expect(store.refreshDraftPictures("draft", current.revision, [{ oldId: newId, newId: id(91) }])).rejects.toThrow("unconfirmed");
		expect(await store.getDraft("draft")).toEqual(current);
	} finally { other.close(); }
});

test("withdrawal unlocks only the exact online intent and fences stale sends while retaining original bytes", async () => {
	const exact = await store.prepareOnlineDraft("draft", 0, operation());
	await expect(store.withdrawOnlineDraft("draft", 0, { ...exact, operationId: id(99) })).rejects.toThrow("changed");
	const recovered = await store.withdrawOnlineDraft("draft", 0, exact);
	expect(recovered).toEqual({ ...draft(), revision: 1 });
	expect(await store.preference("online:draft")).toBeUndefined(); expect(await store.pictureSource(oldId, entry)).toBeDefined();
	await expect(store.prepareOnlineDraft("draft", 0, exact)).rejects.toThrow("another view");
	await expect(store.completeOnlineDraft("draft", 0, exact.operationId)).rejects.toThrow("changed");
	await store.saveDraft({ ...recovered, revision: 2, body: "Reviewed reply" }, 1);
	expect(await store.pending(entry)).toEqual([]);
});

test("online withdrawal uses the original reopen envelope and validates accepted replies before clearing anything", async () => {
	const fetcher = jest.fn(), exact = operation();
	const transport = new DiscussionTransport(identity, async () => ({ accountId: identity.accountId, accessToken: "synthetic" }), fetcher);
	const result = { operation_id: exact.operationId, scope_id: id(12), thread_id: id(7), message_id: id(8), sequence: 3,
		state: "open", state_revision: 3, message_revision: 1, message_deleted: false, removed: false, changed: true };
	fetcher.mockResolvedValueOnce(new Response(JSON.stringify(result))); await transport.sendOnline(exact);
	fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: "accepted", result })));
	await expect(transport.withdrawOnline(exact)).resolves.toEqual({ status: "accepted", result });
	expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
	fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ status: "accepted", result: { ...result, message_id: id(99) } })));
	await expect(transport.withdrawOnline(exact)).rejects.toMatchObject({ code: "invalid_command_response" });
	fetcher.mockRejectedValueOnce(new Error("Lost response"));
	await expect(transport.withdrawOnline(exact)).rejects.toMatchObject({ action: "retry" });
	expect(await store.getDraft("draft")).toEqual(draft());
});
