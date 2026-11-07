/** @jest-environment jsdom */
import type { NativeBaseGroupComments } from "../../src/collaboration/NativeBaseGroupComments";
import type { FileView } from "obsidian";
import { BaseCommentPane } from "../../src/collaboration/BaseComments";
import { NativeBasesSurface, type NativeBaseTarget, type NativeBaseGroupHandle, type NativeBaseHandle, type NativeBaseGroupLocation } from "../../src/bases/NativeBasesSurface";
import type { BaseCommentContext } from "../../src/collaboration/BaseCommentContext";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { parseTimelineMarkerCatalog } from "../../src/collaboration/TimelineMarkerProtocol";
import type { PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";

const mockMenus: { title: string; click(): void }[][] = [];
jest.mock("obsidian", () => ({ Menu: class {
	items: { title: string; click(): void }[] = [];
	constructor() { mockMenus.push(this.items); }
	addItem(build: (item: unknown) => void) {
		const item = { title: "", click: () => {}, setTitle(title: string) { this.title = title; return this; }, onClick(click: () => void) { this.click = click; return this; } };
		build(item); this.items.push(item); return this;
	}
	showAtPosition() {}
}, Component: class {}, FileView: class {}, Notice: class {}, apiVersion: "1.13.7" }));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rect = (left = 0, top = 0, width = 600, height = 400) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
beforeEach(() => {
	mockMenus.length = 0; jest.useFakeTimers();
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
	const surface = { file, type: "table", current: () => valid, containsTargetArea: (node: Node) => row.contains(node), hit: (node: Node) => node === cell ? cellHandle : node === row ? itemHandle : undefined,
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
		verifyBaseTarget: jest.fn(async () => valid), commentBaseHandle: jest.fn(), commentBaseGroupHandle: jest.fn(), openBaseThread: jest.fn(), openBaseView: jest.fn() };
	jest.spyOn(NativeBasesSurface, "inspect").mockImplementation(() => valid ? surface as unknown as NativeBasesSurface : undefined);
	const targetsChanged = jest.fn();
	const pane = new BaseCommentPane(host as unknown as DiscussionHost, { file, contentEl: root } as unknown as FileView, undefined, targetsChanged);
	const buttons = () => Array.from(root.querySelectorAll<HTMLButtonElement>(".relay-bases-comment-tools button"));
	return { root, row, cell, host, pane, surface, session, contexts, releases, anchor, cellHandle, buttons, targetsChanged,
		readOnly() { comment = false; pane.invalidate(); }, disable() { enabled = false; pane.invalidate(); }, revoke() { valid = false; pane.invalidate(); },
		hideProperty() { mounted = false; pane.invalidate(); }, refuseBinding() { bound = false; }, close() { pane.close(); root.remove(); } };
}

test("inline cell and record controls preserve exact semantic targets and markers open the associated thread", async () => {
	const f = fixture();
	try {
		await settle(); expect(f.host.baseCommentContext).toHaveBeenCalledTimes(1);
		f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work", "Comment on cell · note.status", "Comment on record"]);
		f.buttons()[1].click(); expect(f.host.commentBaseHandle).toHaveBeenLastCalledWith(f.contexts[0], f.cellHandle); await settle();
		f.buttons()[2].click(); expect(f.host.commentBaseHandle).toHaveBeenLastCalledWith(f.contexts[0], f.cellHandle, { type: "item", file: f.cellHandle.target.file });
		f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!.click(); expect(f.host.openBaseThread).toHaveBeenCalledWith(f.contexts[0], id(7));
		f.buttons()[0].click(); expect(f.host.openBaseView).toHaveBeenCalledWith(f.contexts[0]);
	} finally { f.close(); }
});

test.each([false, true])("timeline toolbar and cached discussion markers preserve the saved axis without a network read on scroll (shared: %s)", async shared => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0]; context.binding.type = "sabidurian-timeline";
		const axis = { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "UTC" };
		const proof = { protocol_version: 1, entry_id: id(1), definition_id: id(3), generation: id(4), view_id: id(2), registry_revision: 1,
			axis: { id: id(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis } };
		const range = { version: 1, kind: "calendar", start: "2026-01-01", end: "2026-01-02", time_zone: "UTC", start_inclusive: true, end_inclusive: true };
		f.anchor.target = { type: "timeline_range", axis_definition_id: id(40), axis_definition_revision: 1, axis, range } as BaseAnchor["target"];
		if (shared) f.anchor.target = { type: "timeline_marker", marker_id: id(41), marker_revision: 1, axis_definition_id: id(40), axis_definition_revision: 1, axis,
			content: { kind: "range", label: "Launch", color: "#123abc", range } } as BaseAnchor["target"];
		let canComment = true;
		const readAxis = jest.fn().mockResolvedValue(proof), choose = jest.fn();
		Object.assign(f.session, { readTimelineAxis: readAxis, canAnchorBase: () => true, permission: () => ({ read: true, comment: canComment }) });
		Object.assign(f.surface, { rangeContext: () => ({ axis, effectiveTimeZone: "UTC", kinds: ["calendar"], current: () => true }),
			rangeGeometry: () => ({ startX: 100, endX: 300, top: 40, bottom: 60, discontinuous: false, current: () => true }) });
		Object.assign(f.host, { chooseTimelineRange: choose, chooseTimelineMarker: choose }); f.pane.invalidate(); await settle();
		f.buttons().find(button => button.textContent === (shared ? "Shared markers" : "Comment on range"))!.click(); expect(choose).toHaveBeenCalledWith(context);
		const marker = f.root.querySelector<HTMLButtonElement>(".relay-timeline-range-marker")!; expect(marker).not.toBeNull(); marker.click();
		expect(f.host.openBaseThread).toHaveBeenCalledWith(context, id(7)); const reads = readAxis.mock.calls.length;
		f.root.dispatchEvent(new Event("scroll")); await settle(); expect(readAxis).toHaveBeenCalledTimes(reads);
		if (shared) {
			const reveal = jest.fn().mockResolvedValue("revealed"); Object.assign(f.surface, { revealRange: reveal });
			expect(await f.pane.revealRange(context, f.anchor)).toBe("revealed"); expect(reveal).toHaveBeenCalledWith(range, axis, expect.any(Function), undefined);
		}
		canComment = false; f.pane.invalidate(); await settle(); expect(f.buttons().some(button => button.textContent === "Comment on range")).toBe(false);
		proof.axis.revision = 2; f.pane.invalidate(); await settle(); expect(f.root.querySelector(".relay-timeline-range-marker")).toBeNull();
	} finally { f.close(); }
});

test("a timeline pane shows shared markers without threads and scrolling never rereads metadata", async () => {
	const f = fixture(); await settle();
	try {
		const context = f.contexts[0], axis = { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "UTC" };
		Object.assign(context.binding, { type: "sabidurian-timeline" });
		const proof = { protocol_version: 1, entry_id: id(1), definition_id: id(3), generation: id(4), view_id: id(2), registry_revision: 1,
			axis: { id: id(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis } };
		const content = { kind: "point", label: "Shared launch", color: "#123abc", range: { version: 1, kind: "calendar", start: "2026-11-07", end: "2026-11-07", time_zone: "UTC", start_inclusive: true, end_inclusive: true } };
		const { axis: _axis, ...common } = proof;
		const catalog = parseTimelineMarkerCatalog({ ...common, catalog_revision: 1, markers: [{ id: id(60), revision: 1, active: true, content,
			placement: { view_id: id(2), active: true, axis_definition_id: id(40), axis_definition_revision: 1, axis },
			target: { type: "timeline_marker", marker_id: id(60), marker_revision: 1, axis_definition_id: id(40), axis_definition_revision: 1, axis, content } }] }, id(1), id(2));
		const metadata = jest.fn().mockResolvedValue({ axis: proof, catalog }), choose = jest.fn();
		Object.assign(f.session, { readTimelineMarkerMetadata: metadata, permission: () => ({ read: true, comment: true }), canAnchorBase: () => true });
		f.session.anchorThreads.mockResolvedValue([]); Object.assign(f.host, { chooseTimelineMarker: choose });
		Object.assign(f.surface, { rangeContext: () => ({ axis, effectiveTimeZone: "UTC", kinds: ["calendar"], current: () => true }),
			rangeGeometry: () => ({ startX: 100, endX: 100, top: 40, bottom: 60, discontinuous: false, current: () => true }) });
		f.pane.invalidate(); await settle();
		const marker = f.root.querySelector<HTMLButtonElement>(".relay-timeline-shared-marker-button")!; expect(marker.textContent).toBe("Shared launch");
		marker.click(); expect(choose).toHaveBeenCalledWith(context, id(60));
		const reads = metadata.mock.calls.length; f.root.dispatchEvent(new Event("scroll")); await settle(); expect(metadata).toHaveBeenCalledTimes(reads);
		metadata.mockResolvedValue({ axis: proof, catalog: { ...catalog, catalog_revision: 2, markers: [] } }); f.pane.invalidate(); await settle();
		expect(f.root.querySelector(".relay-timeline-shared-marker-button")).toBeNull(); marker.click(); expect(choose).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test.each(["available", "missing", "duplicate"])("pending range navigation requires the exact lane: %s", async state => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0];
		const pending: PendingBaseGroupAnchor = { version: 1, type: "base_group_pending", entry_id: id(1), property: { source: "note", name: "status" },
			capture: { operation_id: id(40), definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1, group_definition_id: id(41), group_definition_revision: 1,
				record_id: id(5), record_generation: id(6), dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Ready" } },
			range: { type: "timeline_range", axis_definition_id: id(42), axis_definition_revision: 1,
				axis: { version: 1, renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null },
				range: { version: 1, kind: "ordinal", start: "1", end: "2", unit: "property-value", start_inclusive: true, end_inclusive: true } } };
		const lane: NativeBaseGroupHandle = { target: { type: "group", property: pending.property, value: { type: "text", value: "Ready" } }, element: f.row,
			ambiguous: false, current: () => true, members: () => [] };
		const native = jest.fn().mockResolvedValue(lane.target), reveal = jest.fn().mockReturnValue("revealed");
		context.groups = { native, handles: () => state === "missing" ? [] : state === "duplicate" ? [lane, lane] : [lane] } as unknown as NativeBaseGroupComments;
		Object.assign(f.surface, { revealRange: reveal });
		expect(await f.pane.revealRange(context, pending)).toBe(state === "available" ? "revealed" : "hidden");
		expect(native).toHaveBeenCalledWith(pending);
		if (state === "available") expect(reveal).toHaveBeenCalledWith(pending.range!.range, pending.range!.axis, expect.any(Function), f.row);
		else expect(reveal).not.toHaveBeenCalled();
	} finally { f.close(); }
});

function annotation(f: ReturnType<typeof fixture>) {
	let select: (handle: NativeBaseHandle) => void = () => {}, stopped: () => void = () => {};
	let group: ((location: NativeBaseGroupLocation) => void) | undefined;
	const stop = jest.fn(() => stopped());
	const begin = jest.fn((chosen: typeof select, finished: typeof stopped, selectedGroup?: typeof group): (() => void) | undefined => { select = chosen; stopped = finished; group = selectedGroup; return stop; });
	Object.assign(f.surface, { type: "sabidurian-timeline", annotationSupported: true, beginAnnotation: begin });
	return { begin, stop, deliver: () => select(f.cellHandle as NativeBaseHandle), finish: () => { stop(); select(f.cellHandle as NativeBaseHandle); },
		lane: () => { stop(); group?.({ group: {}, element: f.row, current: () => true, reveal: () => "revealed" }); } };
}

test.each([true, false])("explicit lane selection offers typed choices or an unavailable state (supported: %s)", async supported => {
	const f = fixture(), a = annotation(f);
	try {
		await settle(); const context = f.contexts[0];
		const handles: NativeBaseGroupHandle[] = [
			{ target: { type: "group", property: { source: "note", name: "status" }, value: { type: "number", value: 1 } }, element: f.row, ambiguous: true, current: () => true, members: () => [] },
			{ target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "1" } }, element: f.row, ambiguous: true, current: () => true, members: () => [] },
		];
		context.groups = { hit: () => supported ? handles : [], handles: () => handles, canCapture: () => true } as unknown as NativeBaseGroupComments;
		f.buttons().find(button => button.textContent === "Select timeline target")!.click(); a.lane();
		expect(f.buttons().some(button => button.textContent === "Comment on view")).toBe(false);
		expect(f.host.commentBaseHandle).not.toHaveBeenCalled();
		if (supported) {
			f.buttons().find(button => button.textContent === "Choose group value to comment")!.click();
			expect(mockMenus.at(-1)?.map(item => item.title)).toEqual(["1 (number)", '"1" (text)']);
			mockMenus.at(-1)![1].click(); expect(f.host.commentBaseGroupHandle).toHaveBeenCalledWith(context, handles[1]);
		} else expect(f.root.querySelector('[role="status"]')?.textContent).toContain("lane is unavailable");
	} finally { f.close(); }
});

test("timeline annotation requires explicit entry, preserves selection identity and reuses cached discussions while panning", async () => {
	const f = fixture(), a = annotation(f);
	try {
		await settle(); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons().some(button => button.textContent === "Comment on cell · note.status")).toBe(false);
		f.buttons().find(button => button.textContent === "Select timeline target")!.click();
		expect(a.begin).toHaveBeenCalledTimes(1); expect(f.root.querySelector('[role="status"]')?.textContent).toContain("Touch drag pans");
		for (let n = 0; n < 10; n++) f.root.dispatchEvent(new Event("scroll")); await settle();
		expect(f.session.anchorThreads).toHaveBeenCalledTimes(1); expect(f.host.baseCommentContext).toHaveBeenCalledTimes(1);
		a.finish();
		f.buttons().find(button => button.textContent === "Comment on cell · note.status")!.click();
		expect(f.host.commentBaseHandle).toHaveBeenCalledWith(f.contexts[0], f.cellHandle);
		expect(f.buttons().some(button => button.textContent === "Cancel target selection")).toBe(false);
	} finally { f.close(); }
});

test.each(["readOnly", "disable", "revoke", "close"] as const)("timeline annotation stops on %s and late selection cannot create a comment", async action => {
	const f = fixture(), a = annotation(f);
	try {
		await settle(); f.buttons().find(button => button.textContent === "Select timeline target")!.click();
		f[action](); await settle(); expect(a.stop).toHaveBeenCalledTimes(1);
		a.deliver(); f.pane.comment(); expect(f.host.commentBaseHandle).not.toHaveBeenCalled();
		expect(f.buttons().some(button => button.textContent === "Cancel target selection")).toBe(false);
	} finally { f.close(); }
});

test("timeline entry refusal and explicit cancellation leave ordinary comment controls usable", async () => {
	const f = fixture(), a = annotation(f);
	try {
		a.begin.mockImplementationOnce(() => undefined);
		await settle(); f.buttons().find(button => button.textContent === "Select timeline target")!.click();
		expect(f.buttons().some(button => button.textContent === "Cancel target selection")).toBe(false);
		f.buttons().find(button => button.textContent === "Select timeline target")!.click();
		f.buttons().find(button => button.textContent === "Cancel target selection")!.click();
		expect(a.stop).toHaveBeenCalledTimes(1);
		f.buttons().find(button => button.textContent === "Comment on view")!.click(); expect(f.host.commentBaseHandle).toHaveBeenCalledTimes(1);
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

test("a mixed group header offers typed choices and never falls back to a record or whole-view comment", async () => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0];
		const handles: NativeBaseGroupHandle[] = [
			{ target: { type: "group", property: { source: "note", name: "status" }, value: { type: "number", value: 1 } }, element: f.row, ambiguous: true, current: () => true, members: () => [] },
			{ target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "1" } }, element: f.row, ambiguous: true, current: () => true, members: () => [] },
		];
		context.groups = { hit: () => handles, handles: () => handles, canCapture: () => true } as unknown as NativeBaseGroupComments;
		f.row.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		const button = f.buttons().find(button => button.textContent === "Choose group value to comment")!;
		expect(button).toBeDefined(); expect(f.buttons().some(button => button.textContent === "Comment on view")).toBe(false);
		button.click(); expect(mockMenus.at(-1)?.map(item => item.title)).toEqual(["1 (number)", '"1" (text)']);
		mockMenus.at(-1)![1].click(); expect(f.host.commentBaseGroupHandle).toHaveBeenCalledWith(context, handles[1]);
		expect(f.host.commentBaseHandle).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["cell", "group"] as const)("native container focus during a %s pointer gesture retains the exact target, while later focus changes clear it", async kind => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0];
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Ready" } },
			element: f.row, ambiguous: false, current: () => true, members: () => [] };
		context.groups = { hit: (node: Node) => node === f.row && kind === "group" ? [handle] : [], handles: () => [handle], canCapture: () => true } as unknown as NativeBaseGroupComments;
		const target = kind === "group" ? f.row : f.cell;
		const selected = () => f.buttons().find(button => button.textContent?.startsWith(kind === "group" ? "Comment on group" : "Comment on cell"));
		target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		f.root.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(selected()).toBeDefined(); selected()!.click();
		if (kind === "group") expect(f.host.commentBaseGroupHandle).toHaveBeenCalledWith(context, handle);
		else expect(f.host.commentBaseHandle).toHaveBeenCalledWith(context, f.cellHandle);
		window.dispatchEvent(new Event("pointerup"));
		f.root.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(selected()).toBeUndefined();
		target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		f.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		f.root.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(selected()).toBeUndefined();
	} finally { f.close(); }
});

test("group markers deduplicate target verification, share a header badge and navigate through the group adapter", async () => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0];
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Done" } },
			element: f.row, ambiguous: false, current: () => true, members: () => [] };
		const native = jest.fn().mockResolvedValue(handle.target), reveal = jest.fn((_target, current) => current() ? "revealed" : "unavailable");
		context.groups = { handles: () => [handle], hit: () => [handle], canCapture: () => true, native, reveal } as unknown as NativeBaseGroupComments;
		const anchor = { ...f.anchor, target: { type: "group", definition_id: id(10), definition_revision: 1, property: handle.target.property,
			value: handle.target.value, group_id: id(11), witness_id: id(12) } };
		f.session.anchorThreads.mockResolvedValue([id(20), id(21)].map(id => ({ id, author_id: null, state: "open", anchor })));
		f.pane.invalidate(); await settle();
		expect(native).toHaveBeenCalledTimes(1);
		const badge = f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!;
		expect(badge.textContent).toBe("2"); expect(badge.getAttribute("aria-label")).toContain('group · "Done" (text)');
		expect(await f.pane.reveal(context, handle.target)).toBe("revealed"); expect(reveal).toHaveBeenCalled();
		expect(f.surface.reveal).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("group status uses exact current local targets, not stale anchors, hidden or ambiguous handles, and scroll does not repeat checks", async () => {
	const f = fixture();
	try {
		await settle(); f.targetsChanged.mockClear(); const context = f.contexts[0]; let current = true, visible = true, duplicate = false;
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Done" } },
			element: f.row, ambiguous: false, current: () => current, members: () => [] };
		const native = jest.fn().mockResolvedValue(handle.target);
		context.groups = { handles: () => visible ? duplicate ? [handle, handle] : [handle] : [], hit: () => [handle], canCapture: () => true, native } as unknown as NativeBaseGroupComments;
		const anchor = { ...f.anchor, target: { type: "group", definition_id: id(10), definition_revision: 1, property: handle.target.property,
			value: { type: "text", value: "Done" }, group_id: id(11), witness_id: id(12) } } as BaseAnchor;
		const threads = [{ id: id(20), author_id: null, state: "open" as const, anchor, state_revision: 1, anchor_revision: 1,
			removed: false, created_sequence: 1, activity_sequence: 1, created_at: "2026-11-07T00:00:00Z" }];
		f.session.anchorThreads.mockResolvedValue(threads as never); f.pane.invalidate(); await settle();
		const present = () => f.pane.presentTargets(context.session, context.entryId, threads);
		expect(present()).toEqual(new Set([id(20)])); expect(f.targetsChanged).toHaveBeenCalledTimes(1);
		const reads = f.session.anchorThreads.mock.calls.length;
		f.root.dispatchEvent(new Event("scroll")); await settle();
		expect(f.targetsChanged).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1); expect(f.session.anchorThreads).toHaveBeenCalledTimes(reads);
		expect(f.pane.presentTargets(context.session, context.entryId, [{ ...threads[0], anchor: { ...anchor, registry_revision: 2 } }])).toEqual(new Set());
		expect(f.pane.presentTargets(context.session, baseDiscussionScope(id(1), id(99)), threads)).toEqual(new Set());
		current = false; expect(present()).toEqual(new Set()); f.pane.invalidate(false); await settle(); expect(f.targetsChanged).toHaveBeenCalledTimes(2);
		current = true; duplicate = true; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set());
		duplicate = false; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set([id(20)])); expect(f.targetsChanged).toHaveBeenCalledTimes(3);
		visible = false; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set()); expect(f.targetsChanged).toHaveBeenCalledTimes(4);
		visible = true; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set([id(20)]));
		f.revoke(); expect(present()).toEqual(new Set()); expect(f.targetsChanged).toHaveBeenCalledTimes(6);
	} finally { f.close(); }
});

test("lane-range status loses positive evidence when the captured lane disappears or the native axis changes", async () => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0]; context.binding.type = "sabidurian-timeline"; let present = true;
		const axis = { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "UTC" };
		const proof = { protocol_version: 1, entry_id: id(1), definition_id: id(3), generation: id(4), view_id: id(2), registry_revision: 1,
			axis: { id: id(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis } };
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Ready" } },
			element: f.row, ambiguous: false, current: () => present, members: () => [] };
		context.groups = { handles: () => present ? [handle] : [], native: jest.fn().mockResolvedValue(handle.target), canCapture: () => true } as unknown as NativeBaseGroupComments;
		f.anchor.target = { type: "timeline_range", axis_definition_id: id(40), axis_definition_revision: 1, axis,
			range: { version: 1, kind: "calendar", start: "2026-01-01", end: "2026-01-02", time_zone: "UTC", start_inclusive: true, end_inclusive: true },
			lane: { ...handle.target, definition_id: id(10), definition_revision: 1, group_id: id(11), witness_id: id(12) } } as BaseAnchor["target"];
		Object.assign(f.session, { readTimelineAxis: jest.fn().mockResolvedValue(proof), canAnchorBase: () => true, permission: () => ({ read: true, comment: true }) });
		Object.assign(f.surface, { rangeContext: () => ({ axis, effectiveTimeZone: "UTC", kinds: ["calendar"], current: () => true }),
			rangeGeometry: () => ({ startX: 100, endX: 300, top: 40, bottom: 60, discontinuous: false, current: () => true }) });
		f.pane.invalidate(); await settle(); const threads = await f.session.anchorThreads();
		expect(f.pane.presentTargets(context.session, context.entryId, threads)).toEqual(new Set([id(7)]));
		present = false; f.pane.invalidate(false); await settle(); expect(f.pane.presentTargets(context.session, context.entryId, threads)).toEqual(new Set());
		present = true; proof.axis.revision = 2; f.pane.invalidate(); await settle();
		expect(f.pane.presentTargets(context.session, context.entryId, threads)).toEqual(new Set());
	} finally { f.close(); }
});

test("cell evidence requires its exact live handle; a row fallback, duplicate or recycled file object cannot confirm it", async () => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0], threads = await f.session.anchorThreads();
		const present = () => f.pane.presentTargets(context.session, context.entryId, threads);
		expect(present()).toEqual(new Set([id(7)]));
		f.hideProperty(); await settle(); expect(present()).toEqual(new Set());
		f.cellHandle.current = () => true;
		const target = f.cellHandle.target;
		f.surface.handles.mockReturnValue([f.cellHandle, f.cellHandle]); expect(present()).toEqual(new Set());
		f.surface.handles.mockReturnValue([{ ...f.cellHandle, current: () => false }]); expect(present()).toEqual(new Set());
		if (!("file" in target)) throw new Error("Expected cell");
		const recycled = { ...f.cellHandle, target: { ...target, file: { ...target.file } } };
		f.surface.handles.mockReturnValue([recycled]); expect(present()).toEqual(new Set());
		f.surface.handles.mockReturnValue([f.cellHandle]); expect(present()).toEqual(new Set([id(7)]));
	} finally { f.close(); }
});

test("summary footer controls capture the definition, render its marker, and never substitute a view target", async () => {
	const f = fixture();
	try {
		await settle();
		const target: NativeBaseTarget = { type: "summary", property: { source: "note", name: "score" }, summary: "Sum" };
		const handle = { target, element: f.cell, current: () => true }, context = f.contexts[0];
		context.selection = value => value.type === "summary" ? { type: "summary", definitionId: id(10), definitionRevision: 1 } : undefined;
		context.native = () => target;
		Object.assign(f.surface, { hit: () => handle, handles: jest.fn(() => [handle]) });
		f.session.anchorThreads.mockResolvedValue([{ id: id(7), author_id: id(8), activity_sequence: 1, state: "open", anchor: { ...f.anchor,
			target: { type: "summary", definition_id: id(10), definition_revision: 1, property: target.property, summary: "Sum" } } }]);
		f.pane.invalidate(true); await settle(); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work", "Comment on summary · note.score · Sum"]);
		f.buttons()[1].click(); expect(f.host.commentBaseHandle).toHaveBeenCalledWith(context, handle); await settle();
		const marker = f.root.querySelector<HTMLButtonElement>(".relay-base-comment-marker")!;
		expect(marker).not.toBeNull(); marker.click(); expect(f.host.openBaseThread).toHaveBeenCalledWith(context, id(7));
		Object.assign(f.surface, { handles: jest.fn(() => [handle, { ...handle }]) }); f.pane.invalidate(false); await settle();
		expect(f.root.querySelector(".relay-base-comment-marker")).toBeNull();
		Object.assign(f.surface, { hit: () => undefined }); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.buttons().map(button => button.textContent)).toEqual(["Comments · Work"]);
		expect(f.root.textContent).toContain("Select a supported comment target.");
		const chrome = document.createElement("button"); f.root.append(chrome); chrome.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(f.root.textContent).not.toContain("Select a supported comment target.");
	} finally { f.close(); }
});

test("a pending capture announces progress immediately, fences repeat clicks and shortcuts, and restores its live controls", async () => {
	const f = fixture(); let finish!: () => void;
	try {
		await settle(); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		f.host.commentBaseHandle.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
		const selected = f.buttons()[1]; selected.click();
		expect(f.root.querySelector('[data-capture-state][role="status"]')?.textContent).toBe("Preparing comment…");
		expect(selected.disabled).toBe(true); expect(f.buttons()[0].disabled).toBe(false);
		selected.click(); f.pane.comment(); expect(f.host.commentBaseHandle).toHaveBeenCalledTimes(1);
		f.root.dispatchEvent(new Event("scroll")); await settle(); expect(f.buttons()[1]).toBe(selected);
		finish(); await settle(); expect(selected.disabled).toBe(false); expect(f.root.querySelector("[data-capture-state]")).toBeNull();
	} finally { finish?.(); f.close(); }
});

test("a late capture completion cannot restore controls after its pane closes", async () => {
	const f = fixture(); let finish!: () => void;
	try {
		await settle(); f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		f.host.commentBaseHandle.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
		f.buttons()[1].click(); f.pane.close(); finish(); await settle();
		expect(f.root.querySelector(".relay-bases-comment-tools")).toBeNull();
	} finally { finish?.(); f.close(); }
});

test("group summaries use exact distinct badges, capture controls and target status without merging with headers", async () => {
	const f = fixture();
	try {
		await settle(); const context = f.contexts[0]; let duplicate = false, visible = true;
		const group = { type: "group" as const, property: { source: "note" as const, name: "status" }, value: { type: "text" as const, value: "Done" } };
		const header: NativeBaseGroupHandle = { target: group, element: f.row, ambiguous: false, current: () => true, members: () => [] };
		const summary: NativeBaseGroupHandle = { ...header, element: f.cell, target: { ...group, summary: { property: { source: "formula", name: "Total" }, summary: "Average" } } };
		const grouped = { ...group, definition_id: id(10), definition_revision: 1, group_id: id(11), witness_id: id(12) };
		const anchor: BaseAnchor = { ...f.anchor, target: { type: "group_summary", definition_id: id(15), definition_revision: 1, ...summary.target.summary!, group: grouped } };
		const native = jest.fn(async (anchor: BaseAnchor) => anchor.target.type === "group_summary" ? summary.target : header.target);
		context.groups = { handles: () => [header, ...(visible ? duplicate ? [summary, summary] : [summary] : [])], hit: () => [summary],
			canCapture: () => true, native, reveal: jest.fn(() => "revealed") } as unknown as NativeBaseGroupComments;
		const threads = [{ id: id(20), author_id: null, state: "open" as const, anchor },
			{ id: id(21), author_id: null, state: "open" as const, anchor: { ...f.anchor, target: grouped } }];
		f.session.anchorThreads.mockResolvedValue(threads); f.pane.invalidate(); await settle();
		expect(native).toHaveBeenCalledTimes(2); expect(f.root.querySelectorAll(".relay-base-comment-marker")).toHaveLength(2);
		f.cell.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		const button = f.buttons().find(button => button.textContent?.startsWith("Comment on summary"))!;
		expect(button).toBeDefined(); button.click(); expect(f.host.commentBaseGroupHandle).toHaveBeenCalledWith(context, summary);
		const present = () => f.pane.presentTargets(f.session as unknown as BaseCommentContext["session"], context.entryId, threads as never);
		expect(present()).toEqual(new Set([id(20), id(21)]));
		visible = false; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set([id(21)]));
		expect(f.root.querySelectorAll(".relay-base-comment-marker")).toHaveLength(1);
		visible = true; duplicate = true; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set([id(21)]));
		duplicate = false; f.pane.invalidate(false); await settle(); expect(present()).toEqual(new Set([id(20), id(21)]));
		expect(native).toHaveBeenCalledTimes(2);
	} finally { f.close(); }
});
