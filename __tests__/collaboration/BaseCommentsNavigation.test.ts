/** @jest-environment jsdom */
import { FileView, type Plugin } from "obsidian";
import { BaseComments, type BaseCommentPane } from "../../src/collaboration/BaseComments";
import { NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import { TimelineBridgeClient } from "../../src/bases/TimelineBridgeClient";
import type { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { pendingRangeLocation, type PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";

jest.mock("obsidian", () => ({ Component: class {}, FileView: class {}, Notice: class {}, apiVersion: "1.13.7" }));
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Stage = "before" | "open" | "reveal" | "activate" | "ready" | "verify" | "never";

function fixture(stage: Stage, existing = false) {
	const root = document.createElement("div"); document.body.append(root);
	const file = { path: "Team/Plan.base", extension: "base" }, view = Object.assign(Object.create(FileView.prototype), { file, contentEl: root, containerEl: root });
	const scope = baseDiscussionScope(id(1), id(2)); let busy = stage === "before", opened = existing;
	const pause = (at: Stage) => { if (stage === at) busy = true; };
	const session = { permission: () => ({ read: true }) } as unknown as DiscussionSession;
	const anchor: BaseAnchor = { version: 1, type: "base", definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1, target: { type: "view" } };
	const leaf = { view, openFile: jest.fn(async () => { opened = true; pause("open"); }) };
	const workspace = { getLeavesOfType: () => opened ? [leaf] : [], getMostRecentLeaf: () => leaf, getLeaf: jest.fn(() => leaf),
		revealLeaf: jest.fn(async () => pause("reveal")) };
	const context = { session, baseEntryId: id(1), entryId: scope, current: () => true,
		binding: { snapshot: { definition_id: id(3), generation: id(4) } }, native: () => ({ type: "view" }) };
	const pane = { invalidate: jest.fn(), close: jest.fn(), navigationGuard: () => () => true,
		ready: jest.fn(async () => { pause("ready"); return context; }), reveal: jest.fn(async () => "revealed") };
	const host = { nativeBasesCommentsEnabled: true, baseFile: () => file,
		activateBaseView: jest.fn(async () => { pause("activate"); return busy ? "unavailable" : "unchanged"; }),
		verifyBaseTarget: jest.fn(async () => { pause("verify"); return true; }) };
	jest.spyOn(TimelineBridgeClient.prototype, "canNavigate").mockImplementation(() => !busy);
	jest.spyOn(NativeBasesSurface, "inspect").mockReturnValue({} as NativeBasesSurface);
	const comments = new BaseComments(host as unknown as DiscussionHost, { app: { workspace } } as unknown as Plugin);
	(comments as unknown as { panes: Map<FileView, BaseCommentPane> }).panes.set(view, pane as unknown as BaseCommentPane);
	return { comments, workspace, leaf, host, pane, session, scope, anchor, close: () => { comments.onunload(); root.remove(); } };
}
afterEach(() => { jest.restoreAllMocks(); document.body.replaceChildren(); });

test.each([false, true])("dirty inspector refuses navigation before opening or focusing a Bases file (already open: %s)", async existing => {
	const f = fixture("before", existing);
	try {
		expect(await f.comments.reveal(f.session, f.scope, f.anchor)).toBe(true);
		expect(f.workspace.getLeaf).not.toHaveBeenCalled(); expect(f.leaf.openFile).not.toHaveBeenCalled();
		expect(f.workspace.revealLeaf).not.toHaveBeenCalled(); expect(f.host.activateBaseView).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test.each(["open", "reveal", "activate", "ready", "verify"] as const)("inspector changes during %s stop later navigation and suppress fallback", async stage => {
	const f = fixture(stage);
	try {
		expect(await f.comments.reveal(f.session, f.scope, f.anchor)).toBe(true);
		expect(f.pane.reveal).not.toHaveBeenCalled();
		if (stage === "open") expect(f.workspace.revealLeaf).not.toHaveBeenCalled();
		if (stage === "open" || stage === "reveal") expect(f.host.activateBaseView).not.toHaveBeenCalled();
		if (["open", "reveal", "activate"].includes(stage)) expect(f.pane.ready).not.toHaveBeenCalled();
		if (stage !== "verify") expect(f.host.verifyBaseTarget).not.toHaveBeenCalled();
	} finally { f.close(); }
});

test("clean navigation opens the original saved view and reveals the authorized target", async () => {
	const f = fixture("never");
	try {
		expect(await f.comments.reveal(f.session, f.scope, f.anchor)).toBe(true);
		expect(f.leaf.openFile).toHaveBeenCalledTimes(1); expect(f.host.activateBaseView).toHaveBeenCalledTimes(1);
		expect(f.host.verifyBaseTarget).toHaveBeenCalledTimes(1); expect(f.pane.reveal).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test.each((["never", "verify"] as const).flatMap(stage => [false, true].map(pendingLane => ({ stage, pendingLane }))))("range navigation retains its lane and respects late inspector changes ($stage, pending: $pendingLane)", async ({ stage, pendingLane }) => {
	const f = fixture(stage), revealRange = jest.fn().mockResolvedValue("revealed");
	try {
		f.anchor.target = { type: "timeline_range", axis_definition_id: id(20), axis_definition_revision: 1,
			axis: { version: 1, renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null },
			range: { version: 1, kind: "ordinal", start: "1", end: "2", unit: "property-value", start_inclusive: true, end_inclusive: true } };
		const pending: PendingBaseGroupAnchor = { version: 1, type: "base_group_pending", entry_id: id(1), property: { source: "note", name: "status" }, range: f.anchor.target,
			capture: { operation_id: id(30), definition_id: id(3), view_id: id(2), generation: id(4), registry_revision: 1,
				group_definition_id: id(31), group_definition_revision: 1, record_id: id(32), record_generation: id(33), dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Ready" } } };
		const selected = pendingLane ? pending : f.anchor;
		Object.assign(f.pane, { revealRange });
		expect(await f.comments.reveal(f.session, f.scope, selected)).toBe(true);
		expect(f.pane.reveal).not.toHaveBeenCalled(); expect(revealRange).toHaveBeenCalledTimes(stage === "never" ? 1 : 0);
		expect(f.host.verifyBaseTarget).toHaveBeenCalledWith(expect.anything(), pendingLane ? pendingRangeLocation(pending) : f.anchor);
		if (stage === "never") expect(revealRange).toHaveBeenCalledWith(expect.anything(), selected, expect.any(Function));
	} finally { f.close(); }
});

test.each(["before", "open", "reveal", "activate", "ready", "verify", "never"] as const)("captured marker navigation retains its original target and stops at dirty inspector stage %s", async stage => {
	const f = fixture(stage), revealRange = jest.fn().mockResolvedValue("revealed");
	try {
		f.anchor.target = { type: "timeline_marker", marker_id: id(20), marker_revision: 1, axis_definition_id: id(21), axis_definition_revision: 1,
			axis: { version: 1, renderer: "sabidurian-sequence", start_property: { source: "note", name: "order" }, end_property: null, time_zone: null },
			content: { kind: "point", label: "Original launch", color: "#abcdef", range: { version: 1, kind: "ordinal", start: "99.000001", end: "99.000001", unit: "property-value", start_inclusive: true, end_inclusive: true } } };
		Object.assign(f.pane, { revealRange });
		expect(await f.comments.reveal(f.session, f.scope, f.anchor)).toBe(true);
		expect(f.pane.reveal).not.toHaveBeenCalled(); expect(revealRange).toHaveBeenCalledTimes(stage === "never" ? 1 : 0);
		if (stage === "never") expect(revealRange).toHaveBeenCalledWith(expect.anything(), f.anchor, expect.any(Function));
	} finally { f.close(); }
});
