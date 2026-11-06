/** @jest-environment jsdom */
import type { FileView } from "obsidian";
import { BaseCommentPane } from "../../src/collaboration/BaseComments";
import { NativeBasesSurface, type NativeBaseTarget } from "../../src/bases/NativeBasesSurface";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";

jest.mock("obsidian", () => ({ Component: class {}, FileView: class {}, Notice: class {}, apiVersion: "1.13.7" }));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rect = (left = 0, top = 0, width = 600, height = 400) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
beforeEach(() => {
	jest.useFakeTimers();
	jest.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [rect()] as unknown as DOMRectList);
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) { return this.dataset.cell ? rect(100, 120, 150, 30) : rect(); });
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers(); });
async function settle() { for (let i = 0; i < 4; i++) await jest.advanceTimersByTimeAsync(60); }
function fixture() {
	const root = document.createElement("div"), row = document.createElement("div"), cell = document.createElement("div"); cell.dataset.cell = "yes";
	root.append(row); row.append(cell); document.body.append(root);
	const file = { path: "Team/Plan.base", extension: "base" }, record = { path: "Team/Note.md", extension: "md" };
	const scope = baseDiscussionScope(id(1), id(2));
	let valid = true, comment = true, enabled = true, mounted = true, bound = true;
	const viewHandle = { target: { type: "view" }, element: root, current: () => valid };
	const itemHandle = { target: { type: "item", file: record }, element: row, current: () => valid };
	const cellHandle = { target: { type: "cell", file: record, property: { source: "note", name: "status" } }, element: cell, current: () => valid && mounted };
	const anchor: BaseAnchor = { version: 1, type: "base", definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1,
		target: { type: "cell", record_id: id(5), record_generation: id(6), property: { source: "note", name: "status" } } };
	const thread = { id: id(7), author_id: id(8), activity_sequence: 1, state: "open", anchor };
	const surface = { file, type: "table", current: () => valid, hit: (node: Node) => node === cell ? cellHandle : node === row ? itemHandle : undefined,
		handles: jest.fn(() => mounted ? [viewHandle, itemHandle, cellHandle] : [viewHandle, itemHandle]), viewport: () => root,
		reveal: jest.fn(async (_target: NativeBaseTarget, current: () => boolean) => current() ? "revealed" : "unavailable") };
	const session = { anchorThreads: jest.fn().mockResolvedValue([thread]), displayName: () => "Reviewer" };
	const releases: jest.Mock[] = [], contexts: BaseCommentContext[] = [];
	const host = { get nativeBasesCommentsEnabled() { return enabled; },
		baseCommentContext: jest.fn(async (_surface: NativeBasesSurface, alive: () => boolean) => {
			if (!bound) return undefined;
			let released = false; const release = jest.fn(() => { released = true; }); releases.push(release);
			const context = { file, session, entryId: scope, baseEntryId: id(1), surface,
				binding: { name: "Work", viewId: id(2), snapshot: { definition_id: id(3), generation: id(4), revision: 1 } },
				current: () => !released && valid && enabled && alive(), release, canComment: () => comment,
				selection: (target: NativeBaseTarget) => target.type === "view" || target.type === "property" ? target : target.type === "item" ? { type: "item", recordId: id(5) } : { type: "cell", recordId: id(5), property: target.property },
				native: (value: BaseAnchor) => value.view_id !== id(2) ? undefined : value.target.type === "item" ? itemHandle.target : cellHandle.target,
			} as unknown as BaseCommentContext;
			contexts.push(context); return context;
		}),
		verifyBaseTarget: jest.fn(async () => valid), commentBaseHandle: jest.fn(), openBaseThread: jest.fn(), openBaseView: jest.fn() };
	jest.spyOn(NativeBasesSurface, "inspect").mockImplementation(() => valid ? surface as unknown as NativeBasesSurface : undefined);
	const pane = new BaseCommentPane(host as unknown as DiscussionHost, { file, contentEl: root } as unknown as FileView);
	const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>(".relay-bases-comment-tools button"));
	return { root, row, cell, host, pane, surface, session, contexts, releases, anchor, cellHandle, buttons,
		readOnly() { comment = false; pane.invalidate(); }, disable() { enabled = false; pane.invalidate(); }, revoke() { valid = false; pane.invalidate(); },
		hideProperty() { mounted = false; pane.invalidate(); }, refuseBinding() { bound = false; }, close() { pane.close(); root.remove(); } };
}

test("inline cell and record controls preserve exact semantic targets and markers open the associated thread", async () => {
	const f = fixture();
	try {
		await settle(); expect(f.host.baseCommentContext).toHaveBeenCalledTimes(1);
		f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work", "Comment on cell · note.status", "Comment on record"]);
		f.buttons()[1].click(); expect(f.host.commentBaseHandle).toHaveBeenLastCalledWith(f.contexts[0], f.cellHandle);
		f.buttons()[2].click(); expect(f.host.commentBaseHandle).toHaveBeenLastCalledWith(f.contexts[0], f.cellHandle, { type: "item", file: f.cellHandle.target.file });
		f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!.click(); expect(f.host.openBaseThread).toHaveBeenCalledWith(f.contexts[0], id(7));
		f.buttons()[0].click(); expect(f.host.openBaseView).toHaveBeenCalledWith(f.contexts[0]);
	} finally { f.close(); }
});

test("layout changes reuse cached data and preserve marker focus while readonly access removes author controls", async () => {
	const f = fixture();
	try {
		await settle(); f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!.focus();
		f.root.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize")); f.row.classList.add("changed"); await settle();
		expect(f.host.baseCommentContext).toHaveBeenCalledTimes(1); expect(f.session.anchorThreads).toHaveBeenCalledTimes(1);
		expect(document.activeElement?.className).toBe("relay-base-comment-marker");
		f.readOnly(); await settle(); expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work"]);
		expect(f.root.querySelector(".relay-base-comment-marker")).not.toBeNull();
	} finally { f.close(); }
});

test("unchanged refreshes retain toolbar buttons, while a replacement handle gets a fresh action", async () => {
	const f = fixture();
	try {
		await settle(); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		const button = f.buttons()[1]; button.focus();
		f.pane.invalidate(); f.root.dispatchEvent(new Event("scroll")); await settle();
		expect(f.buttons()[1]).toBe(button); expect(document.activeElement).toBe(button);
		const next = { ...f.cellHandle };
		f.surface.hit = () => next; f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons()[1]).not.toBe(button); f.buttons()[1].click();
		expect(f.host.commentBaseHandle).toHaveBeenLastCalledWith(f.contexts[0], next);
		f.readOnly(); await settle(); expect(f.buttons().map(item => item.textContent)).toEqual(["Comments · Work"]);
	} finally { f.close(); }
});

test("focused author controls do not survive comment permission loss", async () => {
	const f = fixture();
	try {
		await settle(); f.buttons()[1].focus(); f.readOnly(); await settle();
		expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work"]);
	} finally { f.close(); }
});

test("hidden property discussions have explicit record markers without changing their targets", async () => {
	const f = fixture();
	try {
		await settle(); const before = JSON.stringify(f.anchor); f.hideProperty(); await settle();
		const marker = f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!;
		expect(marker.getAttribute("aria-label")).toContain("hidden property"); marker.click();
		expect(f.host.openBaseThread).toHaveBeenCalledWith(f.contexts[0], id(7)); expect(JSON.stringify(f.anchor)).toBe(before);
	} finally { f.close(); }
});

test.each(["revoke", "disable"] as const)("%s hides markers immediately and releases the retained context", async change => {
	const f = fixture();
	try {
		await settle(); f[change](); await settle();
		expect(f.root.querySelector<HTMLElement>(".relay-bases-comments")!.hidden).toBe(true);
		expect(f.root.querySelector(".relay-base-comment-marker")).toBeNull(); expect(f.releases[0]).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test("a binding that completes after close is released and cannot recreate controls or timers", async () => {
	const f = fixture(), original = f.host.baseCommentContext.getMockImplementation()!; let finish!: () => void;
	f.host.baseCommentContext.mockImplementation(async (surface, alive) => { const context = await original(surface, alive); await new Promise<void>(resolve => { finish = resolve; }); return context; });
	await settle(); expect(finish).toBeDefined(); f.pane.close(); finish(); await settle();
	expect(f.releases[0]).toHaveBeenCalledTimes(1); expect(f.root.querySelector(".relay-bases-comments")).toBeNull(); expect(jest.getTimerCount()).toBe(0); f.close();
});

test("a binding invalidated during its request is discarded before a replacement is mounted", async () => {
	const f = fixture(), original = f.host.baseCommentContext.getMockImplementation()!; let finish!: () => void;
	f.host.baseCommentContext.mockImplementationOnce(async (surface, alive) => { const context = await original(surface, alive); await new Promise<void>(resolve => { finish = resolve; }); return context; });
	try {
		await settle(); f.pane.invalidate(true, true); finish(); await settle();
		expect(f.releases[0]).toHaveBeenCalledTimes(1); expect(f.contexts[0].current()).toBe(false);
		expect(f.contexts[f.contexts.length - 1]?.current()).toBe(true); expect(f.root.querySelectorAll(".relay-bases-comments")).toHaveLength(1);
	} finally { f.close(); }
});

test("ready waits for native loading but does not repeatedly request a refused association", async () => {
	const f = fixture(); f.refuseBinding();
	try {
		const ready = f.pane.ready(); await settle(); expect(await ready).toBeUndefined();
		// One direct request and at most the constructor's already scheduled update.
		expect(f.host.baseCommentContext.mock.calls.length).toBeLessThanOrEqual(2);
	} finally { f.close(); }
});

test("manual input interrupts target navigation and shutdown releases all pane resources", async () => {
	const f = fixture(); let valid!: () => boolean;
	f.surface.reveal.mockImplementation(async (_target, current) => { valid = current; await Promise.resolve(); return current() ? "revealed" : "unavailable"; });
	await settle(); const reveal = f.pane.reveal(f.contexts[0], f.cellHandle.target as NativeBaseTarget);
	f.root.dispatchEvent(new Event("wheel")); expect(valid()).toBe(false); expect(await reveal).toBe("unavailable");
	f.close(); expect(f.releases[0]).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test("manual interaction during an earlier verification also cancels the later reveal", async () => {
	const f = fixture();
	try {
		await settle(); const navigating = f.pane.navigationGuard();
		f.root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(await f.pane.reveal(f.contexts[0], f.cellHandle.target as NativeBaseTarget, navigating)).toBe("unavailable");
	} finally { f.close(); }
});


test("record and cell discussions sharing one badge lane are grouped and native spacing is removed on close", async () => {
	const f = fixture();
	try {
		const original = (await f.session.anchorThreads())[0];
		f.session.anchorThreads.mockResolvedValue([original, { ...original, id: id(9), anchor: { ...f.anchor, target: { type: "item", record_id: id(5), record_generation: id(6) } } }]);
		await settle();
		expect(f.root.querySelectorAll(".relay-base-comment-marker")).toHaveLength(1);
		expect(f.root.querySelector(".relay-base-comment-marker")?.getAttribute("aria-label")).toContain("2 discussion(s)");
		expect(f.cell.classList.contains("relay-base-comment-target")).toBe(true);
		f.pane.close(); expect(f.cell.classList.contains("relay-base-comment-target")).toBe(false);
	} finally { f.close(); }
});
