import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DiscussionStore, type Draft, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import { bodyFromText, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { editableCommentDraft } from "../../src/collaboration/ui/CommentDraft";
import type { WaitingCursor } from "../../src/collaboration/storage/LocalWorkPage";
Object.assign(globalThis, { IDBKeyRange });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "local-work-pages" };
const draft = (n: number): Draft => ({ id: id(n), scopeId: scope, revision: 0, body: { text: "Draft " + n, mentions: [] } });
const command = (n: number): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: "thread.create", dependsOn: [],
	payload: { type: "thread.create", thread_id: id(n + 100), message_id: id(n + 200), body: protocolJson(bodyFromText("Waiting " + n)), anchor: { version: 1, type: "note" } } });
let store: DiscussionStore;
beforeEach(async () => { store = await DiscussionStore.open(identity, new IDBFactory()); });
afterEach(() => store.close());

test("draft pages include recovery flags, bound reads and resume after a deleted boundary", async () => {
	for (let n = 10; n < 35; n++) await store.saveDraft(draft(n));
	await store.setPreference("online:" + id(10), "pending"); await store.setPreference("recovery:" + id(11), "review");
	const first = await store.localDraftPage(); expect(first.items).toHaveLength(10); expect(first.next).toBe(id(19));
	expect(first.items[0]).toMatchObject({ pendingSend: true, recovery: false }); expect(first.items[1]).toMatchObject({ pendingSend: false, recovery: true });
	await store.removeDraft(id(19), 0);
	const second = await store.localDraftPage(first.next), third = await store.localDraftPage(second.next);
	expect(second.items.map(item => item.draft.id)).toEqual(Array.from({ length: 10 }, (_, n) => id(20 + n)));
	expect(third.items).toHaveLength(5); expect(third.next).toBeUndefined();
	await expect(store.localDraftPage(undefined, 21)).rejects.toThrow("page size");
	await expect(store.localDraftPage("")).rejects.toThrow("cursor");
});

test("waiting pages traverse active states without accepted history or duplicate boundaries", async () => {
	for (let n = 10; n < 20; n++) { await store.enqueue(command(n), n); await store.accept(id(n), {}); }
	for (let n = 20; n < 27; n++) await store.enqueue(command(n), n);
	const rejected = await store.claimNext("worker", 100); await store.fail(rejected!.operationId, rejected!.lease!, "target_unavailable");
	const sending = await store.claimNext("worker", 100); expect(sending).toBeDefined();
	const review = await store.getOperation(id(22));
	await store.restoreCommandForReview(review!, protocolJson(editableCommentDraft(bodyFromText("Waiting 22"), () => "Member")));
	const seen: string[] = [], states: string[] = []; let after: WaitingCursor | undefined;
	do {
		const page = await store.waitingWorkPage(after, 2); expect(page.items.length).toBeLessThanOrEqual(2);
		seen.push(...page.items.map(item => item.operationId)); states.push(...page.items.map(item => item.state)); after = page.next;
	} while (after);
	expect(seen).toHaveLength(7); expect(new Set(seen).size).toBe(7); expect(seen.every(value => value >= id(20))).toBe(true);
	expect(states).toEqual(["review", "rejected", "sending", "queued", "queued", "queued", "queued"]);
	await expect(store.waitingWorkPage({ state: "accepted", id: id(10) } as unknown as WaitingCursor)).rejects.toThrow("state");
});

test("a boundary leaving the waiting index does not skip the next operation", async () => {
	for (let n = 10; n < 15; n++) await store.enqueue(command(n), n);
	const first = await store.waitingWorkPage(undefined, 2); await store.accept(first.next!.id, {});
	const next = await store.waitingWorkPage(first.next, 2);
	expect(next.items.map(item => item.operationId)).toEqual([id(12), id(13)]);
});

test("account context loss before or during a local save preserves the previous draft", async () => {
	await store.saveDraft(draft(10));
	await expect(store.saveDraft({ ...draft(10), revision: 1 }, 0, [], () => false)).rejects.toThrow("account changed");
	let checks = 0;
	await expect(store.saveDraft({ ...draft(10), revision: 1, body: "Changed" }, 0, [], () => ++checks === 1)).rejects.toThrow("account changed");
	expect(await store.getDraft(id(10))).toEqual(draft(10));
});
