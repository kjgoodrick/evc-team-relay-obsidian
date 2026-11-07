/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-require-imports -- Jest's hoisted host mocks require their dependencies inside the factory. */
import { MarkdownView, type Plugin, type TFile, type WorkspaceLeaf } from "obsidian";
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
import { platformFetch } from "../../src/platformFetch";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));

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

function fixture(crossNote = false) {
	const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const token = Buffer.from('{"alg":"HS256"}').toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: id(10), session_id: id(11), exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".synthetic";
	let account: Account | undefined = new Account(crossNote ? id(10) : "member", "Member", "member@example.com", "", crossNote ? token : "");
	const authListeners = new Set<() => void>(), refreshListeners = new Set<() => void>(), viewListeners = new Set<() => void>();
	const auth = { getCurrentUserForServer: () => account,
		getAuthProviderForServer: () => ({ getCurrentUser: () => account ? { id: account.accountId } : undefined, isLoggedIn: () => !!account,
			getToken: () => token, getValidToken: async () => token }),
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
	const folderDoc = new Y.Doc();
	folderDoc.getMap("managed_base_v1").set("snapshot", { owner: true, permissions: {} });
	const folder = { entityGuid: id(3), config: { onpremServerId: "server" }, wantsConnection: true, isRecoveringStructure: false, crdtDoc: folderDoc,
		toVirtualPath: (path: string) => path, absolutePath: (path: string) => path,
		_liveProvider: { managedIndex: { registered: (path: string, entry: string) => notes.some(note => note.view.file?.path === path && note.doc.entityGuid === entry), isBlocked: () => false } },
		folderIndex: { on: () => () => {}, recordFor: (path: string) => { const note = notes.find(note => note.view.file?.path === path); return note && { id: note.doc.entityGuid, type: "markdown" }; },
			eachRecord: (callback: (record: { id: string; type: string }, path: string) => void) => notes.forEach(note => callback({ id: note.doc.entityGuid, type: "markdown" }, note.view.file!.path)) } };
	if (crossNote) for (const note of notes) Object.assign(note.binding.boundDocument, { vaultShare: folder });
	const events = new Map<string, Set<() => void>>();
	const workspace = { getActiveViewOfType: () => active, on: (name: string, fn: () => void) => {
		const listeners = events.get(name) ?? new Set(); listeners.add(fn); events.set(name, listeners);
		return () => listeners.delete(fn);
	} };
	const registry = { trackedViews: notes.map(note => note.binding), isShutDown: false,
		shareRegistry: { toArray: () => [folder], on: () => () => {}, shareFor: (path: string) => notes.find(note => note.view.file?.path === path && !path.startsWith("Private/"))?.binding.boundDocument.vaultShare },
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
	const select = (view: MarkdownView | null) => { active = view; events.get("active-leaf-change")?.forEach(fn => fn()); };
	const openFile = jest.fn(async (file: TFile) => {
		const note = notes.find(note => note.view.file === file)!;
		note.view.leaf = notes[0].view.leaf; note.view.leaf.view = note.view;
		select(note.view);
	});
	for (const note of notes) note.view.leaf = { view: note.view, openFile, getViewState: () => ({ type: "markdown", state: { mode: note.view.getMode(), source: true } }) } as unknown as WorkspaceLeaf;
	const serverSettings = { readValue: () => ({ enabled: true, servers: [{ id: "server", controlPlaneUrl: "https://relay.example" }] }), subscribe: () => () => {} };
	const controller = new PresenceController({ app: { workspace, vault }, addCommand: jest.fn(), registerMarkdownPostProcessor: jest.fn(), registerEditorExtension: (extension: Extension) => extensions.push(extension) } as unknown as Plugin,
		registry as unknown as ViewBindingRegistry, auth, settings as unknown as SettingsScope<PresenceSettings>, crossNote ? serverSettings as unknown as SettingsScope<RelayOnPremSettings> : undefined);
	controller.onload();
	const editors = notes.map(note => {
		const editor = new EditorView({ parent: note.view.contentEl, state: EditorState.create({ doc: note.text.toString(), extensions: [
			editorInfoField.init(() => ({ file: note.view.file, editor: note.view.editor } as never)), ...extensions] }) });
		const stop = bindCommentEditor(editor, () => ({ documentId: note.doc.entityGuid, text: note.text }));
		return { editor, stop };
	});
	return { controller, notes, editors, registry, settings, authListeners, viewListeners, focus, hidden, folder, openFile, select,
		logout: () => { account = undefined; authListeners.forEach(fn => fn()); },
		fileEvent: (event: "rename" | "delete") => { if (event === "delete") deleted = true; events.get(event)?.forEach(fn => fn()); },
		close: () => { controller.unload(); editors.forEach(({ editor, stop }) => { stop(); editor.destroy(); }); notes.forEach(({ doc, view }) => { doc.dismantle(); doc.crdtDoc.destroy(); view.containerEl.remove(); }); folderDoc.destroy(); focus.mockRestore(); hidden.mockRestore(); },
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

test("all authorized Reading panes gain remote observers while only the active pane publishes", async () => {
	const f = fixture(), stops: (() => void)[] = [];
	try {
		for (const note of f.notes) {
			note.mode("preview"); stops.push(bindReadingComments(note.view, () => ({ documentId: note.doc.entityGuid, text: note.text })));
		}
		f.controller.refresh(); expect(document.querySelectorAll(".relay-reading-presence")).toHaveLength(2);
		expect(f.notes[0].doc._liveProvider.awareness.getLocalState()?.surface).toBe("reading"); expect(f.notes[1].doc._liveProvider.awareness.getLocalState()).toBeNull();
		await f.controller.setVisible(false); expect(document.querySelectorAll(".relay-reading-presence")).toHaveLength(2);
		expect(f.notes.every(note => note.doc._liveProvider.awareness.getLocalState() === null)).toBe(true);
		f.notes[1].binding.connectionAllowed = false; f.viewListeners.forEach(fn => fn()); expect(document.querySelectorAll(".relay-reading-presence")).toHaveLength(1);
		f.logout(); expect(document.querySelectorAll(".relay-reading-presence")).toHaveLength(0);
	} finally { stops.forEach(stop => stop()); f.close(); }
});

test("inactive Reading panes retain an observer across disconnect and remove it when their binding closes", () => {
	const f = fixture(); const note = f.notes[1]; note.mode("preview"); note.doc._liveProvider.wsconnected = false;
	const stop = bindReadingComments(note.view, () => ({ documentId: note.doc.entityGuid, text: note.text }));
	try {
		f.controller.refresh(); expect(note.view.contentEl.querySelector(".relay-reading-presence")).not.toBeNull();
		note.doc._liveProvider.wsconnected = true; note.doc._liveProvider.emit("status", [{ status: "connected", intent: "connected" }]);
		expect(note.view.contentEl.querySelector(".relay-reading-presence")).not.toBeNull(); expect(note.doc._liveProvider.awareness.getLocalState()).toBeNull();
		stop(); expect(note.view.contentEl.querySelector(".relay-reading-presence")).toBeNull();
	} finally { stop(); f.close(); }
});

async function settled() { await new Promise(resolve => setTimeout(resolve, 240)); }
function remotePeer(f: ReturnType<typeof fixture>, index = 0) {
	const doc = new Y.Doc(), awareness = new Awareness(doc), target = f.notes[index].doc._liveProvider.awareness;
	const position = (at: number) => Y.createRelativePositionFromTypeIndex(f.notes[index].text, at);
	const state = (at: number) => ({ user: { id: "00000000-0000-4000-8000-000000000008", name: "Peer" }, sessionId: "a".repeat(32), instanceId: "00000000-0000-4000-8000-000000000009", surface: "editor", cursor: { anchor: position(at), head: position(at) }, viewport: position(at) });
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

function crossNetwork() {
	const sockets: ReturnType<typeof makeSocket>[] = [];
	function makeSocket() {
		const socket = { readyState: 0, bufferedAmount: 0, onopen: null as WebSocket["onopen"], onmessage: null as WebSocket["onmessage"],
			onclose: null as WebSocket["onclose"], onerror: null as WebSocket["onerror"], frames: [] as Record<string, unknown>[],
			send: (raw: string) => { socket.frames.push(JSON.parse(raw)); }, close: () => { socket.readyState = 3; },
			message: (value: unknown) => socket.onmessage?.call(socket as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent),
			ready: () => {
				socket.readyState = 1; socket.onopen?.call(socket as unknown as WebSocket, new Event("open"));
				socket.message({ type: "ready", protocol_version: 1, instance_id: socket.frames[0].instance_id, session_id: "b".repeat(32), expires_at: Math.floor(Date.now() / 1000) + 3600 });
			},
			location: (f: ReturnType<typeof fixture>, index?: number) => {
				const subscription = socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id;
				socket.message({ type: "location", subscription_id: subscription, status: index === undefined ? "unavailable" : "available",
					...(index === undefined ? {} : { location: { kind: "note", share_id: f.folder.entityGuid, entry_id: f.notes[index].doc.entityGuid, surface: "reading" } }) });
			},
		};
		return socket;
	}
	jest.mocked(platformFetch).mockImplementation(async url => ({ status: 200, ok: true, text: async () => JSON.stringify(String(url).includes("/capabilities?") ?
		{ protocol_version: 1, features: { presence_locations_preview: true } } : { protocol_version: 1, ticket: "t".repeat(32), expires_in: 30, socket_path: "/v1/collaboration/events" }) }) as Response);
	const mock = jest.spyOn(window, "WebSocket").mockImplementation(url => {
		expect(String(url)).toBe("wss://relay.example/v1/collaboration/events");
		const socket = makeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
	});
	return { sockets, close: () => { mock.mockRestore(); jest.mocked(platformFetch).mockReset(); } };
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	while (!check()) { if (Date.now() > deadline) throw new Error("Presence condition not reached"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("cross-note follow survives old-room departure, opens the authorized entry and resumes semantic following", async () => {
	const network = crossNetwork(), f = fixture(true), first = remotePeer(f); let second: ReturnType<typeof remotePeer> | undefined;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => f.controller.peers.length === 1);
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		expect(socket.frames.filter(frame => frame.type === "follow")).toHaveLength(1);
		first.send(); expect(f.controller.following?.name).toBe("Peer");
		socket.location(f, 1); second = remotePeer(f, 1);
		const dispatch = jest.spyOn(f.editors[1].editor, "dispatch");
		await until(() => f.openFile.mock.calls.length === 1 && dispatch.mock.calls.length > 0);
		expect(f.openFile).toHaveBeenCalledWith(f.notes[1].view.file, { active: true, state: { mode: "source", source: true } });
		expect(f.controller.following?.name).toBe("Peer"); expect(f.notes[1].view.getMode()).toBe("source");
		expect(f.notes.map(note => note.text.toString())).toEqual(["alpha beta", "alpha beta"]);
		expect(network.sockets).toHaveLength(1); // Same account/instance channel across documents.
		f.notes[1].view.contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
		expect(f.controller.following).toBeUndefined();
		const count = dispatch.mock.calls.length; second.send(9); await settled(); expect(dispatch.mock.calls.length).toBe(count);
	} finally { first.close(); second?.close(); f.close(); network.close(); }
});

test.each(["manual", "unavailable", "permission", "privacy", "background"])("cross-note follow handles %s without a late unauthorized navigation", async action => {
	const network = crossNetwork(), f = fixture(true), remote = remotePeer(f);
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => f.controller.peers.length === 1);
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		if (action === "manual") f.select(f.notes[1].view);
		else if (action === "unavailable") socket.location(f);
		else if (action === "permission") f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: {} });
		else if (action === "background") { f.focus.mockReturnValue(false); window.dispatchEvent(new Event("blur")); }
		else {
			await f.controller.setVisible(false);
			expect(f.controller.following?.name).toBe("Peer");
			expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
			f.controller.stopFollowing();
		}
		expect(f.controller.following).toBeUndefined();
		socket.location(f, 1); await settled(); expect(f.openFile).not.toHaveBeenCalled();
	} finally { remote.close(); f.close(); network.close(); }
});
