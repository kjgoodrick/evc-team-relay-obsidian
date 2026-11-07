/** @jest-environment jsdom */
import { TextEncoder } from "node:util";
import type { App } from "obsidian";
import type { DiscussionSession, AnchoredThread } from "../../src/collaboration/DiscussionSession";
import { ReattachCommentModal, TargetHistoryModal, commentTargetDescription } from "../../src/collaboration/ui/ReattachComment";
import type { OnlineOperation } from "../../src/collaboration/DiscussionTransport";
import { DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); setTitle() {}
	open() { Object.assign(this, { selection: window.getSelection() }); void (this as unknown as { onOpen(): void }).onOpen(); }
	close() { (this as unknown as { onClose(): void }).onClose(); }
} }));
Object.assign(globalThis, { TextEncoder });
Object.assign(HTMLElement.prototype, { empty(this: HTMLElement) { this.replaceChildren(); } });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = { version: 1 as const, type: "note" as const };
const thread: AnchoredThread = { id: id(2), author_id: id(1), state: "resolved", state_revision: 3, anchor_revision: 1,
	removed: false, created_sequence: 1, activity_sequence: 3, created_at: "2026-11-07T00:00:00Z", anchor: note };
const op: OnlineOperation = { operationId: id(9), scopeId: id(4), payload: { type: "thread.reattach", thread_id: id(2), expected_anchor_revision: 1, anchor: note } };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(selected = false) {
	let active = true, readable = true;
	const listeners = new Set<() => void>(), hooks = { current: () => active, choose: jest.fn(), saved: jest.fn(), label: commentTargetDescription };
	const session = { online: true, canReattach: true, status: "ready", permission: () => ({ read: readable, comment: readable }),
		onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		pendingReattachment: jest.fn<Promise<OnlineOperation | undefined>, [string, string]>().mockResolvedValue(undefined),
		linkedThread: jest.fn().mockResolvedValue({ thread }), prepareReattachment: jest.fn().mockResolvedValue(op),
		sendReattachment: jest.fn().mockResolvedValue(undefined), recoverReattachment: jest.fn().mockResolvedValue("withdrawn"),
		captureBaseTarget: jest.fn(), displayName: () => "Alice", cachedThread: jest.fn().mockResolvedValue(thread),
		anchorHistory: jest.fn().mockResolvedValue({ thread, revisions: [{ revision: 1, actor_id: id(1), created_at: thread.created_at, anchor: note, unavailable: false }], has_more: false, next_after: 1 }),
	};
	const modal = new ReattachCommentModal({} as App, session as unknown as DiscussionSession, id(4), thread, hooks, selected ? note : undefined);
	document.body.append(modal.contentEl);
	const button = (label: string) => [...modal.contentEl.querySelectorAll("button")].find(button => button.textContent === label)!;
	return { modal, session, hooks, listeners, button, click: (label: string) => button(label).click(), emit: () => listeners.forEach(listener => listener()),
		revoke: () => { readable = false; listeners.forEach(listener => listener()); }, invalidate: () => { active = false; modal.validate(); },
		close: () => { modal.onClose(); modal.contentEl.remove(); } };
}

test("selecting a target does not send; the reviewed move retains its original state and expected revision", async () => {
	const f = fixture();
	try {
		await f.modal.onOpen(); f.click("Choose new target");
		expect(f.hooks.choose).toHaveBeenCalledWith(thread); expect(f.session.prepareReattachment).not.toHaveBeenCalled(); expect(f.session.sendReattachment).not.toHaveBeenCalled();
	} finally { f.close(); }
	const selected = fixture(true);
	try {
		await selected.modal.onOpen(); expect(selected.modal.contentEl.textContent).toContain("New target: Entire note");
		selected.click("Move discussion"); await flush();
		expect(selected.session.prepareReattachment.mock.calls[0].slice(0, 4)).toEqual([id(4), id(2), 1, note]);
		expect(selected.session.sendReattachment).toHaveBeenCalledWith(op, expect.any(Function)); expect(selected.hooks.saved).toHaveBeenCalledTimes(1);
	} finally { selected.close(); }
});

test("unconfirmed moves reopen with the original request and withdrawal requires a new selection", async () => {
	const f = fixture(true);
	try {
		f.session.pendingReattachment.mockResolvedValue(op);
		await f.modal.onOpen(); expect(f.button("Move discussion")).toBeUndefined();
		f.session.sendReattachment.mockRejectedValueOnce(new DiscussionFailure("reject", "stale_anchor_revision", 409));
		f.click("Retry move"); await flush(); expect(f.modal.contentEl.textContent).toContain("Someone moved this discussion");
		f.session.pendingReattachment.mockResolvedValue(undefined);
		f.click("Check outcome and cancel retry"); await flush();
		expect(f.session.recoverReattachment).toHaveBeenCalledWith(op, expect.any(Function));
		expect(f.button("Choose new target")).toBeDefined(); expect(f.button("Move discussion")).toBeUndefined();
		expect(f.session.prepareReattachment).not.toHaveBeenCalled(); expect(f.hooks.saved).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("closing during preparation prevents dispatch and clears selection details on account loss", async () => {
	const f = fixture(true);
	try {
		let finish!: (operation: OnlineOperation) => void;
		f.session.prepareReattachment.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		await f.modal.onOpen(); f.click("Move discussion"); f.invalidate(); finish(op); await flush();
		expect(f.session.sendReattachment).not.toHaveBeenCalled(); expect(f.modal.contentEl.textContent).toBe(""); expect(f.listeners.size).toBe(0);
	} finally { f.close(); }
});

test.each([403, 404])("a current %s response clears cached target details even before scope permission refresh", async status => {
	const f = fixture(true);
	try {
		f.session.linkedThread.mockRejectedValue(new DiscussionFailure("reject", "target_unavailable", status));
		await f.modal.onOpen();
		expect(f.modal.contentEl.textContent).toBe(""); expect(f.listeners.size).toBe(0);
		expect(f.session.prepareReattachment).not.toHaveBeenCalled(); expect(f.session.sendReattachment).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("unchanged sync updates preserve the focused move control while access changes still disable it", async () => {
	const f = fixture();
	try {
		await f.modal.onOpen(); const choose = f.button("Choose new target"); choose.focus();
		f.emit(); f.emit();
		expect(f.button("Choose new target")).toBe(choose); expect(document.activeElement).toBe(choose);
		f.session.online = false; f.emit(); expect(f.button("Choose new target").disabled).toBe(true);
	} finally { f.close(); }
});

test("history stops polling and drops historical target details while its document is hidden", async () => {
	jest.useFakeTimers();
	const f = fixture(), history = new TargetHistoryModal({} as App, f.session as unknown as DiscussionSession, id(4), id(2), commentTargetDescription, jest.fn());
	document.body.append(history.contentEl);
	try {
		history.onOpen(); await flush(); expect(f.session.anchorHistory).toHaveBeenCalledTimes(1);
		jest.advanceTimersByTime(15000); await flush(); expect(f.session.anchorHistory).toHaveBeenCalledTimes(2);
		const hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(true);
		try {
			document.dispatchEvent(new Event("visibilitychange"));
			expect(history.contentEl.textContent).not.toContain("Target revision");
			jest.advanceTimersByTime(60000); await flush(); expect(f.session.anchorHistory).toHaveBeenCalledTimes(2);
		} finally { hidden.mockRestore(); }
		document.dispatchEvent(new Event("visibilitychange")); await flush(); expect(f.session.anchorHistory).toHaveBeenCalledTimes(2);
	} finally { history.onClose(); history.contentEl.remove(); f.close(); jest.useRealTimers(); }
});

test("target history pages remain bounded and revoke/close fence delayed private results", async () => {
	const f = fixture(), history = new TargetHistoryModal({} as App, f.session as unknown as DiscussionSession, id(4), id(2), commentTargetDescription, jest.fn());
	document.body.append(history.contentEl);
	try {
		history.onOpen(); await flush(); expect(history.contentEl.textContent).toContain("Target revision 1");
		f.session.online = false; f.emit(); expect(history.contentEl.textContent).not.toContain("Target revision 1");
		f.session.online = true; f.emit();
		const refresh = [...history.contentEl.querySelectorAll("button")].find(button => button.textContent === "Refresh target history")!;
		expect(refresh.disabled).toBe(false);
		let finish!: (value: unknown) => void;
		f.session.anchorHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		refresh.click(); f.revoke(); finish({ thread, revisions: [{ revision: 1, actor_id: id(1), created_at: thread.created_at, anchor: note, unavailable: false }], has_more: false, next_after: 1 }); await flush();
		expect(history.contentEl.textContent).not.toContain("Target revision 1"); expect(history.contentEl.textContent).not.toContain("Alice");
	} finally { history.onClose(); history.contentEl.remove(); f.close(); }
});

// Obsidian Modal.open() stores the DOM Selection on its own `selection` field.
// This native behavior is not declared in the public Modal TypeScript API.
test("host modal selection bookkeeping cannot replace the discussion target", async () => {
	const f = fixture();
	try {
		f.modal.open(); await flush();
		expect(f.button("Choose new target")).toBeDefined();
		f.click("Use entire note"); await flush();
		expect(f.modal.contentEl.textContent).toContain("New target: Entire note");
		f.click("Move discussion"); await flush();
		expect(f.session.sendReattachment).toHaveBeenCalledWith(op, expect.any(Function));
	} finally { f.close(); }
});
