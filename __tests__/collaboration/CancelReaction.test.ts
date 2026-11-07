/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { serialize, deserialize } from "node:v8";
import type { App } from "obsidian";
import { DiscussionStore, type QueuedCommand } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { PendingComments } from "../../src/collaboration/ui/PendingComments";
import { CancelReactionModal } from "../../src/collaboration/ui/CancelReaction";
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { IDBKeyRange, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = id(3), identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "cancel-reaction" };
const command = (n = 10): QueuedCommand => ({ operationId: id(n), scopeId: scope, type: "reaction.set", dependsOn: [],
	payload: { type: "reaction.set", thread_id: id(20), message_id: id(21), emoji: "thumbs_up", present: true } });
let store: DiscussionStore;
beforeEach(async () => { store = await DiscussionStore.open(identity, new IDBFactory()); });
afterEach(() => store.close());
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("Cancellation did not settle"); }

test("unattempted cancellation fences workers while accepted reactions remain accepted", async () => {
	const original = await store.enqueue(command()); expect(await store.retireReaction(original)).toBe("withdrawn");
	expect(await store.claimNext("worker")).toBeUndefined(); await store.accept(original.operationId, {});
	expect((await store.getOperation(original.operationId))?.state).toBe("withdrawn"); expect(await store.retireReaction(original)).toBe("withdrawn");
	const delivered = await store.enqueue(command(11)); await store.accept(delivered.operationId, {});
	expect(await store.retireReaction(delivered)).toBe("accepted");
});

test("attempted and rejected reactions require server withdrawal, even when retryable", async () => {
	const original = await store.enqueue(command(), 1), claimed = (await store.claimNext("worker", 2))!;
	expect(await store.retireReaction(original)).toBe("uncertain");
	await store.fail(original.operationId, claimed.lease!, "network", 3); expect(await store.retireReaction(original)).toBe("uncertain");
	expect(await store.retireReaction(original, true)).toBe("withdrawn");
	await store.fail(original.operationId, claimed.lease!, "late", 5); expect((await store.getOperation(original.operationId))?.state).toBe("withdrawn");
});

test("changed requests, active dependents and context loss never discard work", async () => {
	const original = await store.enqueue(command(), 1);
	await expect(store.retireReaction({ ...original, payload: { ...original.payload as object, present: false } })).rejects.toThrow("changed");
	let checks = 0; await expect(store.retireReaction(original, false, () => ++checks === 1)).rejects.toThrow("no longer current");
	expect((await store.getOperation(original.operationId))?.state).toBe("queued");
	await store.enqueue({ ...command(11), dependsOn: [original.operationId] }, 2);
	await expect(store.retireReaction(original, true)).rejects.toThrow("depends on"); expect((await store.getOperation(id(11)))?.state).toBe("queued");
});

test.each(["withdrawn", "accepted", "failed"])("confirmation reports %s without a replacement command", async outcome => {
	const operation = await store.enqueue(command()), listeners = new Set<() => void>();
	const cancel = jest.fn().mockImplementation(async () => { if (outcome === "failed") throw new Error("Delivery unknown"); return outcome; });
	const session = { status: "offline", cancelSavedReaction: cancel, onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
	const modal = new CancelReactionModal({} as App, session as unknown as DiscussionSession, operation, () => true);
	try {
		modal.onOpen(); const confirm = modal.contentEl.querySelector("button")!, check = modal.contentEl.querySelector("input")!;
		expect(confirm.disabled).toBe(true); expect(cancel).not.toHaveBeenCalled();
		check.checked = true; check.dispatchEvent(new Event("change")); confirm.click();
		await until(() => modal.contentEl.textContent!.includes(outcome === "withdrawn" ? "change cancelled" : outcome === "accepted" ? "already delivered" : "Cancellation is not confirmed"));
		expect(cancel).toHaveBeenCalledTimes(1); expect(confirm.disabled).toBe(outcome !== "failed");
	} finally { modal.onClose(); expect(listeners.size).toBe(0); }
});

test("account loss clears a cancellation modal and a late result cannot restore it", async () => {
	const operation = await store.enqueue(command()); let current = true, finish!: (value: string) => void;
	const session = { status: "ready", cancelSavedReaction: () => new Promise(resolve => { finish = resolve; }), onChange: () => () => {} };
	const modal = new CancelReactionModal({} as App, session as unknown as DiscussionSession, operation, () => current);
	modal.onOpen(); const check = modal.contentEl.querySelector("input")!; check.checked = true; check.dispatchEvent(new Event("change")); modal.contentEl.querySelector("button")!.click();
	current = false; modal.validate(); finish("withdrawn"); await new Promise(resolve => setTimeout(resolve, 0)); expect(modal.contentEl.textContent).toBe("");
});


test("pending reaction cards expose explicit cancellation without retrying the command", async () => {
	const operation = await store.enqueue(command()), review = jest.fn(), parent = document.createElement("div");
	const session = { online: false, participants: () => [], permission: () => undefined };
	const pending = new PendingComments(parent, session as unknown as DiscussionSession, scope, review);
	try {
		pending.update([operation]); const button = Array.from(parent.querySelectorAll("button")).find(item => item.textContent === "Cancel saved reaction")!;
		expect(button.disabled).toBe(false); button.click(); expect(review).toHaveBeenCalledWith(operation);
		expect((await store.getOperation(operation.operationId))?.state).toBe("queued");
	} finally { pending.dispose(); }
});
