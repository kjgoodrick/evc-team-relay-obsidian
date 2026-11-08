/** @jest-environment jsdom */
import { TextEncoder } from "node:util";
import { RemovedCommentsPanel } from "../../src/collaboration/ui/RemovedComments";
import { bodyFromText } from "../../src/collaboration/DiscussionProtocol";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { ModerationHistory } from "../../src/collaboration/ModerationProtocol";

Object.assign(globalThis, { TextEncoder });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, value: string) { this.textContent = value; },
	appendText(this: HTMLElement, value: string) { this.append(this.ownerDocument.createTextNode(value)); },
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const history = (): ModerationHistory => ({ audit_id: id(9), thread_id: id(2), message_id: id(3), recoverable_until: new Date(Date.now() + 600_000).toISOString(),
	thread_removed: false, message_removed: true, thread_removal_reason: null, revisions: [
		{ revision: 1, body: { version: 1, blocks: [...bodyFromText("Retained <script>private text").blocks, { type: "picture", picture_id: id(8), alt: "Old diagram" }] }, actor_id: id(1), created_at: "2026-11-07T00:00:00Z", reason: null },
		{ revision: 2, body: null, actor_id: id(1), created_at: "2026-11-07T01:00:00Z", reason: "Synthetic removal reason" },
	], has_more: true, next_after: 2 });
async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function fixture(direct = false) {
	const parent = document.body.createDiv(), listeners = new Set<() => void>(); let allowed = true, generation = id(30), available = true;
	const session = { status: "ready", canReviewRemoved: () => allowed, displayName: () => "Alice", knownDocumentGeneration: () => generation,
		onChange: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
		reviewRemovedCatalog: jest.fn().mockResolvedValue({ audit_id: id(9), items: [{ thread_id: id(2), message_id: id(3), author_id: id(1),
			removed_at: "2026-11-07T00:00:00Z", recoverable_until: history().recoverable_until, thread_removed: false, message_removed: true, revision: 2 }], has_more: false, next_after: 1 }),
		reviewRemovedHistory: jest.fn().mockImplementation(async () => history()),
		reviewRemovedPicture: jest.fn().mockResolvedValue({ bytes: new ArrayBuffer(8), mime: "image/png", width: 2, height: 2, audit_id: id(10) }),
	};
	const panel = new RemovedCommentsPanel(parent, session as unknown as DiscussionSession, id(4), () => available,
		direct ? { threadId: id(2), messageId: id(3) } : undefined);
	const click = (text: string) => [...parent.querySelectorAll("button")].find(button => button.textContent === text)!.click();
	const reason = (text: string) => { const input = parent.querySelector<HTMLInputElement>("input[type=text]")!; input.value = text; input.dispatchEvent(new Event("input")); };
	const emit = () => listeners.forEach(fn => fn());
	return { parent, panel, session, listeners, click, reason, emit, revoke: () => { allowed = false; emit(); }, changeGeneration: () => { generation = id(31); emit(); },
		leave: () => { available = false; panel.validate(); }, close: () => { panel.dispose(); parent.remove(); } };
}
beforeEach(() => { Object.assign(URL, { createObjectURL: jest.fn(() => "blob:retained-picture"), revokeObjectURL: jest.fn() }); });
afterEach(() => { jest.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

test("requires an explicit reason, inventories metadata first, and loads history and pictures only on request", async () => {
	const f = fixture();
	try {
		await settle(); expect(f.session.reviewRemovedCatalog).not.toHaveBeenCalled(); f.click("Start review");
		expect(f.parent.textContent).toContain("Enter a plain-text reason"); expect(f.session.reviewRemovedCatalog).not.toHaveBeenCalled();
		f.reason("Investigate synthetic removal"); f.click("Start review"); await settle();
		expect(f.parent.textContent).toContain("Removed comment"); expect(f.parent.textContent).not.toContain("private text");
		f.click("Review history"); await settle();
		expect(f.parent.textContent).toContain("Retained <script>private text"); expect(f.parent.querySelector("script")).toBeNull();
		expect(f.parent.querySelectorAll("article")).toHaveLength(2); expect(f.parent.textContent).toContain("Synthetic removal reason");
		expect(f.session.reviewRemovedPicture).not.toHaveBeenCalled();
		f.click("Review picture: Old diagram"); await settle();
		expect(f.parent.querySelector("img")?.alt).toBe("Old diagram"); expect(f.parent.textContent).toContain("Picture audit: " + id(10));
		f.click("Review full-size picture"); await settle(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:retained-picture");
		expect(f.session.reviewRemovedPicture.mock.calls.map(call => call[5])).toEqual(["thumbnail", "content"]);
		f.click("Next revisions"); await settle(); expect(f.session.reviewRemovedHistory.mock.calls[1][4]).toBe(2);
		expect(f.parent.querySelector("img")).toBeNull();
	} finally { f.close(); }
});

test.each(["access", "hidden", "generation", "target", "reason", "dispose"])("clears content and rejects delayed history after %s", async change => {
	const f = fixture(true); let finish!: (page: ModerationHistory) => void;
	try {
		f.reason("Review"); f.click("Start review"); await settle();
		f.session.reviewRemovedHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.click("Next revisions"); await settle();
		if (change === "access") f.revoke();
		if (change === "hidden") { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); }
		if (change === "generation") f.changeGeneration();
		if (change === "target") f.leave();
		if (change === "reason") f.reason("Different reason");
		if (change === "dispose") f.panel.dispose();
		finish(history()); await settle(); expect(f.parent.textContent).not.toContain("private text"); expect(f.parent.querySelector("article")).toBeNull();
	} finally { f.close(); }
});

test("visible review expires without polling and clears decoded pictures and listeners on close", async () => {
	jest.useFakeTimers(); const f = fixture(true);
	try {
		f.reason("Review"); f.click("Start review"); await settle(); f.click("Review picture: Old diagram"); await settle();
		await jest.advanceTimersByTimeAsync(120_000);
		expect(f.parent.querySelector("img")).toBeNull(); expect(f.parent.textContent).not.toContain("private text");
		expect(f.session.reviewRemovedHistory).toHaveBeenCalledTimes(1); expect(f.session.reviewRemovedCatalog).not.toHaveBeenCalled();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:retained-picture");
	} finally { f.close(); expect(f.listeners.size).toBe(0); expect(jest.getTimerCount()).toBe(0); }
});

test("denied picture review clears already displayed history and never exposes error details", async () => {
	const f = fixture(true);
	try {
		f.reason("Review"); f.click("Start review"); await settle();
		f.session.reviewRemovedPicture.mockRejectedValue(new Error("private token or backend reason"));
		f.click("Review picture: Old diagram"); await settle();
		expect(f.parent.textContent).not.toContain("private"); expect(f.parent.querySelector("article")).toBeNull();
		expect(f.parent.textContent).toContain("Picture review unavailable");
	} finally { f.close(); }
});

test("late picture and repeated clicks cannot create extra requests or blob URLs", async () => {
	const f = fixture(true); let finish!: (value: unknown) => void;
	try {
		f.reason("Review"); f.click("Start review"); f.click("Start review"); await settle();
		expect(f.session.reviewRemovedHistory).toHaveBeenCalledTimes(1);
		f.session.reviewRemovedPicture.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.click("Review picture: Old diagram"); f.click("Review picture: Old diagram"); await settle();
		f.revoke(); finish({ bytes: new ArrayBuffer(1), mime: "image/png", width: 1, height: 1, audit_id: id(10) }); await settle();
		expect(f.session.reviewRemovedPicture).toHaveBeenCalledTimes(1); expect(URL.createObjectURL).not.toHaveBeenCalled();
	} finally { f.close(); }
});
