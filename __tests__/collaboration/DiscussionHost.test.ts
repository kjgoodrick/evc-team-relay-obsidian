/** @jest-environment jsdom */
import type { Plugin } from "obsidian";
import { TFile } from "obsidian";
import type { AuthSession } from "../../src/AuthSession";
import type { ShareRegistry } from "../../src/VaultShare";
import type { SettingsScope } from "../../src/SettingsPersistence";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import { DiscussionHost } from "../../src/collaboration/DiscussionHost";
import { DiscussionStore, type OutboxOperation } from "../../src/collaboration/storage/DiscussionStore";
import type { DiscussionSession } from "../../src/collaboration/DiscussionSession";
import { baseDiscussionScope } from "../../src/collaboration/DiscussionScope";
import { BaseTargetPicker } from "../../src/collaboration/ui/BaseTargetPicker";
import type { BaseSyncHost } from "../../src/bases/BaseSyncHost";
import type { NativeBasesSurface, NativeBaseHandle } from "../../src/bases/NativeBasesSurface";
import type { BaseAnchor } from "../../src/collaboration/DiscussionProtocol";
import type { BaseDefinitionCatalog } from "../../src/collaboration/BaseDefinitionProtocol";
import * as retainedSources from "../../src/collaboration/RetainedBaseGroupSources";
import type { NativeBaseGroupHandle } from "../../src/bases/NativeBasesSurface";
import type { InboxItem } from "../../src/collaboration/InboxProtocol";
import type { TimelineAxisContext } from "../../src/collaboration/TimelineRangeProtocol";
import { parseTimelineMarkerCatalog, timelineMarkerAnchor } from "../../src/collaboration/TimelineMarkerProtocol";
import type { TimelineRange } from "../../src/collaboration/TimelineRange";
import { pendingRangeLocation, type PendingBaseGroupAnchor } from "../../src/collaboration/LocalDiscussionAnchor";
import { TextEncoder } from "node:util";
import { webcrypto } from "node:crypto";
import { DISCUSSION_LINK_ACTION, discussionLinkUrl, discussionServerKey, parseDiscussionLink } from "../../src/collaboration/DiscussionLinks";
import { DiscussionFailure } from "../../src/collaboration/DiscussionTransport";
import type { DiscussionSearchItem } from "../../src/collaboration/DiscussionSearchProtocol";
import { ReattachCommentModal } from "../../src/collaboration/ui/ReattachComment";
import { RecoverCommentModal } from "../../src/collaboration/ui/RecoverComment";
import type { AnchoredThread } from "../../src/collaboration/DiscussionSession";

Object.assign(globalThis, { TextEncoder });
Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });

const mockSessions: { close: jest.Mock; status: string }[] = [];
const mockCredentials: (() => Promise<unknown>)[] = [];
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("../../src/collaboration/ui/BaseTargetPicker", () => ({ BaseTargetPicker: jest.fn().mockImplementation(() => ({ open: jest.fn() })) }));
jest.mock("../../src/collaboration/ui/ReattachComment", () => ({
	ReattachCommentModal: jest.fn().mockImplementation(() => ({ open: jest.fn(), close: jest.fn(), validate: jest.fn() })),
	commentTargetDescription: () => "Target", TargetHistoryModal: jest.fn(),
}));
jest.mock("../../src/collaboration/ui/RecoverComment", () => ({ RecoverCommentModal: jest.fn().mockImplementation(() => ({ open: jest.fn(), close: jest.fn(), validate: jest.fn() })) }));
jest.mock("../../src/Document", () => ({ isDocument: (value: { isDocument?: boolean }) => value?.isDocument === true }));
jest.mock("../../src/AttachmentFile", () => ({ isAttachmentFile: (value: { isAttachment?: boolean }) => value?.isAttachment === true }));
jest.mock("obsidian", () => ({
	Component: class { register() {} registerEvent() {} registerDomEvent() {} addChild<T>(child: T): T { return child; } },
	MarkdownRenderChild: class {},
	ItemView: class {}, Modal: class {}, Notice: class {}, TFile: class { path = "Team/Note.md"; extension = "md"; },
}));
jest.mock("../../src/collaboration/DiscussionTransport", () => ({
	DiscussionFailure: jest.requireActual("../../src/collaboration/DiscussionTransport").DiscussionFailure,
	DiscussionTransport: class {
		constructor(readonly identity: unknown, credential: () => Promise<unknown>) { mockCredentials.push(credential); }
	},
}));
jest.mock("../../src/collaboration/DiscussionSession", () => ({
	DiscussionSession: class {
		status = "ready";
		close = jest.fn(() => { this.status = "closed"; return Promise.resolve(); });
		onChange() {} setForeground() {} start() { return Promise.resolve(); } refresh() { return Promise.resolve(); }
		trackLocal<T>(promise: Promise<T>) { return promise; }
		constructor(readonly store: DiscussionStore) { mockSessions.push(this); }
	},
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture(bases?: BaseSyncHost) {
	mockSessions.length = 0; mockCredentials.length = 0;
	let accountId: string | undefined = id(1), authChanged!: () => void, settingsChanged!: () => void;
	const settings = { enabled: true, servers: [{ id: "server", controlPlaneUrl: "https://one.test", name: "One", isValidated: true }] };
	const provider = { getCurrentUser: () => accountId ? { id: accountId } : undefined, isLoggedIn: () => !!accountId,
		getValidToken: jest.fn().mockResolvedValue("synthetic-token") };
	const auth = { on: (fn: () => void) => { authChanged = fn; return () => {}; }, onTokenRefreshed: () => () => {}, getAuthProviderForServer: () => provider };
	const folder = { entityGuid: id(2), config: { onpremServerId: "server" }, folderIndex: { on: () => () => {}, recordFor: () => ({ id: id(3), type: "markdown" }) }, toVirtualPath: () => "Note.md" };
	const shares = { on: () => () => {}, toArray: () => [folder], shareFor: () => folder };
	const file = new TFile();
	const plugin = { registerObsidianProtocolHandler: jest.fn(), registerView: jest.fn(), registerEditorExtension: jest.fn(), addCommand: jest.fn(), app: { workspace: { on: jest.fn(), getActiveFile: () => file }, vault: { on: jest.fn(), getFileByPath: () => file } } };
	const scope = { readValue: () => settings, subscribe: (fn: () => void) => { settingsChanged = fn; return () => {}; } };
	const store = { close: jest.fn(), preference: jest.fn().mockResolvedValue(undefined) };
	const opening = jest.spyOn(DiscussionStore, "open").mockResolvedValue(store as unknown as DiscussionStore);
	const host = new DiscussionHost(plugin as unknown as Plugin, auth as unknown as AuthSession, shares as unknown as ShareRegistry,
		 scope as unknown as SettingsScope<RelayOnPremSettings>, "vault", bases);
	return { host, opening, store, provider, settings, file, folder, plugin, start: async () => { host.onload(); await Promise.resolve(); await Promise.resolve(); },
		account: (value?: string) => { accountId = value; authChanged(); }, settingsChanged: () => settingsChanged(),
		close: () => { host.onunload(); opening.mockRestore(); } };
}

test("target selection opens a review for the existing discussion without consuming or creating a comment draft", async () => {
	const s = fixture(); await s.start();
	const session = Object.assign(mockSessions[0], { canReattach: true, permission: () => ({ read: true, comment: true }), store: s.store });
	const typed = session as unknown as DiscussionSession, anchor = { version: 1 as const, type: "note" as const };
	const thread: AnchoredThread = { id: id(30), author_id: id(1), state: "resolved", state_revision: 4, anchor_revision: 2,
		removed: false, created_sequence: 1, activity_sequence: 5, created_at: "2026-11-07T00:00:00Z", anchor };
	const saveDraft = jest.fn(), setPreference = jest.fn(); Object.assign(s.store, { saveDraft, setPreference });
	const modal = jest.mocked(ReattachCommentModal);
	try {
		s.host.openReattachment(typed, id(3), thread);
		modal.mock.calls.at(-1)![4].choose(thread);
		expect(s.host.selectingReattachment(typed, id(3))).toBe(true);
		const count = modal.mock.calls.length;
		expect(await s.host.saveCommentSelection({ session: typed, entryId: id(3), file: s.file, anchor })).toBe(true);
		expect(modal.mock.calls).toHaveLength(count + 1);
		expect(modal.mock.calls.at(-1)!.slice(1, 4)).toEqual([typed, id(3), thread]);
		expect(modal.mock.calls.at(-1)![5]).toEqual(anchor);
		expect(s.host.choosingReattachment).toBe(false);
		expect(saveDraft).not.toHaveBeenCalled(); expect(setPreference).not.toHaveBeenCalled();
		modal.mock.calls.at(-1)![4].saved();
		expect(s.host.focusedThread(typed, id(3))?.threadId).toBe(thread.id);
	} finally { s.close(); }
});

test("recovery target capture updates only its saved draft with CAS and never enqueues", async () => {
	const s = fixture(); await s.start();
	const session = Object.assign(mockSessions[0], { permission: () => ({ read: true, comment: true }), store: s.store });
	const typed = session as unknown as DiscussionSession, anchor = { version: 1 as const, type: "note" as const };
	const operation = { operationId: id(30), scopeId: id(3), type: "thread.create", state: "review" } as OutboxOperation;
	const draft = { id: "recovery:" + id(30), scopeId: id(3), revision: 4, body: { text: "Saved body", mentions: [] } };
	const retargetRecoveredDraft = jest.fn().mockResolvedValue(undefined), setPreference = jest.fn(); Object.assign(s.store, { retargetRecoveredDraft, setPreference });
	try {
		s.host.openCommandRecovery(typed, operation);
		jest.mocked(RecoverCommentModal).mock.calls.at(-1)![3].choose(operation, draft);
		expect(s.host.choosingCommandRecovery).toBe(true);
		expect(await s.host.saveCommentSelection({ session: typed, entryId: id(3), file: s.file, anchor })).toBe(true);
		expect(retargetRecoveredDraft).toHaveBeenCalledWith(draft.id, 4, anchor);
		expect(setPreference).not.toHaveBeenCalled(); expect(s.host.choosingReattachment).toBe(false);
		expect(jest.mocked(RecoverCommentModal).mock.calls.at(-1)!.slice(1, 3)).toEqual([typed, operation]);
		jest.mocked(RecoverCommentModal).mock.calls.at(-1)![3].choose(operation, draft);
		retargetRecoveredDraft.mockRejectedValueOnce(new Error("Draft changed in another window"));
		expect(await s.host.saveCommentSelection({ session: typed, entryId: id(3), file: s.file, anchor })).toBe(false);
		expect(s.host.choosingCommandRecovery).toBe(true);
		s.account(id(90)); expect(s.host.choosingCommandRecovery).toBe(false);
	} finally { s.close(); }
});

test("target selection rejects another note and cancellation restores ordinary draft capture", async () => {
	const s = fixture(); await s.start();
	const session = Object.assign(mockSessions[0], { canReattach: true, permission: () => ({ read: true, comment: true }), store: s.store });
	const typed = session as unknown as DiscussionSession, anchor = { version: 1 as const, type: "note" as const };
	const thread = { id: id(30), anchor, anchor_revision: 1 } as AnchoredThread;
	const saveDraft = jest.fn().mockResolvedValue(undefined), setPreference = jest.fn().mockResolvedValue(undefined); Object.assign(s.store, { saveDraft, setPreference });
	const open = jest.spyOn(s.host, "open").mockResolvedValue(undefined);
	try {
		s.host.openReattachment(typed, id(3), thread); jest.mocked(ReattachCommentModal).mock.calls.at(-1)![4].choose(thread);
		const other = Object.assign(new TFile(), { path: "Team/Other.md" });
		Object.assign(s.folder.folderIndex, { recordFor: (path: string) => ({ id: path === "Other.md" ? id(99) : id(3), type: "markdown" }) });
		Object.assign(s.folder, { toVirtualPath: (path: string) => path.slice(5) });
		expect(await s.host.saveCommentSelection({ session: typed, entryId: id(99), file: other, anchor })).toBe(false);
		expect(s.host.choosingReattachment).toBe(true); expect(saveDraft).not.toHaveBeenCalled();
		s.host.cancelReattachmentSelection();
		expect(await s.host.saveCommentSelection({ session: typed, entryId: id(3), file: s.file, anchor })).toBe(true);
		expect(saveDraft).toHaveBeenCalledTimes(1); expect(open).toHaveBeenCalledTimes(1);
		s.host.openReattachment(typed, id(3), thread); jest.mocked(ReattachCommentModal).mock.calls.at(-1)![4].choose(thread);
		s.account(id(90)); expect(s.host.choosingReattachment).toBe(false);
	} finally { s.close(); }
});

async function nativeBaseFixture() {
	const snapshot = { definition_id: id(6), entry_id: id(3), generation: id(7), revision: 1 };
	const bases = { cachedViews: jest.fn().mockResolvedValue({ snapshot }), refreshViews: jest.fn().mockResolvedValue({ snapshot }) };
	const s = fixture(bases as unknown as BaseSyncHost); await s.start();
	s.file.path = "Team/Plan.base"; s.file.extension = "base";
	const recordFile = Object.assign(new TFile(), { path: "Team/Note.md" }), record = { id: id(8), type: "markdown" };
	Object.assign(s.folder, { absolutePath: (path: string) => "Team/" + path, toVirtualPath: (path: string) => path.slice(5),
		trackedEntries: new Map([[id(3), { isAttachment: true }]]) });
	Object.assign(s.folder.folderIndex, { recordFor: (path: string) => path === "Plan.base" ? { id: id(3), type: "file" } : record,
		eachRecord: (fn: (record: { id: string; type: string }, path: string) => void) => { fn({ id: id(3), type: "file" }, "Plan.base"); fn(record, "Note.md"); } });
	Object.assign(s.plugin.app.vault, { getFileByPath: (path: string) => path === s.file.path ? s.file : path === recordFile.path ? recordFile : null, read: jest.fn().mockResolvedValue("saved bytes") });
	const stops: jest.Mock[] = [], scope = baseDiscussionScope(id(3), id(4)); let valid = true, read = true, comment = true;
	const session = Object.assign(mockSessions[0], { identity: { shareId: id(2) }, online: true,
		knownDocumentGeneration: () => id(7), permission: () => ({ read, comment }), canAnchorBase: () => true, canAnchorBaseGroup: () => true, canAnchorBaseRecord: (kind: string) => kind === "markdown",
		watch: jest.fn(() => { const stop = jest.fn(); stops.push(stop); return stop; }), refresh: jest.fn().mockResolvedValue(undefined), scopeReady: jest.fn().mockResolvedValue(undefined),
		readBaseContext: jest.fn().mockResolvedValue({ definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, record_generation: id(9) }),
		readBaseDefinitions: jest.fn<Promise<BaseDefinitionCatalog>, []>().mockResolvedValue({ protocol_version: 1, entry_id: id(3), definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, computed_values: false,
			targets: [{ id: id(10), kind: "formula", revision: 1, fingerprint: "a".repeat(64), property: { source: "formula", name: "total" } }] }),
		captureBaseTarget: jest.fn<Promise<BaseAnchor>, []>().mockResolvedValue({ version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
			target: { type: "cell", record_id: id(8), record_generation: id(9), property: { source: "note", name: "status" } } }),
	});
	const savedPreference = jest.fn().mockResolvedValue(undefined); Object.assign(s.store, { setPreference: savedPreference });
	const surface = { file: s.file, current: () => valid, activateView: jest.fn(() => true), bind: jest.fn(async (_snapshot, _entry, readFile: () => Promise<string>, current: () => boolean) => {
		await readFile(); return { snapshot, viewId: id(4), name: "Work", type: "table", current: () => valid && current() };
	}) };
	const handle: NativeBaseHandle = { target: { type: "cell", file: recordFile, property: { source: "note", name: "status" } }, element: document.createElement("div"), current: () => valid };
	return { ...s, bases, surface, session, stops, scope, record, handle, savedPreference,
		context: () => s.host.baseCommentContext(surface as unknown as NativeBasesSurface, () => valid),
		invalidate() { valid = false; }, revoke() { read = false; }, readOnly() { comment = false; } };
}

function inboxItem(): InboxItem {
	return { thread_id: id(30), entry_id: id(3), scope_id: id(31), kind: "note", path: "Old server mount/Old name.md", view_id: null,
		message_id: id(32), message_revision: 1, reason: "mention", last_sequence: 1, activity_at: "2026-11-06T00:00:00Z",
		version: 1, read_version: 0, dismissed_version: 0, unread: true, subscription: { version: 0, following: false, muted: false } };
}
async function inboxFixture() {
	const s = fixture(); await s.start();
	Object.assign(s.folder, { absolutePath: (path: string) => "Team/" + path });
	Object.assign(s.folder.folderIndex, { eachRecord: (fn: (record: { id: string }, path: string) => void) => fn({ id: id(3) }, "Note.md") });
	const stop = jest.fn(), anchor = { version: 1 as const, type: "note" as const };
	const session = Object.assign(mockSessions[0], { identity: { shareId: id(2) }, inbox: { available: true },
		watch: jest.fn(() => stop), scopeReady: jest.fn().mockResolvedValue(undefined), permission: () => ({ read: true }),
		inboxThread: jest.fn().mockResolvedValue({ id: id(30), anchor }) });
	const open = jest.spyOn(s.host, "open").mockResolvedValue(undefined), reveal = jest.spyOn(s.host, "revealTarget").mockResolvedValue(undefined);
	return { ...s, session, stop, anchor, open, reveal };
}

async function linkFixture() {
	const s = await inboxFixture();
	const session = Object.assign(s.session, { identity: { serverId: "https://one.test", accountId: id(1), shareId: id(2) },
		linkedThread: jest.fn().mockResolvedValue({ thread: { id: id(30), anchor: s.anchor }, message: { id: id(31), created_sequence: 801 } }),
		cachedThread: jest.fn().mockResolvedValue({ id: id(30), anchor: s.anchor }), cachedMessage: jest.fn().mockResolvedValue({ id: id(31) }) });
	const link = { version: 1 as const, server: await discussionServerKey("https://one.test"), shareId: id(2), entryId: id(3), threadId: id(30), kind: "note" as const, messageId: id(31) };
	return { ...s, session, typed: session as unknown as DiscussionSession, link, url: discussionLinkUrl(link) };
}

test.each([false, true])("search navigation reuses the authorized link path and cancels a disposed result (cancel: %s)", async cancel => {
	const s = await linkFixture(); let live = true;
	const item: DiscussionSearchItem = { thread: { id: id(30), author_id: id(1), state: "open", state_revision: 1, anchor_revision: 1,
		removed: false, created_sequence: 1, activity_sequence: 801, created_at: "2026-11-07T00:00:00Z" }, entry_id: id(3), view_id: null,
		kind: "note", path: "Old mount/Old name.md", message_id: id(31), message_revision: 1, message_sequence: 801, excerpt: "Matched" };
	try {
		const opening = s.host.openSearchResult(s.typed, item, () => live); if (cancel) live = false;
		if (cancel) { await expect(opening).rejects.toThrow("cancelled"); expect(s.session.linkedThread).not.toHaveBeenCalled(); }
		else { await opening; expect(s.session.linkedThread).toHaveBeenCalledWith(id(3), id(30), id(31)); expect(s.host.current().path).toBe(s.file.path); }
	} finally { s.close(); }
});

test("direct links use stable IDs across file renames, focus an older reply and register a native URI handler", async () => {
	const s = await linkFixture(); s.file.path = "Different mount/Renamed.md";
	try {
		expect(s.plugin.registerObsidianProtocolHandler).toHaveBeenCalledWith(DISCUSSION_LINK_ACTION, expect.any(Function));
		await s.host.openDiscussionLink(s.url);
		expect(s.session.linkedThread).toHaveBeenCalledWith(id(3), id(30), id(31));
		expect(s.host.current()).toMatchObject({ path: s.file.path, entryId: id(3), kind: "note" });
		expect(s.host.focusedThread(s.typed, id(3))).toMatchObject({ threadId: id(30), messageId: id(31), messageSequence: 801 });
		expect(s.reveal).toHaveBeenCalledWith(s.session, id(3), s.anchor, expect.any(Function));
		expect(s.stop).toHaveBeenCalledTimes(1);
		expect(parseDiscussionLink(await s.host.discussionUrl(s.typed, id(3), id(30), id(31)))).toEqual(s.link);
	} finally { s.close(); }
});

test.each(["missing", "ambiguous"])("%s local files show authorized discussion without inventing a target", async situation => {
	const s = await linkFixture();
	Object.assign(s.folder.folderIndex, { eachRecord: (fn: (record: { id: string }, path: string) => void) => {
		if (situation === "ambiguous") { fn({ id: id(3) }, "First.md"); fn({ id: id(3) }, "Second.md"); }
	} });
	try {
		await s.host.openDiscussionLink(s.url);
		expect(s.host.current()).toMatchObject({ path: "Linked discussion", entryId: id(3), message: expect.stringContaining("not available uniquely") });
		expect(s.open).toHaveBeenCalledTimes(1); expect(s.reveal).not.toHaveBeenCalled();
		s.account(id(90)); expect(s.host.current().path).not.toBe("Linked discussion");
	} finally { s.close(); }
});

test.each(["server", "share", "signed out", "disabled"])("links cannot create a connection or reuse credentials for %s", async situation => {
	const s = await linkFixture(); let link = s.link;
	if (situation === "server") link = { ...link, server: "b".repeat(64) };
	if (situation === "share") link = { ...link, shareId: id(90) };
	if (situation === "signed out") s.account();
	if (situation === "disabled") s.settings.enabled = false;
	try {
		await expect(s.host.openDiscussionLink(discussionLinkUrl(link))).rejects.toThrow();
		expect(s.session.watch).not.toHaveBeenCalled(); expect(s.session.linkedThread).not.toHaveBeenCalled();
		expect(s.provider.getValidToken).not.toHaveBeenCalled(); expect(s.reveal).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test.each(["account", "endpoint", "revoked", "cancelled", "unload"])("a delayed link cannot open after %s changes", async change => {
	const s = await linkFixture(); let release!: (value: unknown) => void, entered!: () => void, live = true;
	const started = new Promise<void>(resolve => { entered = resolve; });
	s.session.linkedThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve; entered(); }));
	const navigation = s.host.openDiscussionLink(s.url, () => live), rejected = expect(navigation).rejects.toThrow();
	try {
		await started;
		if (change === "account") s.account(id(90));
		if (change === "endpoint") s.settings.servers[0].controlPlaneUrl = "https://other.test";
		if (change === "revoked") s.session.permission = () => ({ read: false });
		if (change === "cancelled") live = false;
		if (change === "unload") s.host.onunload();
		release({ thread: { id: id(30), anchor: s.anchor } }); await rejected;
		expect(s.open).not.toHaveBeenCalled(); expect(s.reveal).not.toHaveBeenCalled(); expect(s.stop).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("unavailable message falls back to the original thread with an explanation", async () => {
	const s = await linkFixture(); s.session.linkedThread.mockResolvedValue({ thread: { id: id(30), anchor: s.anchor } });
	try {
		await s.host.openDiscussionLink(s.url);
		expect(s.host.focusedThread(s.typed, id(3))).toMatchObject({ threadId: id(30), notice: expect.stringContaining("linked message is unavailable") });
	} finally { s.close(); }
});

test("permission failures show a human explanation and release the temporary subscription", async () => {
	const s = await linkFixture(); s.session.linkedThread.mockRejectedValue(new DiscussionFailure("reject", "internal_detail", 403));
	try {
		await expect(s.host.openDiscussionLink(s.url)).rejects.toThrow("unavailable to your current account");
		expect(s.stop).toHaveBeenCalledTimes(1); expect(s.open).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("Bases links retain the original saved view rather than whichever view the recipient last used", async () => {
	const s = await nativeBaseFixture(), anchor = { version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1, target: { type: "view" } };
	Object.assign(s.session, { identity: { serverId: "https://one.test", shareId: id(2), accountId: id(1) },
		linkedThread: jest.fn().mockResolvedValue({ thread: { id: id(30), anchor } }) });
	const open = jest.spyOn(s.host, "open").mockResolvedValue(undefined), reveal = jest.spyOn(s.host, "revealTarget").mockResolvedValue(undefined);
	const link = { version: 1 as const, server: await discussionServerKey("https://one.test"), shareId: id(2), entryId: id(3), threadId: id(30), kind: "base" as const, viewId: id(4) };
	try {
		await s.host.openDiscussionLink(discussionLinkUrl(link));
		expect(s.savedPreference).toHaveBeenCalledWith("activeBaseView:" + id(3), expect.objectContaining({ id: id(4) }));
		expect(s.host.current()).toMatchObject({ entryId: s.scope, baseEntryId: id(3), kind: "base" });
		expect(open).toHaveBeenCalledTimes(1); expect(reveal).toHaveBeenCalledWith(s.session, s.scope, anchor, expect.any(Function));
	} finally { s.close(); }
});

test("inbox navigation resolves the current local file by managed identity instead of its old display path", async () => {
	const s = await inboxFixture();
	try {
		await s.host.openInboxItem(s.session as unknown as DiscussionSession, inboxItem());
		expect(s.open).toHaveBeenCalledTimes(1);
		expect(s.host.current()).toMatchObject({ path: "Team/Note.md", entryId: id(3) });
		expect(s.reveal).toHaveBeenCalledWith(s.session, id(3), s.anchor);
		expect(s.stop).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("an ambiguous inventory identity cannot navigate from an inbox notification", async () => {
	const s = await inboxFixture();
	Object.assign(s.folder.folderIndex, { eachRecord: (fn: (record: { id: string }, path: string) => void) => {
		fn({ id: id(3) }, "Note.md"); fn({ id: id(3) }, "Copy.md");
	} });
	try {
		await expect(s.host.openInboxItem(s.session as unknown as DiscussionSession, inboxItem())).rejects.toThrow("unavailable");
		expect(s.session.watch).not.toHaveBeenCalled(); expect(s.open).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test.each(["account", "deleted", "revoked"])("a delayed inbox read cannot navigate after %s changes", async change => {
	const s = await inboxFixture();
	let release!: (value: unknown) => void;
	s.session.inboxThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
	const navigation = s.host.openInboxItem(s.session as unknown as DiscussionSession, inboxItem());
	const result = expect(navigation).rejects.toThrow();
	try {
		await Promise.resolve();
		if (change === "account") s.account(id(90));
		else if (change === "deleted") Object.assign(s.plugin.app.vault, { getFileByPath: () => null });
		else s.session.inbox.available = false;
		release({ id: id(30), anchor: s.anchor }); await result;
		expect(s.open).not.toHaveBeenCalled(); expect(s.reveal).not.toHaveBeenCalled(); expect(s.stop).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("a Bases notification pins its original saved view without adopting the active view", async () => {
	const s = await nativeBaseFixture();
	s.store.preference.mockResolvedValue({ id: id(40), name: "Different view", type: "table", state: "active" });
	s.host.targetFor(s.file); await Promise.resolve();
	const anchor = await s.session.captureBaseTarget();
	Object.assign(s.session, { inbox: { available: true }, inboxThread: jest.fn().mockResolvedValue({ id: id(30), anchor }) });
	const open = jest.spyOn(s.host, "open").mockResolvedValue(undefined), reveal = jest.spyOn(s.host, "revealTarget").mockResolvedValue(undefined);
	try {
		await s.host.openInboxItem(s.session as unknown as DiscussionSession, { ...inboxItem(), kind: "base", view_id: id(4) });
		expect(s.savedPreference).toHaveBeenCalledWith("activeBaseView:" + id(3), expect.objectContaining({ id: id(4), state: "unmatched" }));
		expect(s.host.current().entryId).toBe(s.scope); expect(open).toHaveBeenCalledTimes(1);
		expect(reveal).toHaveBeenCalledWith(s.session, s.scope, anchor); expect(s.stops[0]).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("retained group sources are bound to the exact native file, inventory and account without creating a document", async () => {
	const s = await nativeBaseFixture();
	if (s.handle.target.type !== "cell") throw new Error("Expected cell fixture");
	const file = s.handle.target.file, tracked = new Map<string, object>([[id(3), { isAttachment: true }]]);
	Object.assign(s.folder, { hostAppId: "synthetic-vault", trackedEntries: tracked });
	const catalog = await s.session.readBaseDefinitions();
	catalog.targets.push({ id: id(11), kind: "group", revision: 1, fingerprint: "b".repeat(64), property: { source: "note", name: "status" } });
	let key: ReturnType<Parameters<typeof retainedSources.retainedBaseGroupSources>[1]["key"]>;
	const discover = jest.spyOn(retainedSources, "retainedBaseGroupSources").mockImplementation(async (files, port) => { key = port.key(files[0]); return []; });
	try {
		const context = (await s.context())!;
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Done" } },
			element: document.createElement("div"), ambiguous: false, current: () => true, members: () => [file] };
		await expect(context.groups!.capture(handle)).rejects.toThrow("synchronized source");
		expect(key!.name).toBe(`synthetic-vault-relay-doc-${id(8)}`); expect(key!.current()).toBe(true);
		expect(tracked.size).toBe(1);
		tracked.set(id(8), { isDocument: true, isLocallyPersisted: false }); expect(key!.current()).toBe(false);
		tracked.delete(id(8)); expect(key!.current()).toBe(true);
		file.path = "Team/Renamed.md"; expect(key!.current()).toBe(false); file.path = "Team/Note.md";
		const index = { registered: () => true, snapshot: { owner: false, permissions: { "Note.md": "read" } } };
		Object.assign(s.folder, { _liveProvider: { managedIndex: index } }); expect(key!.current()).toBe(true);
		index.snapshot.permissions["Note.md"] = "none"; expect(key!.current()).toBe(false);
		index.snapshot.permissions["Note.md"] = "read"; expect(key!.current()).toBe(true);
		s.account(id(90)); expect(key!.current()).toBe(false);
		context.release();
	} finally { discover.mockRestore(); s.close(); }
});

test("an initializing native document cannot be replaced by its older retained cache", async () => {
	const s = await nativeBaseFixture(); if (s.handle.target.type !== "cell") throw new Error("Expected cell fixture");
	const file = s.handle.target.file;
	Object.assign(s.folder, { trackedEntries: new Map([[id(3), { isAttachment: true }], [id(8), { isDocument: true, isLocallyPersisted: false }]]) });
	const catalog = await s.session.readBaseDefinitions();
	catalog.targets.push({ id: id(11), kind: "group", revision: 1, fingerprint: "b".repeat(64), property: { source: "note", name: "status" } });
	const discover = jest.spyOn(retainedSources, "retainedBaseGroupSources").mockImplementation(async (files, port) => { expect(port.key(files[0])).toBeUndefined(); return []; });
	try {
		const context = (await s.context())!;
		await expect(context.groups!.capture({ target: { type: "group", property: { source: "note", name: "status" }, value: { type: "text", value: "Done" } },
			element: document.createElement("div"), ambiguous: false, current: () => true, members: () => [file] })).rejects.toThrow("synchronized source");
		expect(discover).toHaveBeenCalledTimes(1); context.release();
	} finally { discover.mockRestore(); s.close(); }
});

test.each(["success", "revoked", "changed-axis", "cancelled"])("native marker capture preserves its exact target and guards async completion: %s", async outcome => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!; context.binding.type = "sabidurian-sequence";
		const axis = { version: 1 as const, renderer: "sabidurian-sequence" as const, start_property: { source: "note" as const, name: "order" }, end_property: null, time_zone: null };
		const proof: TimelineAxisContext = { protocol_version: 1, entry_id: id(3), definition_id: id(6), generation: id(7), view_id: id(4), registry_revision: 1,
			axis: { id: id(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis } };
		const native = { axis, kinds: ["ordinal"], current: () => true }; Object.assign(s.surface, { rangeContext: () => native });
		const content = { kind: "point", label: "Exact launch", color: "#123abc", range: { version: 1, kind: "ordinal", start: "9.00000001", end: "9.00000001", start_inclusive: true, end_inclusive: true, unit: "property-value" } };
		const catalog = parseTimelineMarkerCatalog({ protocol_version: 1, entry_id: id(3), definition_id: id(6), generation: id(7), view_id: id(4), registry_revision: 1,
			catalog_revision: 1, markers: [{ id: id(50), revision: 1, active: true, content,
				placement: { view_id: id(4), active: true, axis_definition_id: id(40), axis_definition_revision: 1, axis },
				target: { type: "timeline_marker", marker_id: id(50), marker_revision: 1, axis_definition_id: id(40), axis_definition_revision: 1, axis, content } }] }, id(3), id(4));
		const anchor = timelineMarkerAnchor(catalog, catalog.markers[0]); let finish!: (value: BaseAnchor) => void, alive = true;
		const capture = jest.fn(() => new Promise<BaseAnchor>(resolve => { finish = resolve; }));
		Object.assign(s.session, { captureTimelineMarker: capture, readTimelineAxis: jest.fn().mockResolvedValue(proof) });
		const pending = s.host.commentTimelineMarker(context, catalog, id(50), () => alive);
		if (outcome === "revoked") s.readOnly();
		if (outcome === "cancelled") alive = false;
		if (outcome === "changed-axis") native.axis = { ...axis, start_property: { source: "note", name: "other" } };
		finish(anchor);
		if (outcome === "changed-axis") await expect(pending).rejects.toThrow("axis");
		else expect(await pending).toBe(outcome === "success");
		expect(capture).toHaveBeenCalledWith(s.scope, catalog, id(50));
		if (outcome === "success") {
			expect(saved).toHaveBeenCalledWith({ file: s.file, session: s.session, entryId: s.scope, anchor });
			expect(await s.host.verifyBaseTarget(context, anchor)).toBe(true); proof.axis.revision = 2;
			expect(await s.host.verifyBaseTarget(context, anchor)).toBe(false);
		} else { expect(saved).not.toHaveBeenCalled(); expect(s.savedPreference).not.toHaveBeenCalled(); }
		context.release();
	} finally { s.close(); }
});

test("native Bases discovery does not pin the sidebar; explicit capture pins and saves the exact cell", async () => {
	const s = await nativeBaseFixture(); const saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!; expect(context.current()).toBe(true);
		expect(s.host.current().entryId).toBeUndefined(); expect(s.savedPreference).not.toHaveBeenCalled();
		expect(context.selection(s.handle.target)).toEqual({ type: "cell", recordId: id(8), property: { source: "note", name: "status" } });
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(true);
		expect(s.host.current().entryId).toBe(s.scope);
		expect(saved).toHaveBeenCalledWith(expect.objectContaining({ entryId: s.scope, anchor: expect.objectContaining({ target: expect.objectContaining({ record_id: id(8) }) }) }));
		context.release(); context.release(); expect(s.stops[0]).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test.each([false, true].flatMap(withLane => ["success", "revoked", "changed-axis", "cancelled", ...(withLane ? ["changed-lane"] : [])].map(outcome => ({ withLane, outcome }))))("native timeline range capture: $outcome (lane: $withLane) preserves exact target and guards async completion", async ({ withLane, outcome }) => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!; context.binding.type = "sabidurian-timeline";
		const proof: TimelineAxisContext = { protocol_version: 1, entry_id: id(3), definition_id: id(6), generation: id(7), view_id: id(4), registry_revision: 1,
			axis: { id: id(40), kind: "axis", revision: 1, fingerprint: "a".repeat(64), axis: { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "UTC" } } };
		const native = { axis: proof.axis.axis, effectiveTimeZone: "UTC", kinds: ["calendar"], current: () => true };
		Object.assign(s.surface, { rangeContext: () => native });
		const range: TimelineRange = { version: 1, kind: "calendar", start: "2026-01-01", end: "2026-01-02", time_zone: "UTC", start_inclusive: true, end_inclusive: true };
		const location: BaseAnchor = { version: 1, type: "base", definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
			target: { type: "timeline_range", axis_definition_id: id(40), axis_definition_revision: 1, axis: proof.axis.axis, range } };
		const group: PendingBaseGroupAnchor = { version: 1, type: "base_group_pending", entry_id: id(3), property: { source: "note", name: "status" },
			capture: { operation_id: id(41), definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
				group_definition_id: id(42), group_definition_revision: 1, record_id: id(8), record_generation: id(9), dependency: "AA==", time_zone: "UTC", value: { type: "text", value: "Ready" } } };
		if (location.target.type !== "timeline_range") throw new Error("fixture");
		const anchor: BaseAnchor | PendingBaseGroupAnchor = withLane ? { ...group, range: location.target } : location;
		let finish!: (anchor: BaseAnchor | PendingBaseGroupAnchor) => void, alive = true, laneAlive = true;
		const lane: NativeBaseGroupHandle = { target: { type: "group", property: group.property, value: { type: "text", value: "Ready" } }, element: document.createElement("div"),
			ambiguous: false, current: () => laneAlive, members: () => [] };
		const captureGroup = jest.fn().mockResolvedValue(group);
		Object.assign(context.groups!, { capture: captureGroup, canCapture: () => laneAlive });
		const capture = jest.fn(() => new Promise<BaseAnchor | PendingBaseGroupAnchor>(resolve => { finish = resolve; }));
		Object.assign(s.session, { captureTimelineRange: capture, readTimelineAxis: jest.fn().mockResolvedValue(proof) });
		const pending = s.host.commentTimelineRange(context, proof, range, () => alive, withLane ? lane : undefined);
		await Promise.resolve();
		if (outcome === "revoked") s.readOnly();
		if (outcome === "changed-axis") native.axis = { ...native.axis, start_property: { source: "note", name: "other" } };
		if (outcome === "cancelled") alive = false;
		if (outcome === "changed-lane") laneAlive = false;
		finish(anchor); expect(await pending).toBe(outcome === "success");
		if (withLane) { expect(captureGroup).toHaveBeenCalledWith(lane); expect(capture).toHaveBeenCalledWith(s.scope, proof, range, group); }
		else { expect(captureGroup).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledWith(s.scope, proof, range); }
		if (outcome === "success") {
			expect(saved).toHaveBeenCalledWith({ file: s.file, session: s.session, entryId: s.scope, anchor });
			const verification = anchor.type === "base_group_pending" ? pendingRangeLocation(anchor)! : anchor;
			expect(s.savedPreference).toHaveBeenCalled(); expect(await s.host.verifyBaseTarget(context, verification)).toBe(true);
			proof.axis.revision = 2; expect(await s.host.verifyBaseTarget(context, verification)).toBe(false);
		} else { expect(saved).not.toHaveBeenCalled(); expect(s.savedPreference).not.toHaveBeenCalled(); }
		context.release();
	} finally { s.close(); }
});

test("native formula cells and headers capture catalogue identities and refuse changed-definition placement", async () => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		if (s.handle.target.type !== "cell") throw new Error("fixture");
		const property = { source: "formula" as const, name: "total" };
		s.handle.target = { ...s.handle.target, property };
		const anchor: BaseAnchor = { ...await s.session.captureBaseTarget(), target: { type: "formula_cell", record_id: id(8), record_generation: id(9), definition_id: id(10), definition_revision: 1, property } };
		s.session.captureBaseTarget.mockResolvedValue(anchor);
		const context = (await s.context())!;
		expect(context.selection(s.handle.target)).toEqual({ type: "formula_cell", recordId: id(8), definitionId: id(10), definitionRevision: 1 });
		expect(context.selection({ type: "property", property })).toEqual({ type: "formula", definitionId: id(10), definitionRevision: 1 });
		expect(context.native(anchor)).toEqual(s.handle.target);
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(true);
		expect(saved).toHaveBeenCalledWith(expect.objectContaining({ anchor }));
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(true);
		const catalog = await s.session.readBaseDefinitions();
		s.session.readBaseDefinitions.mockResolvedValue({ ...catalog, registry_revision: 2, targets: catalog.targets.map(item => ({ ...item, revision: 2 })) });
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(false);
		context.release();
		const stale = (await s.context())!;
		expect(stale.selection(s.handle.target)).toBeUndefined();
		expect(stale.native(anchor)).toBeUndefined();
		expect(stale.selection({ type: "view" })).toEqual({ type: "view" }); stale.release();
	} finally { s.close(); }
});

test.each(["record", "registry", "account", "access"])("a %s change during native target capture cannot pin or save a stale draft", async change => {
	const s = await nativeBaseFixture(), saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
	try {
		const context = (await s.context())!, anchor = await s.session.captureBaseTarget();
		s.session.captureBaseTarget.mockImplementation(async () => {
			if (change === "record") s.record.id = id(90);
			if (change === "registry") return { ...anchor, registry_revision: 2 };
			if (change === "account") s.account(id(90));
			if (change === "access") s.revoke();
			return anchor;
		});
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(false);
		expect(saved).not.toHaveBeenCalled(); expect(s.savedPreference).not.toHaveBeenCalled(); context.release();
	} finally { s.close(); }
});

test("readers can map native targets but cannot create, and changed record lineage refuses navigation", async () => {
	const s = await nativeBaseFixture();
	try {
		s.readOnly(); const context = (await s.context())!;
		expect(context.selection(s.handle.target)).toBeDefined(); expect(context.canComment(s.handle.target)).toBe(false);
		expect(await s.host.commentBaseHandle(context, s.handle)).toBe(false);
		const anchor = await s.session.captureBaseTarget();
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(true);
		s.session.readBaseContext.mockResolvedValue({ ...await s.session.readBaseContext(), record_generation: id(90) });
		expect(await s.host.verifyBaseTarget(context, anchor)).toBe(false); context.release();
	} finally { s.close(); }
});

test("native discovery releases its subscription when server registry proof is stale", async () => {
	const s = await nativeBaseFixture();
	try {
		s.session.readBaseContext.mockResolvedValue({ ...await s.session.readBaseContext(), registry_revision: 2 });
		expect(await s.context()).toBeUndefined(); expect(s.stops[0]).toHaveBeenCalledTimes(1);
		expect(s.savedPreference).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("a target override cannot substitute another record or property for a native handle", async () => {
	const s = await nativeBaseFixture();
	try {
		const context = (await s.context())!;
		expect(await s.host.commentBaseHandle(context, s.handle, { type: "item", file: new TFile() })).toBe(false);
		expect(await s.host.commentBaseHandle(context, s.handle, { type: "property", property: { source: "note", name: "status" } })).toBe(false);
		expect(s.session.captureBaseTarget).not.toHaveBeenCalled(); context.release();
	} finally { s.close(); }
});

test("target navigation can leave an unvisited native view using the requested scope's verified authority", async () => {
	const s = await nativeBaseFixture();
	try {
		const original = s.surface.bind.getMockImplementation()!;
		s.surface.bind.mockImplementation(async (...args) => ({ ...await original(...args), viewId: id(5), name: "Unvisited cards" }));
		const anchor = await s.session.captureBaseTarget();
		expect(await s.host.activateBaseView(s.surface as unknown as NativeBasesSurface, s.session as unknown as DiscussionSession, s.scope, anchor, () => true)).toBe("changed");
		expect(s.surface.activateView).toHaveBeenCalledWith(id(4), expect.objectContaining({ viewId: id(5) }));
		expect(s.session.readBaseContext).toHaveBeenCalledWith(s.scope); expect(s.savedPreference).not.toHaveBeenCalled();
		s.revoke(); s.surface.activateView.mockClear();
		expect(await s.host.activateBaseView(s.surface as unknown as NativeBasesSurface, s.session as unknown as DiscussionSession, s.scope, anchor, () => true)).toBe("unavailable");
		expect(s.surface.activateView).not.toHaveBeenCalled();
	} finally { s.close(); }
});

test("direct-image read context stops on lost authentication while creation remains separately gated", async () => {
	const test = fixture();
	try {
		await test.start(); test.file.path = "Team/chart.png"; test.file.extension = "png";
		jest.spyOn(test.folder.folderIndex, "recordFor").mockReturnValue({ id: id(3), type: "image" });
		const session = Object.assign(mockSessions[0], { knownDocumentGeneration: () => id(4), canAnchorImageFiles: false,
			permission: () => ({ read: true, comment: true }) });
		expect(test.host.targetFor(test.file).kind).toBe("image");
		const read = test.host.imageFileContext(test.file, false); expect(read.current()).toBe(true);
		expect(() => test.host.imageFileContext(test.file)).toThrow("unavailable");
		session.canAnchorImageFiles = true; expect(test.host.imageFileContext(test.file).current()).toBe(true);
		session.status = "authentication_required"; expect(read.current()).toBe(false);
		expect(() => test.host.imageFileContext(test.file, false)).toThrow("unavailable");
	} finally { test.close(); }
});

test("saved-view restoration is scoped to the current account and does not carry an old selection across sign-in", async () => {
	const s = fixture(), flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
	try {
		await s.start(); s.file.path = "Team/Planning.base"; s.file.extension = "base";
		jest.spyOn(s.folder.folderIndex, "recordFor").mockReturnValue({ id: id(3), type: "file" });
		s.store.preference.mockResolvedValueOnce({ id: id(4), name: "Planning", type: "table", state: "active" });
		expect(s.host.current().entryId).toBeUndefined(); await flush();
		expect(s.host.current()).toMatchObject({ kind: "base", entryId: baseDiscussionScope(id(3), id(4)), baseViewName: "Planning" });
		s.account(id(9)); await flush();
		expect(s.host.current().entryId).toBeUndefined(); await flush();
		expect(s.host.current().entryId).toBeUndefined();
		expect(s.store.preference.mock.calls).toEqual([["activeBaseView:" + id(3)], ["activeBaseView:" + id(3)]]);
	} finally { s.close(); }
});

test.each(["markdown", "image", "audio", "video", "pdf", "canvas", "file"])("%s target labels follow managed record identity across renames and refuse ambiguous path associations", async kind => {
	const s = fixture();
	try {
		let paths = ["Example.md"];
		Object.assign(s.folder.folderIndex, { eachRecord: (visit: (record: { id: string; type: string }, path: string) => void) => {
			for (const path of paths) visit({ id: id(8), type: kind }, path);
		} });
		const session = { identity: { shareId: id(2) } } as DiscussionSession;
		const scope = baseDiscussionScope(id(3), id(4));
		const anchor = { type: "base" as const, version: 1 as const, definition_id: id(6), view_id: id(4), generation: id(7), registry_revision: 1,
			target: { type: "cell" as const, record_id: id(8), record_generation: id(9), property: { source: "note" as const, name: "status" } } };
		expect(s.host.targetLabel(session, scope, anchor)).toBe("Cell: Example.md · note.status");
		paths = ["Renamed.md"]; expect(s.host.targetLabel(session, scope, anchor)).toBe("Cell: Renamed.md · note.status");
		paths.push("Duplicate.md"); expect(s.host.targetLabel(session, scope, anchor)).toContain("Unavailable record");
		expect(s.host.targetLabel(session, baseDiscussionScope(id(3), id(5)), anchor)).toBeUndefined();
	} finally { s.close(); }
});

test("native record selection respects negotiated types, excludes folders/local-only and duplicate IDs, and rechecks a changed record", async () => {
	const s = fixture(), flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
	try {
		await s.start(); s.file.path = "Team/Planning.base"; s.file.extension = "base";
		let records = [
			{ id: id(10), type: "markdown", path: "Note.md" }, { id: id(11), type: "image", path: "Chart.png" },
			{ id: id(12), type: "file", path: "Data.csv" }, { id: id(13), type: "folder", path: "Folder" },
			{ id: id(14), type: "audio", path: "Sound.mp3" }, { id: id(15), type: "image", path: "Missing.png" },
			{ id: id(16), type: "image", path: "Duplicate.png" }, { id: id(16), type: "folder", path: "Duplicate" },
		];
		Object.assign(s.folder, { absolutePath: (path: string) => "Team/" + path, toVirtualPath: (path: string) => path.slice(5) });
		Object.assign(s.folder.folderIndex, {
			recordFor: (path: string) => path === "Planning.base" ? { id: id(3), type: "file" } : records.find(record => record.path === path),
			eachRecord: (visit: (record: { id: string; type: string }, path: string) => void) => records.forEach(record => visit(record, record.path)),
		});
		const session = Object.assign(mockSessions[0], { permission: () => ({ read: true, comment: true }),
			canAnchorBase: () => true, canAnchorBaseRecord: (kind: string) => ["markdown", "image", "file"].includes(kind),
			captureBaseTarget: jest.fn().mockResolvedValue({ type: "base" }) }) as unknown as DiscussionSession;
		s.store.preference.mockResolvedValueOnce({ id: id(4), name: "Planning", type: "table", state: "active" });
		s.host.current(); await flush();
		// An inventory entry without a locally available file cannot be selected.
		const plugin = (s.host as unknown as { plugin: Plugin }).plugin;
		jest.spyOn(plugin.app.vault, "getFileByPath").mockImplementation(path => path === "Team/Missing.png" ? null : s.file);
		const saved = jest.spyOn(s.host, "saveCommentSelection").mockResolvedValue(true);
		await s.host.commentCurrentBase(session, baseDiscussionScope(id(3), id(4)));
		const [, , search, properties, choose] = jest.mocked(BaseTargetPicker).mock.calls.at(-1)!;
		expect(search("").records.map(record => record.path)).toEqual(["Chart.png", "Data.csv", "Note.md"]);
		expect(search("chart").records).toEqual([{ id: id(11), path: "Chart.png", kind: "image" }]);
		expect(properties(id(11))).toEqual([]);
		await expect(choose({ type: "cell", recordId: id(11), property: { source: "note", name: "name" } })).rejects.toThrow("changed");
		expect(await choose({ type: "cell", recordId: id(11), property: { source: "file", name: "size" } })).toBe(true);
		expect(saved).toHaveBeenCalledTimes(1);
		records = records.filter(record => record.id !== id(11));
		await expect(choose({ type: "item", recordId: id(11) })).rejects.toThrow("changed");
		expect(session.captureBaseTarget).toHaveBeenCalledTimes(1);
	} finally { s.close(); }
});

test("switching accounts closes the old session synchronously and uses a distinct cache identity", async () => {
	const test = fixture();
	try {
		await test.start(); const old = mockSessions[0]; expect(test.host.current().entryId).toBe(id(3));
		test.account(id(9)); expect(old.close).toHaveBeenCalledTimes(1); expect(old.status).toBe("closed");
		await Promise.resolve(); await Promise.resolve();
		expect(test.opening.mock.calls.map(([identity]) => identity.accountId)).toEqual([id(1), id(9)]);
		test.account(); expect(test.host.current().session).toBeUndefined(); expect(test.host.current().message).toContain("Sign in");
	} finally { test.close(); }
});

test("a token refresh finishing after logout or endpoint replacement cannot return credentials", async () => {
	const test = fixture();
	try {
		await test.start(); let release!: (value: string) => void;
		test.provider.getValidToken.mockImplementation(() => new Promise(resolve => { release = resolve; }));
		const oldCredential = mockCredentials[0], pending = oldCredential();
		test.settings.servers[0].controlPlaneUrl = "https://two.test"; test.settingsChanged();
		release("old-token"); expect(await pending).toBeUndefined();
		expect(await oldCredential()).toBeUndefined();
		await Promise.resolve(); await Promise.resolve();
		expect(test.opening.mock.calls[1][0].serverId).toBe("https://two.test");
	} finally { test.close(); }
});

test("a local database opening after logout is closed without constructing a session", async () => {
	const test = fixture();
	try {
		let release!: (store: DiscussionStore) => void;
		test.opening.mockImplementation(() => new Promise(resolve => { release = resolve; }));
		await test.start(); test.account(); release(test.store as unknown as DiscussionStore);
		await Promise.resolve(); await Promise.resolve();
		expect(test.store.close).toHaveBeenCalledTimes(1); expect(mockSessions).toHaveLength(0);
	} finally { test.close(); }
});
