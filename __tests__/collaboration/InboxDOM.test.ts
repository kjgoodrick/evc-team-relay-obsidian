/** @jest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { TextEncoder, TextDecoder } from "node:util";
import { serialize, deserialize } from "node:v8";
import { InboxView } from "../../src/collaboration/ui/InboxView";
import { ThreadSubscription } from "../../src/collaboration/ui/ThreadSubscription";
import { DiscussionInbox } from "../../src/collaboration/DiscussionInbox";
import { DiscussionStore } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { WorkspaceLeaf } from "obsidian";
import type { InboxItem } from "../../src/collaboration/InboxProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ setIcon: (el: HTMLElement, icon: string) => { el.textContent = ""; el.setAttribute("data-icon", icon); }, ItemView: class {
	containerEl = document.createElement("div"); contentEl = document.createElement("div");
	constructor() { this.containerEl.append(this.contentEl); document.body.append(this.containerEl); }
} }));
Object.assign(globalThis, { IDBKeyRange, TextEncoder, TextDecoder, structuredClone: (value: unknown) => deserialize(serialize(value)) });
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
	addClass(this: HTMLElement, name: string) { this.classList.add(name); },
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverId: "https://relay.test", accountId: id(1), shareId: id(2), vaultId: "inbox-dom" };
const item: InboxItem = { thread_id: id(3), entry_id: id(4), scope_id: id(5), message_id: id(6), kind: "note", view_id: null,
	path: "Notes/<One>.md", message_revision: 1, reason: "mention", last_sequence: 1, activity_at: "2026-11-06T01:00:00Z",
	version: 1, read_version: 0, dismissed_version: 0, unread: true, subscription: { version: 0, following: false, muted: false } };
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
	throw new Error("Inbox DOM did not settle");
}
function button(root: HTMLElement, label: string): HTMLButtonElement {
	const value = Array.from(root.querySelectorAll("button")).find(button => (button.getAttribute("aria-label") ?? button.textContent) === label);
	if (!value) throw new Error("Missing button " + label); return value;
}
async function fixture() {
	const store = await DiscussionStore.open(identity, new IDBFactory());
	await store.updateInbox(state => { state.items = [item]; state.subscriptions = [{ scopeId: id(4), threadId: id(3), value: item.subscription }]; });
	let changed = () => {}, active = true;
	const inbox = new DiscussionInbox(store, { inbox: jest.fn(), changeInbox: jest.fn(), inboxSubscription: jest.fn() }, () => changed());
	await inbox.configure(true, "offline", true);
	const session = { inbox, identity, online: false, status: "offline", refresh: jest.fn() } as unknown as DiscussionSession;
	const host = { inboxSources: () => active ? [{ session, label: "Server · Team" }] : [],
		onChange: (fn: () => void) => { changed = fn; return () => { changed = () => {}; }; }, openInboxItem: jest.fn().mockResolvedValue(undefined) };
	const view = new InboxView({} as WorkspaceLeaf, host as unknown as DiscussionHost); await view.onOpen();
	return { store, inbox, session, host, view, changed: () => changed(), logout: () => { active = false; changed(); },
		close: async () => { await view.onClose(); await inbox.close(); store.close(); view.containerEl.remove(); } };
}

test("opening the original discussion does not mark its notification read", async () => {
	const f = await fixture();
	try {
		expect(f.view.contentEl.textContent).toContain("Mention in Notes/<One>.md");
		expect(f.view.contentEl.querySelector("one")).toBeNull();
		button(f.view.contentEl, "Mention in Notes/<One>.md").click();
		await until(() => f.host.openInboxItem.mock.calls.length === 1);
		expect(f.host.openInboxItem).toHaveBeenCalledWith(f.session, expect.objectContaining({ thread_id: id(3) }));
		expect(f.inbox.pending).toEqual([]); expect(f.inbox.items[0].unread).toBe(true);
	} finally { await f.close(); }
});

test("explicit offline read updates the filter and retains a durable pending change", async () => {
	const f = await fixture();
	try {
		button(f.view.contentEl, "Mark read").click(); await until(() => f.inbox.pending.length === 1);
		expect(f.view.contentEl.querySelector("article")).toBeNull();
		const select = f.view.contentEl.querySelector("select")!; select.value = "all"; select.dispatchEvent(new Event("change"));
		expect(button(f.view.contentEl, "Mark unread")).toBeDefined();
		expect((await f.store.inboxState()).operations[0].change).toEqual({ type: "state", action: "read", seen_version: 1 });
	} finally { await f.close(); }
});

test("poll notifications preserve focused controls and account changes clear references immediately", async () => {
	const f = await fixture();
	try {
		const follow = button(f.view.contentEl, "Follow"); follow.focus(); f.changed();
		expect(document.activeElement).toBe(follow);
		f.logout(); expect(f.view.contentEl.textContent).not.toContain("Notes/<One>.md");
		expect(f.view.contentEl.querySelector("article")).toBeNull();
	} finally { await f.close(); }
});

test("muted and dismissed notifications stay out of the ordinary unread filter", async () => {
	const f = await fixture();
	try {
		button(f.view.contentEl, "Mute").click(); await until(() => f.inbox.pending.length === 1);
		expect(f.view.contentEl.querySelector("article")).toBeNull();
		const select = f.view.contentEl.querySelector("select")!; select.value = "muted"; select.dispatchEvent(new Event("change"));
		expect(button(f.view.contentEl, "Unmute")).toBeDefined();
		button(f.view.contentEl, "Dismiss").click(); await until(() => f.inbox.pending.length === 2);
		select.value = "dismissed"; select.dispatchEvent(new Event("change"));
		expect(button(f.view.contentEl, "Restore unread")).toBeDefined();
	} finally { await f.close(); }
});

test("thread follow controls queue preferences for a reader without edit permission", async () => {
	const f = await fixture(), parent = document.createElement("div"); document.body.append(parent);
	const controls = new ThreadSubscription(parent, f.session, id(4), id(3));
	try {
		button(parent, "Follow discussion").click(); await until(() => f.inbox.pending.length === 1);
		expect(button(parent, "Unfollow discussion")).toBeDefined();
		expect((await f.store.inboxState()).operations[0].change).toEqual({ type: "subscription", expected_version: 0, following: true, muted: false });
	} finally { controls.dispose(); parent.remove(); await f.close(); }
});

test("restored inbox choices explain why replay stopped and can keep the current server state", async () => {
	const f = await fixture();
	try {
		button(f.view.contentEl, "Mark read").click(); await until(() => f.inbox.pending.length === 1);
		await f.store.observeRestoreContext({ supported: true, generation: id(90) }, 0);
		await f.inbox.reload();
		expect(f.view.contentEl.textContent).toContain("saved before the service was restored");
		expect(f.view.contentEl.textContent).toContain("will not send automatically");
		expect(f.inbox.pending[0]).toMatchObject({ state: "rejected", error: "restore_generation_changed" });
		button(f.view.contentEl, "Keep server state").click(); await until(() => f.inbox.pending.length === 0);
		expect((await f.store.inboxState()).operations).toEqual([]);
	} finally { await f.close(); }
});
