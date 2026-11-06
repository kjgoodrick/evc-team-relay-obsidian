/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-require-imports -- Jest's hoisted host mocks require their dependencies inside the factory. */
import { MarkdownView, type Plugin } from "obsidian";
import type { AuthSession } from "../../src/AuthSession";
import { Account } from "../../src/Account";
import { ProviderBacked } from "../../src/ProviderBacked";
import { RemoteDocumentAddress } from "../../src/ResourceAddress";
import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import { DocumentViewBinding, type ViewBindingRegistry } from "../../src/ViewBindings";
import type { SettingsScope } from "../../src/SettingsPersistence";
import { PresenceController } from "../../src/collaboration/presence/PresenceController";
import type { PresenceSettings } from "../../src/collaboration/presence/PresenceSettings";
import { bindReadingComments } from "../../src/collaboration/ReadingTextBinding";
import * as Y from "yjs";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { bindCommentEditor } from "../../src/collaboration/EditorTextBinding";
import { applyAwarenessUpdate, encodeAwarenessUpdate, Awareness } from "y-protocols/awareness";

jest.mock("jose", () => {
	const { TextEncoder, TextDecoder } = require("node:util");
	Object.assign(globalThis, { TextEncoder, TextDecoder });
	return jest.requireActual("jose");
});

jest.mock("obsidian", () => {
	class Component {
		stops: (() => void)[] = [];
		register(stop: () => void) { this.stops.push(stop); }
		registerEvent(stop: () => void) { this.register(stop); }
		addChild(child: { onload(): void; unload(): void }) { child.onload(); this.register(() => child.unload()); return child; }
		unload() { (this as unknown as { onunload(): void }).onunload(); this.stops.splice(0).forEach(stop => stop()); }
	}
	return { ...jest.requireActual("obsidian"), Component,
		MarkdownRenderChild: class extends Component { constructor(readonly containerEl: HTMLElement) { super(); } },
		editorInfoField: require("@codemirror/state").StateField.define({ create: () => ({}), update: (value: unknown) => value }),
		MarkdownView: class {}, setIcon: () => {}, Setting: class {},
	};
});
jest.mock("../../src/ViewBindings", () => ({ DocumentViewBinding: class {} }));
Object.assign(HTMLElement.prototype, { setText(this: HTMLElement, text: string) { this.textContent = text; } });

function fixture() {
	let account: Account | undefined = new Account("member", "Member", "member@example.com", "", "");
	const authListeners = new Set<() => void>(), refreshListeners = new Set<() => void>(), viewListeners = new Set<() => void>();
	const auth = { getCurrentUserForServer: () => account,
		on: (fn: () => void) => { authListeners.add(fn); return () => { authListeners.delete(fn); }; },
		onTokenRefreshed: (fn: () => void) => { refreshListeners.add(fn); return () => { refreshListeners.delete(fn); }; },
	} as unknown as AuthSession;
	const credentials = { peekToken: () => undefined } as unknown as RelayCredentialCache;
	const notes = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map(id => {
		const doc = new ProviderBacked(id, new RemoteDocumentAddress("relay-onprem", "00000000-0000-4000-8000-000000000003", id), credentials, auth, "server");
		const text = doc.crdtDoc.getText("contents"); text.insert(0, "alpha beta");
		const file = { path: id + ".md", extension: "md" };
		const containerEl = document.body.appendChild(document.createElement("div"));
		let mode = "source";
		const view = Object.assign(Object.create(MarkdownView.prototype), { file, containerEl, contentEl: containerEl,
			getMode: () => mode, getViewData: () => text.toString(), editor: { hasFocus: () => true, getValue: () => text.toString(), listSelections: () => [{ anchor: { line: 0, ch: 6 }, head: { line: 0, ch: 10 } }], posToOffset: (pos: { ch: number }) => pos.ch },
			addAction: (_icon: string, _title: string, onClick: () => void) => { const button = containerEl.appendChild(document.createElement("button")); button.onclick = onClick; return button; },
		}) as MarkdownView;
		const boundDocument = Object.assign(doc, { crdtText: text, _obsidianFile: file, vaultShare: { config: { onpremServerId: "server" }, wantsConnection: true } });
		const binding = Object.assign(new (DocumentViewBinding as unknown as new () => object)(), { hostView: view, boundDocument, isTracking: true, wantsConnection: true, connectionAllowed: true });
		doc._liveProvider.wsconnected = true;
		return { doc, view, binding, text, mode: (value: string) => { mode = value; } };
	});
	let active: MarkdownView | null = notes[0].view;
	const events = new Map<string, Set<() => void>>();
	const workspace = { getActiveViewOfType: () => active, on: (name: string, fn: () => void) => {
		const listeners = events.get(name) ?? new Set(); listeners.add(fn); events.set(name, listeners);
		return () => listeners.delete(fn);
	} };
	const registry = { trackedViews: notes.map(note => note.binding), isShutDown: false,
		shareRegistry: { shareFor: (path: string) => notes.find(note => note.view.file?.path === path && !path.startsWith("Private/"))?.binding.boundDocument.vaultShare },
		onViewsChanged: (fn: () => void) => { viewListeners.add(fn); return () => viewListeners.delete(fn); } };
	let preferences = { visible: true };
	const settingListeners = new Set<(value: PresenceSettings) => void>();
	const settings = { readValue: () => preferences, subscribe: (fn: (value: PresenceSettings) => void) => {
		settingListeners.add(fn); fn(preferences); return () => settingListeners.delete(fn);
	}, mutateValue: async (fn: (value: PresenceSettings) => PresenceSettings) => { preferences = fn(preferences); settingListeners.forEach(listener => listener(preferences)); } };
	const focus = jest.spyOn(document, "hasFocus").mockReturnValue(true), hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false);
	let deleted = false;
	const vault = { on: workspace.on, getFileByPath: (path: string) => deleted ? null : notes.find(note => note.view.file?.path === path)?.view.file };
	const extensions: Extension[] = [];
	const controller = new PresenceController({ app: { workspace, vault }, addCommand: jest.fn(), registerMarkdownPostProcessor: jest.fn(), registerEditorExtension: (extension: Extension) => extensions.push(extension) } as unknown as Plugin,
		registry as unknown as ViewBindingRegistry, auth, settings as unknown as SettingsScope<PresenceSettings>);
	controller.onload();
	const editors = notes.map(note => {
		const editor = new EditorView({ parent: note.view.contentEl, state: EditorState.create({ doc: note.text.toString(), extensions: [
			editorInfoField.init(() => ({ file: note.view.file, editor: note.view.editor } as never)), ...extensions] }) });
		const stop = bindCommentEditor(editor, () => ({ documentId: note.doc.entityGuid, text: note.text }));
		return { editor, stop };
	});
	return { controller, notes, editors, registry, settings, authListeners, viewListeners, focus, hidden,
		select: (view: MarkdownView | null) => { active = view; events.get("active-leaf-change")?.forEach(fn => fn()); },
		logout: () => { account = undefined; authListeners.forEach(fn => fn()); },
		fileEvent: (event: "rename" | "delete") => { if (event === "delete") deleted = true; events.get(event)?.forEach(fn => fn()); },
		close: () => { controller.unload(); editors.forEach(({ editor, stop }) => { stop(); editor.destroy(); }); notes.forEach(({ doc, view }) => { doc.dismantle(); doc.crdtDoc.destroy(); view.containerEl.remove(); }); focus.mockRestore(); hidden.mockRestore(); },
	};
}

test("only the active bound note publishes; private views and unloaded bindings clear the previous location", () => {
	const f = fixture();
	try {
		const [first, second] = f.notes;
		expect(first.doc._liveProvider.awareness.getLocalState()?.surface).toBe("editor");
		expect(first.doc._liveProvider.awareness.getLocalState()?.instanceId).toBe(f.controller.instanceId);
		expect(f.controller.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(second.doc._liveProvider.awareness.getLocalState()).toBeNull();
		const position = first.doc._liveProvider.awareness.getLocalState()!.cursor.head;
		expect(Y.createAbsolutePositionFromRelativePosition(position, first.doc.crdtDoc)?.index).toBe(10);
		f.select(second.view);
		expect(first.doc._liveProvider.awareness.getLocalState()).toBeNull();
		expect(second.doc._liveProvider.awareness.getLocalState()?.surface).toBe("editor");
		expect(second.doc._liveProvider.awareness.getLocalState()?.instanceId).toBe(f.controller.instanceId);
		f.select(null); expect(second.doc._liveProvider.awareness.getLocalState()).toBeNull();
		f.select(first.view); f.registry.trackedViews = [];
		f.viewListeners.forEach(fn => fn()); expect(first.doc._liveProvider.awareness.getLocalState()).toBeNull();
	} finally { f.close(); }
});

async function settled() { await new Promise(resolve => setTimeout(resolve, 240)); }
function remotePeer(f: ReturnType<typeof fixture>) {
	const doc = new Y.Doc(), awareness = new Awareness(doc), target = f.notes[0].doc._liveProvider.awareness;
	const position = (at: number) => Y.createRelativePositionFromTypeIndex(f.notes[0].text, at);
	const state = (at: number) => ({ user: { id: "peer", name: "Peer" }, sessionId: "a".repeat(32), surface: "editor", cursor: { anchor: position(at), head: position(at) }, viewport: position(at) });
	const send = (at?: number) => { awareness.setLocalState(at === undefined ? null : state(at)); applyAwarenessUpdate(target, encodeAwarenessUpdate(awareness, [awareness.clientID]), "test"); };
	send(6); return { send, close: () => { awareness.destroy(); doc.destroy(); } };
}

test("roster navigation follows semantic positions without changing the local selection or note", async () => {
	const f = fixture(), remote = remotePeer(f);
	try {
		await settled(); const editor = f.editors[0].editor, original = editor.state.selection.toJSON();
		expect(f.controller.peers.map(peer => peer.name)).toEqual(["Peer"]);
		const dispatch = jest.spyOn(editor, "dispatch");
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		expect(f.controller.following?.name).toBe("Peer");
		expect(document.querySelector(".relay-presence-follow")?.textContent).toContain("Following Peer");
		const count = dispatch.mock.calls.length; remote.send(9); await settled();
		expect(dispatch.mock.calls.length).toBeGreaterThan(count);
		expect(editor.state.selection.toJSON()).toEqual(original); expect(editor.state.doc.toString()).toBe("alpha beta");
		f.notes[0].view.contentEl.dispatchEvent(new MouseEvent("pointermove", { bubbles: true })); expect(f.controller.following).toBeDefined();
		f.notes[0].view.contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); expect(f.controller.following).toBeUndefined();
		expect(document.querySelector(".relay-presence-follow")).toBeNull();
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		f.notes[0].mode("preview"); f.controller.refresh(); expect(f.controller.following).toBeUndefined();
	} finally { remote.close(); f.close(); }
});

test("follow stops and stale roster actions reject after leave, disconnect or access loss", async () => {
	const f = fixture(), remote = remotePeer(f);
	try {
		await settled(); const key = f.controller.peers[0].key;
		expect(await f.controller.navigate(key, true)).toBe(true); remote.send();
		expect(f.controller.following).toBeUndefined(); expect(await f.controller.navigate(key, false)).toBe(false);
		remote.send(5); await settled(); expect(await f.controller.navigate(key, true)).toBe(true);
		f.notes[0].binding.connectionAllowed = false; f.viewListeners.forEach(fn => fn());
		expect(f.controller.peers).toEqual([]); expect(f.controller.following).toBeUndefined();
		f.notes[0].binding.connectionAllowed = true; f.viewListeners.forEach(fn => fn());
		expect(await f.controller.navigate(key, true)).toBe(true);
		f.notes[0].doc._liveProvider.wsconnected = false; f.controller.refresh();
		expect(f.controller.peers).toEqual([]); expect(f.controller.following).toBeUndefined();
	} finally { remote.close(); f.close(); }
});

test("privacy, blur and background clear immediately and network updates cannot resurrect a hidden view", async () => {
	const f = fixture(), provider = f.notes[0].doc._liveProvider;
	try {
		await f.controller.setVisible(false); expect(provider.awareness.getLocalState()).toBeNull();
		provider.emit("status", [{ status: "connected", intent: "connected" }]);
		expect(provider.awareness.getLocalState()).toBeNull(); expect(f.controller.status).toBe("hidden");
		await f.controller.setVisible(true); expect(provider.awareness.getLocalState()).not.toBeNull();
		window.dispatchEvent(new Event("blur")); expect(provider.awareness.getLocalState()).toBeNull();
		f.controller.refresh(); expect(provider.awareness.getLocalState()).toBeNull();
		window.dispatchEvent(new Event("focus")); expect(provider.awareness.getLocalState()).not.toBeNull();
		f.hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
		expect(provider.awareness.getLocalState()).toBeNull();
		f.hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange"));
		expect(provider.awareness.getLocalState()).not.toBeNull();
		f.logout(); expect(provider.awareness.getLocalState()).toBeNull();
	} finally { f.close(); }
});

test("Reading presence needs the actual shared binding and never carries the editor caret", () => {
	const f = fixture(), note = f.notes[0]; let stop: (() => void) | undefined;
	try {
		note.mode("preview"); f.controller.refresh();
		expect(note.doc._liveProvider.awareness.getLocalState()).toBeNull();
		stop = bindReadingComments(note.view, () => ({ documentId: note.doc.entityGuid, text: note.text }));
		expect(note.doc._liveProvider.awareness.getLocalState()).toMatchObject({ surface: "reading", cursor: null });
		stop(); stop = undefined; expect(note.doc._liveProvider.awareness.getLocalState()).toBeNull();
	} finally { stop?.(); f.close(); }
});

test.each(["rename", "delete"] as const)("%s clears presence before the asynchronous view registry catches up", event => {
	const f = fixture(), note = f.notes[0];
	try {
		if (event === "rename") note.view.file!.path = "Private/Moved.md";
		f.fileEvent(event);
		expect(f.registry.trackedViews).toContain(note.binding);
		expect(note.doc._liveProvider.awareness.getLocalState()).toBeNull();
	} finally { f.close(); }
});

test("status and explicit retry reflect the active provider; unload removes state, controls and listeners", () => {
	const f = fixture(), provider = f.notes[0].doc._liveProvider;
	try {
		provider.presence.disconnected(4429);
		expect(f.controller.status).toBe("capacity"); expect(f.controller.canRetry).toBe(true);
		f.controller.retry(); expect(provider.presence.availability).toBe("ready");
		expect(document.querySelector(".relay-presence-action")?.getAttribute("aria-label")).toContain("visible");
		f.controller.unload();
		expect(provider.awareness.getLocalState()).toBeNull();
		expect(document.querySelector(".relay-presence-action")).toBeNull();
		expect(f.viewListeners.size).toBe(0);
		window.dispatchEvent(new Event("focus")); expect(provider.awareness.getLocalState()).toBeNull();
	} finally { f.close(); }
});
