/** @jest-environment jsdom */
import { DiscussionSearchPanel } from "../../src/collaboration/ui/DiscussionSearchPanel";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { DiscussionSearchPage } from "../../src/collaboration/DiscussionSearchProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); },
	setText(this: HTMLElement, value: string) { this.textContent = value; },
	getClientRects() { return [{ width: 400, height: 500 }]; },
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = { thread: { id: id(4), author_id: id(1), state: "open" as const, state_revision: 1, anchor_revision: 1, removed: false, created_sequence: 1, activity_sequence: 3, created_at: "2026-11-07T00:00:00Z" },
	entry_id: id(3), kind: "note" as const, path: "Notes/<private>.md", view_id: null, message_id: id(5), message_revision: 1, message_sequence: 3, excerpt: "<img src=x onerror=alert(1)> private words" };
const page: DiscussionSearchPage = { items: [item], next_cursor: null };
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function button(root: HTMLElement, text: string) { return Array.from(root.querySelectorAll("button")).find(value => value.textContent === text)!; }
function fixture() {
	let changed = () => {}, read = true;
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
	const root = document.createElement("div"); document.body.append(root);
	const session = { canSearch: true, status: "ready", permission: () => ({ read }), search: jest.fn().mockResolvedValue(page),
		onChange: (fn: () => void) => { changed = fn; return jest.fn(); } };
	const host = { openSearchResult: jest.fn().mockResolvedValue(undefined) };
	const panel = new DiscussionSearchPanel(root, session as unknown as DiscussionSession, id(3), host as unknown as DiscussionHost);
	const input = root.querySelector("input[type=search]") as HTMLInputElement;
	const submit = () => root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	return { panel, root, session, host, input, submit, changed: () => changed(), revoke: () => { read = false; changed(); },
		close: () => { panel.dispose(); root.remove(); } };
}

test("search is explicit, passes filters and opens safe plain-text results", async () => {
	const f = fixture();
	try {
		f.input.value = "private"; f.input.dispatchEvent(new Event("input", { bubbles: true }));
		expect(f.session.search).not.toHaveBeenCalled();
		const selects = f.root.querySelectorAll("select"); selects[0].value = "share"; selects[1].value = "resolved";
		(f.root.querySelectorAll("input[type=checkbox]")[0] as HTMLInputElement).checked = true;
		f.submit(); await flush();
		expect(f.session.search).toHaveBeenCalledWith({ query: "private", state: "resolved", mine: true, mentions: false, cursor: null, limit: 30 });
		expect(f.root.textContent).toContain(item.excerpt); expect(f.root.querySelector("img")).toBeNull(); expect(f.root.querySelector("private")).toBeNull();
		button(f.root, "Open matching comment").click(); await flush();
		expect(f.host.openSearchResult).toHaveBeenCalledWith(f.session, item, expect.any(Function));
	} finally { f.close(); }
});

test("changed searches coalesce behind one request and late responses never restore old excerpts", async () => {
	const f = fixture(); let release!: (value: DiscussionSearchPage) => void;
	f.session.search.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
	try {
		f.input.value = "old"; f.submit();
		f.input.value = "next"; f.input.dispatchEvent(new Event("input", { bubbles: true })); f.submit();
		f.input.value = "latest"; f.input.dispatchEvent(new Event("input", { bubbles: true })); f.submit();
		expect(f.session.search).toHaveBeenCalledTimes(1);
		f.session.search.mockResolvedValue({ items: [], next_cursor: null }); release(page); await flush();
		expect(f.session.search).toHaveBeenCalledTimes(2); expect(f.session.search).toHaveBeenLastCalledWith(expect.objectContaining({ query: "latest" }));
		expect(f.root.textContent).not.toContain(item.excerpt);
	} finally { f.close(); }
});

test("empty scan pages can continue and return to the previous page without unbounded fetching", async () => {
	const f = fixture(); f.session.search.mockResolvedValueOnce({ items: [], next_cursor: "opaque" });
	try {
		f.submit(); await flush(); expect(f.session.search).toHaveBeenCalledTimes(1);
		button(f.root, "Continue searching").click(); await flush();
		expect(f.session.search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "opaque" }));
		button(f.root, "Previous results").click(); await flush();
		expect(f.session.search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
	} finally { f.close(); }
});

test.each(["revocation", "logout", "dispose"])("%s clears content and fences a pending search", async reason => {
	const f = fixture();
	try {
		f.submit(); await flush(); expect(f.root.textContent).toContain(item.excerpt);
		let release!: (value: DiscussionSearchPage) => void;
		f.session.search.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); f.submit();
		if (reason === "revocation") f.revoke();
		if (reason === "logout") { f.session.canSearch = false; f.session.status = "authentication_required"; f.changed(); }
		if (reason === "dispose") f.panel.dispose();
		expect(f.root.textContent).not.toContain(item.excerpt); release(page); await flush();
		expect(f.root.textContent).not.toContain(item.excerpt);
	} finally { f.close(); }
});

test("visible refresh preserves focused results and backgrounding stops polling", async () => {
	jest.useFakeTimers(); const f = fixture();
	try {
		f.submit(); await flush(); const open = button(f.root, "Open matching comment"); open.focus();
		jest.advanceTimersByTime(15_000); await flush(); expect(f.session.search).toHaveBeenCalledTimes(2); expect(document.activeElement).toBe(open);
		Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange"));
		expect(f.root.textContent).not.toContain(item.excerpt); jest.advanceTimersByTime(60_000); await flush(); expect(f.session.search).toHaveBeenCalledTimes(2);
	} finally { f.close(); jest.useRealTimers(); }
});
