/** @jest-environment jsdom */
import { TextEncoder } from "node:util";
import { CommentHistoryPanel, historyTextChanges } from "../../src/collaboration/ui/CommentHistory";
import { bodyFromText, type HistoryRevision, type HistoryWindow } from "../../src/collaboration/DiscussionProtocol";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";

Object.assign(globalThis, { TextEncoder });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, value: string) { this.textContent = value; },
	appendText(this: HTMLElement, value: string) { this.append(this.ownerDocument.createTextNode(value)); },
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const revision = (n: number, text = `Revision text ${n}`): HistoryRevision => ({ revision: n, body: bodyFromText(text), actor_id: id(1), created_at: "2026-11-07T12:00:00Z", reason: null });
const page = (n = 3, latest = 3): HistoryWindow => ({ latest, selected: revision(n), ...(n > 1 ? { previous: revision(n - 1) } : {}) });
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture() {
	const parent = document.body.createDiv(), listeners = new Set<() => void>();
	let readable = true;
	const session = { online: true, status: "ready", identity: { accountId: id(1) }, displayName: () => "Alice",
		permission: () => ({ read: readable, comment: readable, moderate: false }),
		onChange: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
		historyWindow: jest.fn().mockImplementation(async (_scope, _thread, _message, selected) => page(selected ?? 3)),
		cachedThread: jest.fn().mockResolvedValue({ id: id(2) }),
		cachedMessage: jest.fn().mockResolvedValue({ revision: 3, author_id: id(1), deleted: false }),
	};
	const panel = new CommentHistoryPanel(parent, session as unknown as DiscussionSession, id(4), id(2), id(3));
	const click = (text: string) => [...parent.querySelectorAll("button")].find(button => button.textContent === text)!.click();
	return { parent, panel, session, listeners, click, emit: () => listeners.forEach(fn => fn()), revoke: () => { readable = false; listeners.forEach(fn => fn()); },
		close: () => { panel.dispose(); parent.remove(); } };
}
afterEach(() => { jest.useRealTimers(); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });

test("opens the newest pair, navigates directly, keeps only two full revisions and shows the original revision", async () => {
	const f = fixture();
	try {
		await settle(); expect(f.parent.textContent).toContain("Revision 3 of 3");
		expect(f.parent.querySelectorAll("article")).toHaveLength(2);
		f.click("Previous revision"); await settle(); expect(f.parent.textContent).toContain("Revision 2 of 3");
		const input = f.parent.querySelector("input")!; input.value = "1";
		f.parent.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
		expect(f.parent.querySelectorAll("article")).toHaveLength(1); expect(f.parent.textContent).toContain("original comment");
		expect(f.session.historyWindow.mock.calls.map(call => call[3])).toEqual([undefined, 2, 1]);
	} finally { f.close(); }
});

test("compares whitespace and HTML as text and preserves full rich revisions for non-text changes", async () => {
	const f = fixture();
	try {
		await settle();
		f.session.historyWindow.mockResolvedValue({ latest: 4, selected: revision(4, "Safe  <img src=x>"), previous: revision(3, "Safe <script>") });
		f.click("Latest revision"); await settle();
		expect(f.parent.querySelectorAll("img,script")).toHaveLength(0);
		expect(f.parent.querySelector("ins")?.getAttribute("aria-label")).toContain("Added:");
		expect(f.parent.querySelector("del")?.getAttribute("aria-label")).toContain("Removed:");
		const rich = revision(5, "Same"); rich.body = { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Same", marks: ["bold"] }] }] };
		f.session.historyWindow.mockResolvedValue({ latest: 5, selected: rich, previous: revision(4, "Same") });
		f.click("Latest revision"); await settle(); expect(f.parent.textContent).toContain("No text changes"); expect(f.parent.querySelector("strong")?.textContent).toBe("Same");
	} finally { f.close(); }
});

test("large or divergent text uses bounded comparison and retains a full-revision fallback", () => {
	expect(historyTextChanges(bodyFromText("x".repeat(12_001)), bodyFromText("y".repeat(12_001)), () => "Alice")).toBeUndefined();
	expect(historyTextChanges(bodyFromText("a ".repeat(600)), bodyFromText("b ".repeat(600)), () => "Alice")).toBeUndefined();
	const changes = historyTextChanges(bodyFromText("a b"), bodyFromText("a  b"), () => "Alice")!;
	expect(changes.filter(change => !change.added).map(change => change.value).join("")).toBe("a b");
	expect(changes.filter(change => !change.removed).map(change => change.value).join("")).toBe("a  b");
});

test.each(["access", "logout", "hidden", "dispose"])("clears content on %s and rejects a delayed history response", async change => {
	const f = fixture();
	try {
		await settle(); let finish!: (result: HistoryWindow) => void;
		f.session.historyWindow.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		f.click("Latest revision"); await settle();
		if (change === "access") f.revoke();
		if (change === "logout") { f.session.status = "closed"; f.session.online = false; f.emit(); }
		if (change === "hidden") { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); }
		if (change === "dispose") f.panel.dispose();
		finish({ latest: 4, selected: revision(4, "Private late history") }); await settle();
		expect(f.parent.textContent).not.toContain("Private late history"); expect(f.parent.querySelector("article")).toBeNull();
	} finally { f.close(); }
});

test("a known deletion clears history for a reader and failed reauthorization cannot restore it", async () => {
	const f = fixture();
	try {
		await settle();
		f.session.cachedMessage.mockResolvedValue({ revision: 4, author_id: id(9), deleted: true }); f.emit(); await settle();
		expect(f.parent.querySelector("article")).toBeNull(); expect(f.parent.textContent).toContain("no longer available");
		f.session.historyWindow.mockRejectedValue(new Error("target_unavailable")); f.click("Refresh history"); await settle();
		expect(f.parent.querySelector("article")).toBeNull();
	} finally { f.close(); }
});

test.each([false, true])("deletion clears author/moderator history and releases picture listeners and decoded URLs (moderator=%s)", async moderate => {
	const f = fixture();
	f.session.permission = () => ({ read: true, comment: true, moderate });
	Object.assign(URL, { createObjectURL: jest.fn(() => "blob:history-picture"), revokeObjectURL: jest.fn() });
	Object.assign(f.session, { pictures: { load: jest.fn().mockResolvedValue({ bytes: new ArrayBuffer(8), mime: "image/png", width: 2, height: 2 }) } });
	try {
		await settle();
		const picture: HistoryRevision = { ...revision(4), body: { version: 1, blocks: [{ type: "picture", picture_id: id(8), alt: "Previous diagram" }] } };
		f.session.historyWindow.mockResolvedValue({ latest: 4, selected: picture, previous: revision(3) });
		f.click("Latest revision"); await settle();
		expect(f.listeners.size).toBe(2); expect(f.parent.querySelector("img")?.alt).toBe("Previous diagram");
		f.session.cachedMessage.mockResolvedValue({ revision: 5, author_id: id(1), deleted: true });
		f.session.historyWindow.mockResolvedValue({ latest: 5, selected: { ...revision(5), body: null, reason: "Removed by author" }, previous: picture });
		const calls = f.session.historyWindow.mock.calls.length;
		f.emit(); await settle(); expect(f.parent.textContent).not.toContain("Removed by author");
		expect(f.parent.querySelector("article")).toBeNull(); expect(f.parent.querySelector("img")).toBeNull();
		expect(f.session.historyWindow).toHaveBeenCalledTimes(calls);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:history-picture"); expect(f.listeners.size).toBe(1);
		f.panel.dispose(); expect(f.listeners.size).toBe(0); expect(f.parent.querySelector("img")).toBeNull();
	} finally { f.close(); }
});

test("visible refresh preserves focus and exact revision; hidden windows stop polling and disposal releases listeners", async () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		await settle(); f.click("Previous revision"); await settle();
		const input = f.parent.querySelector("input")!; input.focus(); input.value = "1";
		await jest.advanceTimersByTimeAsync(15_000);
		expect(f.parent.querySelector("input")).toBe(input); expect(document.activeElement).toBe(input); expect(input.value).toBe("1");
		expect(f.session.historyWindow).toHaveBeenLastCalledWith(id(4), id(2), id(3), 2);
		Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"));
		const count = f.session.historyWindow.mock.calls.length; await jest.advanceTimersByTimeAsync(60_000); expect(f.session.historyWindow).toHaveBeenCalledTimes(count);
		f.panel.dispose(); expect(f.listeners.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
	} finally { f.close(); }
});

test("coalesces navigation behind a refresh and ignores the superseded page", async () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		await settle(); let finish!: (value: HistoryWindow) => void;
		f.session.historyWindow.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		await jest.advanceTimersByTimeAsync(15_000); f.click("Previous revision");
		expect(f.session.historyWindow).toHaveBeenCalledTimes(2);
		finish(page(3)); await settle(); expect(f.session.historyWindow).toHaveBeenCalledTimes(3);
		expect(f.parent.textContent).toContain("Revision 2 of 3"); expect(f.parent.querySelectorAll("article")).toHaveLength(2);
	} finally { f.close(); }
});

test("an incoming edit preserves a focused revision input without taking focus from outside the history", async () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		await settle(); const input = f.parent.querySelector("input")!; input.focus(); input.value = "1";
		f.session.historyWindow.mockResolvedValue(page(4, 4)); await jest.advanceTimersByTimeAsync(15_000);
		expect(document.activeElement).toBe(f.parent.querySelector("input")); expect((document.activeElement as HTMLInputElement).value).toBe("1");
		expect(f.parent.textContent).toContain("Revision 4 of 4");
		const outside = document.body.createEl("button", { text: "Outside" }); outside.focus();
		try {
			f.session.historyWindow.mockResolvedValue(page(5, 5)); await jest.advanceTimersByTimeAsync(15_000);
			expect(document.activeElement).toBe(outside);
		} finally { outside.remove(); }
	} finally { f.close(); }
});
