/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-require-imports -- Jest's hoisted host mocks require their dependencies inside the factory. */
import { FileView, MarkdownView, TFile, type Plugin, type WorkspaceLeaf, type MarkdownPostProcessorContext } from "obsidian";
import { createHash, webcrypto } from "node:crypto";
import { StringValue } from "../mocks/nativeBaseValues";
import type { BasePresenceState } from "../../src/collaboration/presence/BasePositionProtocol";
import type { ImageLocation, ImagePresenceState } from "../../src/collaboration/presence/LocationProtocol";
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
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { bindCommentEditor } from "../../src/collaboration/EditorTextBinding";
import { applyAwarenessUpdate, encodeAwarenessUpdate, Awareness } from "y-protocols/awareness";
import { platformFetch } from "../../src/platformFetch";
import { EmbeddedImageAnchors } from "../../src/collaboration/presence/EmbeddedImageAnchors";
import type { EmbeddedImage } from "../../src/collaboration/presence/EmbeddedImageProtocol";
import type { RelayOnPremSettings } from "../../src/RelayOnPremConfig";
import { nativePresenceBase } from "../mocks/nativePresenceBase";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));

jest.mock("jose", () => {
	const { TextEncoder, TextDecoder } = require("node:util");
	Object.assign(window, { TextEncoder, TextDecoder });
	return jest.requireActual("jose");
});

jest.mock("obsidian", () => {
	class Component {
		stops: (() => void)[] = [];
		register(stop: () => void) { this.stops.push(stop); }
		registerEvent(stop: () => void) { this.register(stop); }
		addChild(child: { onload(): void; unload(): void }) { child.onload(); this.register(() => child.unload()); return child; }
		unload() { (this as unknown as { onunload?: () => void }).onunload?.(); this.stops.splice(0).forEach(stop => stop()); }
	}
	class FileView {}
	return { ...jest.requireActual("obsidian"), ...jest.requireActual("../mocks/nativeBaseValues"), TFile: jest.requireActual("obsidian").TFile, Component,
		apiVersion: "1.13.7", parseYaml: (source: string) => JSON.parse(source),
		MarkdownRenderChild: class extends Component { constructor(readonly containerEl: HTMLElement) { super(); } },
		editorInfoField: require("@codemirror/state").StateField.define({ create: () => ({}), update: (value: unknown) => value }),
		FileView, MarkdownView: class extends FileView {}, setIcon: () => {}, Setting: class {},
	};
});
jest.mock("../../src/ViewBindings", () => ({ DocumentViewBinding: class {} }));
Object.assign(HTMLElement.prototype, { setText(this: HTMLElement, text: string) { this.textContent = text; } });

function fixture(crossNote = false, withImage = false, withBase = false) {
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
		const file: TFile = Object.assign(Object.create(TFile.prototype), { path: id + ".md", extension: "md", stat: { mtime: 1, size: 10 } });
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
	const bytes = new TextEncoder().encode("image-presence-fixture"), imageHash = createHash("sha256").update(bytes).digest("hex");
	const oldSubtle = Object.getOwnPropertyDescriptor(crypto, "subtle");
	if (withImage || withBase) Object.defineProperty(crypto, "subtle", { value: webcrypto.subtle, configurable: true });
	const base = withBase ? nativePresenceBase() : undefined;
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- Synthetic native file metadata for the host fixture.
	const imageFile = { path: "Picture.png", extension: "png", stat: { mtime: 1, size: bytes.byteLength } } as TFile;
	const imageRoot = document.createElement("div"), imageElement = imageRoot.appendChild(document.createElement("img"));
	imageElement.src = "app://local/Picture.png";
	Object.defineProperties(imageElement, { complete: { value: true, configurable: true }, naturalWidth: { value: 800, configurable: true }, naturalHeight: { value: 500, configurable: true } });
	imageElement.scrollIntoView = jest.fn();
	if (withImage) document.body.append(imageRoot);
	const imageView = Object.assign(Object.create(FileView.prototype), { file: imageFile, containerEl: imageRoot, contentEl: imageRoot,
		addAction: (_icon: string, _title: string, onClick: () => void) => { const button = imageRoot.appendChild(document.createElement("button")); button.onclick = onClick; return button; },
	}) as FileView;
	const imageRecord = { id: id(20), type: "image", hash: imageHash };
	const imageLocation = { kind: "image" as const, share_id: id(3), entry_id: id(20), generation: id(21), content_sha256: imageHash };
	let active: FileView | null = notes[0].view;
	const folderDoc = new Y.Doc();
	folderDoc.getMap("managed_base_v1").set("snapshot", { owner: true, permissions: {} });
	const folder = { entityGuid: id(3), config: { onpremServerId: "server" }, wantsConnection: true, isRecoveringStructure: false, crdtDoc: folderDoc,
		toVirtualPath: (path: string) => path, absolutePath: (path: string) => path,
		_liveProvider: { managedIndex: { registered: (path: string, entry: string) => !!base && path === base.file.path && entry === base.record.id || withImage && path === imageFile.path && entry === imageRecord.id || notes.some(note => note.view.file?.path === path && note.doc.entityGuid === entry), isBlocked: () => false } },
		folderIndex: { on: () => () => {}, recordFor: (path: string) => { if (base && path === base.file.path) return base.record; if (withImage && path === imageFile.path) return imageRecord; const note = notes.find(note => note.view.file?.path === path); return note && { id: note.doc.entityGuid, type: "markdown" }; },
			eachRecord: (callback: (record: { id: string; type: string }, path: string) => void) => { notes.forEach(note => callback({ id: note.doc.entityGuid, type: "markdown" }, note.view.file!.path)); if (withImage) callback(imageRecord, imageFile.path); if (base) callback(base.record, base.file.path); } } };
	if (crossNote) for (const note of notes) Object.assign(note.binding.boundDocument, { vaultShare: folder });
	const events = new Map<string, Set<() => void>>();
	const extraViews: FileView[] = [];
	const workspace = { iterateAllLeaves: (callback: (leaf: Pick<WorkspaceLeaf, "view">) => void) => {
		for (const view of [...notes.map(note => note.view), ...(withImage ? [imageView] : []), ...extraViews]) callback({ view });
	}, trigger: jest.fn(), offref: (ref: unknown) => { if (typeof ref === "function") ref(); }, getActiveViewOfType: (type: typeof FileView | typeof MarkdownView) => active && (active instanceof type || type === FileView && active instanceof MarkdownView) ? active : null, on: (name: string, fn: () => void) => {
		const listeners = events.get(name) ?? new Set(); listeners.add(fn); events.set(name, listeners);
		return () => listeners.delete(fn);
	} };
	const registry = { trackedViews: notes.map(note => note.binding), isShutDown: false,
		shareRegistry: { toArray: () => [folder], on: () => () => {}, shareFor: (path: string) => base && path === base.file.path || withImage && path === imageFile.path ? folder : notes.find(note => note.view.file?.path === path && !path.startsWith("Private/"))?.binding.boundDocument.vaultShare },
		onViewsChanged: (fn: () => void) => { viewListeners.add(fn); return () => viewListeners.delete(fn); } };
	let preferences = { visible: true };
	const settingListeners = new Set<(value: PresenceSettings) => void>();
	const settings = { readValue: () => preferences, subscribe: (fn: (value: PresenceSettings) => void) => {
		settingListeners.add(fn); fn(preferences); return () => settingListeners.delete(fn);
	}, mutateValue: async (fn: (value: PresenceSettings) => PresenceSettings) => { preferences = fn(preferences); settingListeners.forEach(listener => listener(preferences)); } };
	const focus = jest.spyOn(document, "hasFocus").mockReturnValue(true), hidden = jest.spyOn(document, "hidden", "get").mockReturnValue(false);
	let deleted = false;
	const vault = { on: workspace.on, getFileByPath: (path: string) => deleted ? null : base && path === base.file.path ? base.file : withImage && path === imageFile.path ? imageFile : notes.find(note => note.view.file?.path === path)?.view.file,
		read: jest.fn(async () => base?.source ?? ""), getResourcePath: () => "app://local/Picture.png", readBinary: jest.fn(async () => bytes.buffer) };
	Object.assign(imageView, { app: { vault } });
	const extensions: Extension[] = [], processors: Parameters<Plugin["registerMarkdownPostProcessor"]>[0][] = [];
	const select = (view: FileView | null) => { active = view; events.get("active-leaf-change")?.forEach(fn => fn()); };
	const openFile = jest.fn(async (file: TFile) => {
		const view = base && file === base.file ? base.view : file === imageFile ? imageView : notes.find(note => note.view.file === file)!.view;
		view.leaf = active?.leaf ?? notes[0].view.leaf; view.leaf.view = view;
		select(view);
	});
	for (const note of notes) note.view.leaf = { view: note.view, openFile, getViewState: () => ({ type: "markdown", state: { mode: note.view.getMode(), source: true } }) } as unknown as WorkspaceLeaf;
	imageView.leaf = { view: imageView, openFile, getViewState: () => ({ type: "image", state: {} }) } as unknown as WorkspaceLeaf;
	if (base) base.view.leaf = { view: base.view, openFile, getViewState: () => ({ type: "bases", state: {} }) } as unknown as WorkspaceLeaf;
	const serverSettings = { readValue: () => ({ enabled: true, servers: [{ id: "server", controlPlaneUrl: "https://relay.example" }] }), subscribe: () => () => {} };
	const controller = new PresenceController({ app: { workspace, vault, metadataCache: { getFirstLinkpathDest: () => imageFile } }, addCommand: jest.fn(), registerMarkdownPostProcessor: (processor: Parameters<Plugin["registerMarkdownPostProcessor"]>[0]) => processors.push(processor), registerEditorExtension: (extension: Extension) => extensions.push(extension) } as unknown as Plugin,
		registry as unknown as ViewBindingRegistry, auth, settings as unknown as SettingsScope<PresenceSettings>, crossNote ? serverSettings as unknown as SettingsScope<RelayOnPremSettings> : undefined);
	controller.onload();
	const editors = notes.map(note => {
		const editor = new EditorView({ parent: note.view.contentEl, state: EditorState.create({ doc: note.text.toString(), extensions: [
			editorInfoField.init(() => ({ file: note.view.file, editor: note.view.editor } as never)), ...extensions] }) });
		const stop = bindCommentEditor(editor, () => ({ documentId: note.doc.entityGuid, text: note.text }));
		return { editor, stop };
	});
	return { controller, notes, editors, extensions, processors, registry, settings, authListeners, viewListeners, focus, hidden, folder, openFile, select, base, workspace, extraViews,
		image: { file: imageFile, view: imageView, element: imageElement, record: imageRecord, location: imageLocation }, vault,
		logout: () => { account = undefined; authListeners.forEach(fn => fn()); },
		fileEvent: (event: "rename" | "delete" | "modify") => { if (event === "delete") deleted = true; events.get(event)?.forEach(fn => fn()); },
		close: () => { controller.unload(); editors.forEach(({ editor, stop }) => { stop(); editor.destroy(); }); notes.forEach(({ doc, view }) => { doc.dismantle(); doc.crdtDoc.destroy(); view.containerEl.remove(); }); imageRoot.remove(); base?.close(); if (withImage || withBase) { if (oldSubtle) Object.defineProperty(crypto, "subtle", oldSubtle); else Reflect.deleteProperty(crypto, "subtle"); } folderDoc.destroy(); focus.mockRestore(); hidden.mockRestore(); },
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

async function settled() { await new Promise(resolve => window.setTimeout(resolve, 240)); }
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

function crossNetwork(surfaces = false, imageContext?: () => unknown | Promise<unknown>, embeds = false, baseContext?: () => unknown | Promise<unknown>, baseRecordContext?: (entry: string) => unknown | Promise<unknown>, multiWatch = false) {
	const sockets: ReturnType<typeof makeSocket>[] = [];
	function makeSocket() {
		const socket = { readyState: 0, bufferedAmount: 0, onopen: null as WebSocket["onopen"], onmessage: null as WebSocket["onmessage"],
			onclose: null as WebSocket["onclose"], onerror: null as WebSocket["onerror"], frames: [] as Record<string, unknown>[],
			send: (raw: string) => { socket.frames.push(JSON.parse(raw)); }, close: () => { socket.readyState = 3; },
			message: (value: unknown) => socket.onmessage?.call(socket as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent),
			ready: () => {
				socket.readyState = 1; socket.onopen?.call(socket as unknown as WebSocket, new Event("open"));
				socket.message({ type: "ready", protocol_version: surfaces ? 2 : 1, instance_id: socket.frames[0].instance_id, session_id: "b".repeat(32), expires_at: Math.floor(Date.now() / 1000) + 3600 });
			},
			location: (f: ReturnType<typeof fixture>, index?: number) => {
				const subscription = socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id;
				socket.message({ type: "location", subscription_id: subscription, status: index === undefined ? "unavailable" : "available",
					...(index === undefined ? {} : { location: { kind: "note", share_id: f.folder.entityGuid, entry_id: f.notes[index].doc.entityGuid, surface: "reading" } }) });
			},
			imageLocation: (f: ReturnType<typeof fixture>) => socket.message({ type: "location", subscription_id: socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id, status: "available", location: f.image.location }),
			imageState: () => socket.message({ type: "image_states", subscription_id: socket.frames.filter(frame => frame.type === "watch").at(-1)!.subscription_id, status: "available",
				peers: [{ target: { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" }, state: { pointer: { x: 0.25, y: 0.75 }, viewport: { x: 0, y: 0, width: 1, height: 1 } } }] }),
			roster: (available = true) => socket.message({ type: "roster", subscription_id: socket.frames.filter(frame => frame.type === "watch").at(-1)!.subscription_id,
				status: available ? "available" : "unavailable", ...(available ? { peers: [{ target: { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" }, name: "Peer" }] } : {}) }),
		};
		return socket;
	}
	jest.mocked(platformFetch).mockImplementation(async url => ({ status: 200, ok: true, text: async () => JSON.stringify(String(url).includes("/capabilities?") ?
		{ protocol_version: 1, features: { presence_locations_preview: true, ...(surfaces ? { presence_surface_locations_preview: true, presence_surface_roster_preview: true, presence_image_context_preview: true, presence_image_states_preview: true, presence_embedded_images_preview: embeds, presence_multi_watch_preview: multiWatch, presence_base_context_preview: !!baseContext, presence_base_states_preview: !!baseRecordContext, presence_base_targets_v2_preview: !!baseRecordContext } : {}) } } :
		String(url).includes("/base-record-context?") ? await baseRecordContext?.(new URL(String(url)).searchParams.get("entry_id")!) : String(url).includes("/base-context?") ? await baseContext?.() : String(url).includes("/image-location?") ? { protocol_version: 1, location: await imageContext?.() } : { protocol_version: 1, ticket: "t".repeat(32), expires_in: 30, socket_path: "/v1/collaboration/events" }) }) as Response);
	const mock = jest.spyOn(window, "WebSocket").mockImplementation(url => {
		expect(String(url)).toBe("wss://relay.example/v1/collaboration/events");
		const socket = makeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
	});
	return { sockets, close: () => { mock.mockRestore(); jest.mocked(platformFetch).mockReset(); } };
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 3000;
	const failure = new Error("Presence condition not reached");
	while (!check()) { if (Date.now() > deadline) throw failure; await new Promise(resolve => window.setTimeout(resolve, 20)); }
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

test("verified saved-view presence shares the note socket, supports hidden reviewers and resets on denial/reconnect", async () => {
	const network = crossNetwork(true, undefined, false, () => f.base!.context), f = fixture(true, false, true), base = f.base!;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: { [base.file.path]: "read" } });
		// Select the readable Base after the previous note loses access.
		f.select(base.view); await until(() => network.sockets.length === 2); const active = network.sockets[1]; active.ready();
		await until(() => active.frames.some(frame => frame.type === "watch")); active.roster();
		await until(() => (active.frames.filter(frame => frame.type === "presence").at(-1)?.location as { kind?: string })?.kind === "base");
		expect(f.controller.status).toBe("ready"); expect(f.controller.surfaceName).toBe("Bases view"); expect(f.controller.peers[0].surface).toBe("base");
		expect(f.notes.every(note => note.doc._liveProvider.awareness.getLocalState() === null)).toBe(true);
		expect(await f.controller.navigate(f.controller.peers[0].key, false)).toBe(true);
		expect(base.renderers[0].scrollEl.scrollIntoView).toHaveBeenCalledTimes(1);
		await f.controller.setVisible(false); expect(f.controller.peers).toHaveLength(1);
		expect(active.frames.filter(frame => frame.type === "presence").at(-1)).toEqual({ type: "presence", location: null });
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		active.roster(false); expect(f.controller.following).toBeUndefined(); expect(f.controller.peers).toEqual([]); expect(f.controller.canRetry).toBe(true);
		const reads = f.vault.read.mock.calls.length; for (let i = 0; i < 20; i++) f.controller.refresh(); expect(f.vault.read).toHaveBeenCalledTimes(reads);
		const start = active.frames.length; f.controller.retry(); await until(() => active.frames.slice(start).some(frame => frame.type === "watch")); active.roster();
		expect(f.controller.following).toBeUndefined(); expect(f.vault.read.mock.calls.length).toBeGreaterThan(reads);
		active.readyState = 3; active.onclose?.call(active as unknown as WebSocket, { code: 1006 } as CloseEvent);
		await until(() => network.sockets.length === 3); const next = network.sockets[2]; next.ready();
		await until(() => next.frames.some(frame => frame.type === "watch")); next.roster();
		expect(next.frames.some(frame => frame.type === "follow")).toBe(false);
		f.focus.mockReturnValue(false); window.dispatchEvent(new Event("blur")); expect(f.controller.peers).toEqual([]); expect(next.readyState).toBe(3);
	} finally { f.close(); network.close(); }
});

test("Follow crosses note, two saved views, image and note without saving configuration or reopening the same Base", async () => {
	const network = crossNetwork(true, () => f.image.location, false, () => f.base!.context), f = fixture(true, true, true), base = f.base!;
	const first = remotePeer(f); let second: ReturnType<typeof remotePeer> | undefined;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => f.controller.peers.length === 1); expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		const before = f.editors.map(item => item.editor.state.selection.toJSON()); first.send();
		const sendBase = (slot: number) => socket.message({ type: "location", subscription_id: socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id, status: "available", location: base.location(slot) });
		sendBase(0); await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
		await until(() => f.controller.following?.surface === "base"); expect(f.openFile).toHaveBeenCalledTimes(1);
		const start = socket.frames.length; sendBase(1);
		await until(() => socket.frames.slice(start).some(frame => frame.type === "watch" && (frame.location as { view_id?: string }).view_id === base.location(1).view_id)); socket.roster();
		await until(() => jest.mocked(base.renderers[1].scrollEl.scrollIntoView).mock.calls.length > 0);
		expect(base.controller.selectView).toHaveBeenCalledTimes(1); expect(base.controller.selectView).toHaveBeenCalledWith("Cards"); expect(f.openFile).toHaveBeenCalledTimes(1);
		expect(f.vault.read).toHaveBeenCalledTimes(1); expect(base.host.data).toBe(base.source); expect(base.host.lastSavedData).toBe(base.source); expect(base.host.dirty).toBe(false);
		const next = socket.frames.length; socket.imageLocation(f);
		await until(() => socket.frames.slice(next).some(frame => frame.type === "watch" && (frame.location as { kind?: string }).kind === "image")); socket.roster();
		await until(() => f.controller.following?.surface === "image"); second = remotePeer(f, 1); socket.location(f, 1);
		await until(() => f.controller.following?.surface === "editor"); expect(network.sockets).toHaveLength(1);
		expect(f.editors.map(item => item.editor.state.selection.toJSON())).toEqual(before);
	} finally { first.close(); second?.close(); f.close(); network.close(); }
});

test.each(["revision", "unknown-view", "manual", "permission"])("Bases Follow stops on %s without changing saved configuration", async change => {
	const network = crossNetwork(true, undefined, false, () => f.base!.context), f = fixture(true, false, true), base = f.base!;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(base.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		if (change === "manual") base.content.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
		else if (change === "permission") f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: {} });
		else {
			const location = { ...base.location(1), ...(change === "revision" ? { registry_revision: 2 } : { view_id: "00000000-0000-4000-8000-000000000099" }) };
			socket.message({ type: "location", subscription_id: socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id, status: "available", location });
		}
		await until(() => !f.controller.following); expect(base.controller.selectView).not.toHaveBeenCalled(); expect(base.host.data).toBe(base.source);
	} finally { f.close(); network.close(); }
});

test("a newer Follow destination supersedes an in-flight Base open without cancelling the subscription", async () => {
	const network = crossNetwork(true, undefined, false, () => f.base!.context), f = fixture(true, false, true), base = f.base!;
	const first = remotePeer(f); let second: ReturnType<typeof remotePeer> | undefined;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => f.controller.peers.length === 1); expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		const open = f.openFile.getMockImplementation()!; let finish!: () => Promise<void>;
		f.openFile.mockImplementationOnce(file => new Promise(resolve => { finish = async () => { await open(file); resolve(); }; }));
		socket.message({ type: "location", subscription_id: socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id, status: "available", location: base.location(1) });
		await until(() => !!finish); second = remotePeer(f, 1); socket.location(f, 1); await finish();
		await until(() => f.openFile.mock.calls.length === 2 && f.controller.following?.surface === "editor");
		expect(f.openFile.mock.calls[1][0]).toBe(f.notes[1].view.file); expect(base.controller.selectView).not.toHaveBeenCalled();
		expect(socket.frames.filter(frame => frame.type === "follow")).toHaveLength(1); expect(network.sockets).toHaveLength(1);
	} finally { first.close(); second?.close(); f.close(); network.close(); }
});

test("Bases host withdraws dirty source and discards late verification after logout", async () => {
	const network = crossNetwork(true, undefined, false, () => f.base!.context), f = fixture(true, false, true), base = f.base!;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(base.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster(); expect(f.controller.peers).toHaveLength(1);
		base.host.dirty = true; f.controller.refresh(); expect(f.controller.peers).toEqual([]); expect(f.controller.status).toBe("unavailable");
		expect(socket.frames.filter(frame => frame.type === "presence").at(-1)).toEqual({ type: "presence", location: null });
		let finish!: (source: string) => void; f.vault.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		base.host.dirty = false; f.controller.retry(); await until(() => !!finish); f.logout(); finish(base.source); await settled();
		expect(socket.readyState).toBe(3); expect(f.controller.peers).toEqual([]); expect(base.controller.selectView).not.toHaveBeenCalled();
	} finally { f.close(); network.close(); }
});

test("Time & Line bridge supports saved-view Follow and respects navigation locks without saved layout changes", async () => {
	const network = crossNetwork(true, undefined, false, () => f.base!.context), f = fixture(true, false, true), base = f.base!;
	let busy = false, changed: (() => void) | undefined;
	base.serial.views[1].type = base.renderers[1].type = base.renderers[1].config.type = "sabidurian-timeline";
	base.source = base.host.data = base.host.lastSavedData = JSON.stringify(base.serial); base.record.hash = createHash("sha256").update(base.source).digest("hex");
	base.file.stat.size = Buffer.byteLength(base.source); base.file.stat.mtime++;
	base.context = { ...base.context, content_sha256: base.record.hash, views: base.context.views.map(view => view.slot === 1 ? { ...view, type: "sabidurian-timeline" } : view) };
	const renderer = base.renderers[1], remote = { protocolVersion: 1, owner: renderer, root: renderer.containerEl,
		capabilities: ["item", "cell", "geometry", "reveal", "annotation"], current: () => base.controller.view === renderer && renderer.containerEl.isConnected,
		viewport: () => renderer.scrollEl, handles: () => [], hit: () => undefined, reveal: () => "revealed", beginAnnotation: () => () => {} };
	const bridge = { protocolVersion: 1, available: true, viewTypes: ["sabidurian-timeline"], getSurfaces: () => [remote],
		canNavigate: () => !busy, onChange: (callback: () => void) => { changed = callback; return () => { changed = undefined; }; } };
	f.workspace.trigger.mockImplementation((name: string, receive: (value: unknown) => void) => { if (name === "time-and-line:collaboration-request") receive(bridge); });
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(base.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster(); expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		const start = socket.frames.length;
		socket.message({ type: "location", subscription_id: socket.frames.filter(frame => frame.type === "follow").at(-1)!.subscription_id, status: "available", location: base.location(1) });
		await until(() => socket.frames.slice(start).some(frame => frame.type === "watch" && (frame.location as { view_id?: string }).view_id === base.location(1).view_id)); socket.roster();
		await until(() => jest.mocked(renderer.scrollEl.scrollIntoView).mock.calls.length > 0);
		expect(base.controller.selectView).toHaveBeenCalledWith("Cards"); expect(f.openFile).not.toHaveBeenCalled();
		f.controller.stopFollowing(); busy = true; expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(false);
		expect(base.host.data).toBe(base.source); expect(base.host.lastSavedData).toBe(base.source); expect(base.host.dirty).toBe(false);
		bridge.available = false; changed?.(); expect(f.controller.peers).toEqual([]); expect(f.controller.status).toBe("unavailable");
	} finally { f.close(); expect(changed).toBeUndefined(); network.close(); }
});

test("verified image presence uses the same socket, supports hidden observation and clears on blur", async () => {
	const network = crossNetwork(true, () => f.image.location), f = fixture(true, true);
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		f.select(f.image.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
		await until(() => (socket.frames.filter(frame => frame.type === "presence").at(-1)?.location as { kind?: string })?.kind === "image");
		expect(f.controller.status).toBe("ready"); expect(f.controller.surfaceName).toBe("image");
		expect(f.controller.peers.map(peer => peer.surface)).toEqual(["image"]);
		expect(f.notes.every(note => note.doc._liveProvider.awareness.getLocalState() === null)).toBe(true);
		expect(f.vault.readBinary).toHaveBeenCalledTimes(1);
		expect(await f.controller.navigate(f.controller.peers[0].key, false)).toBe(true);
		expect(f.image.element.scrollIntoView).toHaveBeenCalledTimes(1);
		await f.controller.setVisible(false); expect(f.controller.peers).toHaveLength(1);
		expect(socket.frames.filter(frame => frame.type === "presence").at(-1)).toEqual({ type: "presence", location: null });
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		f.image.view.contentEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
		expect(f.controller.following).toBeUndefined(); expect(f.controller.peers).toHaveLength(1);
		f.focus.mockReturnValue(false); window.dispatchEvent(new Event("blur"));
		expect(f.controller.peers).toEqual([]); expect(socket.readyState).toBe(3);
		socket.roster(); expect(f.controller.peers).toEqual([]); expect(network.sockets).toHaveLength(1);
	} finally { f.close(); network.close(); }
});

test("Follow crosses note to image to note without another socket or changing local text selection", async () => {
	const network = crossNetwork(true, () => f.image.location), f = fixture(true, true);
	const first = remotePeer(f); let second: ReturnType<typeof remotePeer> | undefined;
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => f.controller.peers.length === 1);
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		const before = f.editors.map(item => item.editor.state.selection.toJSON());
		first.send(); socket.imageLocation(f);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
		await until(() => jest.mocked(f.image.element.scrollIntoView).mock.calls.length > 0);
		expect(f.controller.following?.surface).toBe("image"); expect(f.openFile).toHaveBeenCalledWith(f.image.file, { active: true, state: undefined });
		second = remotePeer(f, 1); socket.location(f, 1);
		const dispatch = jest.spyOn(f.editors[1].editor, "dispatch");
		await until(() => f.openFile.mock.calls.length === 2 && dispatch.mock.calls.length > 0);
		expect(f.controller.following?.surface).toBe("editor"); expect(network.sockets).toHaveLength(1);
		expect(f.editors.map(item => item.editor.state.selection.toJSON())).toEqual(before);
		expect(f.notes.map(note => note.text.toString())).toEqual(["alpha beta", "alpha beta"]);
	} finally { first.close(); second?.close(); f.close(); network.close(); }
});

test.each(["revoked", "local-bytes", "server-version"])("image presence withdraws %s and requires a verified retry", async failure => {
	let badVersion = failure === "server-version";
	const network = crossNetwork(true, () => badVersion ? { ...f.image.location, content_sha256: "b".repeat(64) } : f.image.location), f = fixture(true, true);
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(f.image.view);
		if (failure !== "server-version") {
			await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
			expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
			if (failure === "revoked") socket.roster(false);
			else { f.image.file.stat.mtime++; f.vault.readBinary.mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer); f.controller.refresh(); }
		}
		await until(() => f.controller.status === "unavailable");
		expect(f.controller.peers).toEqual([]); expect(f.controller.canRetry).toBe(true);
		expect(socket.frames.filter(frame => frame.type === "presence").at(-1)).toEqual({ type: "presence", location: null });
		if (failure === "revoked") expect(f.controller.following).toBeUndefined();
		const count = jest.mocked(platformFetch).mock.calls.length;
		for (let i = 0; i < 10; i++) f.controller.refresh(); await settled();
		expect(jest.mocked(platformFetch).mock.calls).toHaveLength(count);
		badVersion = false;
		// Repairing bytes also changes the file revision; verification correctly
		// keeps the digest of unchanged bytes instead of re-reading on every retry.
		if (failure === "local-bytes") f.image.file.stat.mtime++;
		const watchesBeforeRetry = socket.frames.filter(frame => frame.type === "watch").length;
		f.controller.retry(); await until(() => f.controller.status === "ready" && socket.frames.filter(frame => frame.type === "watch").length > watchesBeforeRetry); socket.roster();
		expect(f.controller.peers).toHaveLength(1);
	} finally { f.close(); network.close(); }
});

test("an image context response after logout cannot publish or restore participants", async () => {
	let finish!: (value: unknown) => void;
	const network = crossNetwork(true, () => new Promise(resolve => { finish = resolve; })), f = fixture(true, true);
	try {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(f.image.view);
		await until(() => !!finish); f.logout(); finish(f.image.location); await settled();
		expect(f.controller.peers).toEqual([]); expect(socket.readyState).toBe(3);
		expect(socket.frames.some(frame => frame.type === "watch")).toBe(false);
	} finally { f.close(); network.close(); }
});

test("verified host publishes image geometry and renders peers while privacy withdraws only local state", async () => {
	const network = crossNetwork(true, () => f.image.location), f = fixture(true, true);
	const layout = (element: HTMLElement) => {
		Object.defineProperties(element, { offsetWidth: { value: 400 }, offsetHeight: { value: 250 }, clientWidth: { value: 400 }, clientHeight: { value: 250 } });
		element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 250, width: 400, height: 250, toJSON: () => ({}) });
	};
	try {
		layout(f.image.view.contentEl); layout(f.image.element);
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(f.image.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster();
		layout(f.image.view.contentEl.querySelector<HTMLElement>(".relay-image-presence")!); socket.imageState();
		await until(() => f.image.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent === "Peer");
		expect(f.controller.peers[0]).toMatchObject({ imageState: { pointer: { x: 0.25, y: 0.75 } } });
		await until(() => socket.frames.some(frame => frame.type === "image_state"));
		expect(socket.frames.filter(frame => frame.type === "image_state").at(-1)).toMatchObject({ state: { pointer: null, viewport: { x: 0, y: 0, width: 1, height: 1 } } });
		f.image.element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 125 }));
		await until(() => ((socket.frames.filter(frame => frame.type === "image_state").at(-1)?.state as { pointer?: { x: number } })?.pointer?.x) === 0.25);
		expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
		expect(f.openFile).not.toHaveBeenCalled();
		await f.controller.setVisible(false); const count = socket.frames.filter(frame => frame.type === "image_state").length;
		f.image.element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 125 })); await settled(); await settled();
		expect(socket.frames.filter(frame => frame.type === "image_state")).toHaveLength(count);
		expect(f.image.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent).toBe("Peer");
		f.logout(); expect(f.image.view.contentEl.querySelector(".relay-image-presence")).toBeNull(); expect(f.controller.peers).toEqual([]);
	} finally { f.close(); network.close(); }
});

test.each(["denial", "bytes", "blur", "logout"] as const)("direct-image split panes reuse one watch and clear together on %s", async failure => {
	const network = crossNetwork(true, () => f.image.location), f = fixture(true, true);
	const root = document.body.appendChild(document.createElement("div")), image = root.appendChild(f.image.element.cloneNode() as HTMLImageElement);
	Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
	const passive = Object.assign(Object.create(FileView.prototype), f.image.view, { contentEl: root, containerEl: root }) as FileView;
	f.extraViews.push(passive);
	let shown = true;
	const box = (element: HTMLElement) => {
		Object.defineProperties(element, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 250 }, clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 250 } });
		element.getBoundingClientRect = () => new DOMRect(0, 0, 400, 250);
		element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
	};
	try {
		for (const element of [root, image, f.image.view.contentEl, f.image.element]) box(element);
		root.getClientRects = () => (shown ? [root.getBoundingClientRect()] : []) as unknown as DOMRectList;
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(f.image.view);
		await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster(); socket.imageState();
		const painted = async () => {
			await until(() => [root, f.image.view.contentEl].every(element => element.querySelector(".relay-image-presence")));
			for (const element of [root, f.image.view.contentEl]) box(element.querySelector<HTMLElement>(".relay-image-presence")!);
			window.dispatchEvent(new Event("resize"));
			await until(() => [root, f.image.view.contentEl].every(element => element.querySelector(".relay-image-presence-pointer")?.textContent === "Peer"));
		};
		await painted();
		const reads = f.vault.readBinary.mock.calls.length;
		for (let i = 0; i < 10; i++) { f.controller.refresh(); socket.imageState(); }
		image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 125 }));
		await settled(); await settled();
		expect(socket.frames.filter(frame => frame.type === "image_state").every(frame => !frame.state || !(frame.state as ImagePresenceState).pointer)).toBe(true);
		expect(f.vault.readBinary).toHaveBeenCalledTimes(reads);
		expect(jest.mocked(platformFetch).mock.calls.filter(([url]) => String(url).includes("/image-location?"))).toHaveLength(1);
		expect(socket.frames.filter(frame => frame.type === "watch")).toHaveLength(1); expect(network.sockets).toHaveLength(1);
		await f.controller.setVisible(false); expect(root.querySelector(".relay-image-presence-pointer")).not.toBeNull();
		shown = false; f.controller.refresh(); expect(root.querySelector(".relay-image-presence")).toBeNull();
		shown = true; f.controller.refresh(); await painted();
		// A replaced native resource must not inherit the other pane's proof.
		image.src = "app://local/Other.png"; await until(() => !root.querySelector(".relay-image-presence"));
		expect(f.image.view.contentEl.querySelector(".relay-image-presence-pointer")).not.toBeNull();
		image.src = f.image.element.src; await painted();
		if (failure === "denial") socket.roster(false);
		else if (failure === "bytes") { f.image.file.stat.mtime++; f.vault.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer); f.controller.refresh(); }
		else if (failure === "blur") { f.focus.mockReturnValue(false); window.dispatchEvent(new Event("blur")); }
		else f.logout();
		await until(() => [root, f.image.view.contentEl].every(element => !element.querySelector(".relay-image-presence")));
		socket.imageState(); await settled(); expect(root.querySelector(".relay-image-presence")).toBeNull();
	} finally { f.close(); root.remove(); network.close(); }
});


test("note and image observers share an eight-pane budget and duplicate images reuse one proof", async () => {
	const network = crossNetwork(true, () => f.image.location, true, undefined, undefined, true), f = fixture(true, true);
	const roots: HTMLElement[] = [], bindings: typeof f.registry.trackedViews = [];
	const box = (node: HTMLElement) => {
		Object.defineProperties(node, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 250 }, clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 250 } });
		node.getBoundingClientRect = () => new DOMRect(0, 0, 400, 250); node.getClientRects = () => [node.getBoundingClientRect()] as unknown as DOMRectList;
	};
	try {
		for (let i = 0; i < 7; i++) {
			const root = document.body.appendChild(document.createElement("div")); roots.push(root); box(root);
			const view = Object.assign(Object.create(MarkdownView.prototype), f.notes[0].view, { contentEl: root, containerEl: root });
			const binding = Object.assign(new (DocumentViewBinding as unknown as new () => object)(), f.notes[0].binding, { hostView: view });
			bindings.push(binding); f.registry.trackedViews.push(binding);
		}
		for (let i = 0; i < 12; i++) {
			const root = document.body.appendChild(document.createElement("div")), image = root.appendChild(f.image.element.cloneNode() as HTMLImageElement); roots.push(root);
			Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } }); box(root); box(image);
			f.extraViews.push(Object.assign(Object.create(FileView.prototype), f.image.view, { contentEl: root, containerEl: root }));
		}
		box(f.image.view.contentEl); box(f.image.element);
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.controller.refresh();
		await until(() => document.querySelectorAll(".relay-image-presence").length === 1);
		f.registry.trackedViews = f.registry.trackedViews.filter(binding => !bindings.includes(binding)); f.controller.refresh();
		await until(() => document.querySelectorAll(".relay-image-presence").length === 8);
		await until(() => socket.frames.filter(frame => frame.type === "observe").length === 1);
		expect(jest.mocked(platformFetch).mock.calls.filter(([url]) => String(url).includes("/image-location?"))).toHaveLength(1);
		expect(f.vault.readBinary).toHaveBeenCalledTimes(1); expect(network.sockets).toHaveLength(1);
		f.extraViews.splice(0); f.controller.refresh(); await until(() => document.querySelectorAll(".relay-image-presence").length === 1);
	} finally { f.close(); roots.forEach(root => root.remove()); network.close(); }
});

test.each(["note", "image"] as const)("passive image panes isolate their proof, roster and denial from the foreground %s", async foreground => {
	const id = "00000000-0000-4000-8000-000000000030";
	const network = crossNetwork(true, () => f.image.location, false, undefined, undefined, true), f = fixture(true, true);
	const root = document.body.appendChild(document.createElement("div")), element = root.appendChild(f.image.element.cloneNode() as HTMLImageElement);
	Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
	const otherFile = { ...f.image.file, path: "Other.png", stat: { ...f.image.file.stat } } as TFile, otherRecord = { ...f.image.record, id };
	const other = Object.assign(Object.create(FileView.prototype), f.image.view, { file: otherFile, contentEl: root, containerEl: root }) as FileView;
	element.src = "app://local/Other.png"; f.extraViews.push(other);
	const fileAt = f.vault.getFileByPath, shareFor = f.registry.shareRegistry.shareFor, recordFor = f.folder.folderIndex.recordFor, registered = f.folder._liveProvider.managedIndex.registered;
	f.vault.getFileByPath = path => path === otherFile.path ? otherFile : fileAt(path);
	Object.assign(f.vault, { getResourcePath: (file: TFile) => "app://local/" + file.path });
	f.registry.shareRegistry.shareFor = path => path === otherFile.path ? f.folder : shareFor(path);
	f.folder.folderIndex.recordFor = path => path === otherFile.path ? otherRecord : recordFor(path);
	f.folder._liveProvider.managedIndex.registered = (path, entry) => path === otherFile.path && entry === id || registered(path, entry);
	const fetcher = jest.mocked(platformFetch).getMockImplementation()!;
	jest.mocked(platformFetch).mockImplementation((url, init) => String(url).includes("/image-location?") && String(url).endsWith(id) ? Promise.resolve({ status: 200, ok: true,
		text: async () => JSON.stringify({ protocol_version: 1, location: { ...f.image.location, entry_id: id } }) } as Response) : fetcher(url, init));
	const box = (node: HTMLElement) => {
		Object.defineProperties(node, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 250 }, clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 250 } });
		node.getBoundingClientRect = () => new DOMRect(0, 0, 400, 250); node.getClientRects = () => [node.getBoundingClientRect()] as unknown as DOMRectList;
	};
	try {
		[root, element, f.image.view.contentEl, f.image.element].forEach(box);
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		if (foreground === "image") f.select(f.image.view); else f.controller.refresh();
		const observations = () => socket.frames.filter(frame => frame.type === "observe" && (frame.location as { entry_id: string }).entry_id === id);
		await until(() => observations().length === 1);
		if (foreground === "image") {
			await until(() => socket.frames.some(frame => frame.type === "watch")); socket.roster(); socket.imageState();
			await until(() => !!f.image.view.contentEl.querySelector(".relay-image-presence")); box(f.image.view.contentEl.querySelector<HTMLElement>(".relay-image-presence")!);
		}
		const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
		const send = () => {
			const subscription_id = observations().at(-1)!.subscription_id;
			socket.message({ type: "roster", subscription_id, status: "available", peers: [{ target, name: "Image peer" }] });
			socket.message({ type: "image_states", subscription_id, status: "available", peers: [{ target, state: { pointer: { x: 0.75, y: 0.25 }, viewport: null } }] });
		};
		const painted = async () => {
			send(); await until(() => !!root.querySelector(".relay-image-presence")); box(root.querySelector<HTMLElement>(".relay-image-presence")!);
			window.dispatchEvent(new Event("resize")); await until(() => root.querySelector(".relay-image-presence-pointer")?.textContent === "Image peer");
		};
		await painted(); expect(f.controller.peers.map(peer => peer.name)).toEqual(foreground === "image" ? ["Peer"] : []);
		expect(f.image.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent).toBe(foreground === "image" ? "Peer" : undefined);
		const reads = f.vault.readBinary.mock.calls.length, requests = jest.mocked(platformFetch).mock.calls.filter(([url]) => String(url).includes("/image-location?")).length;
		for (let i = 0; i < 10; i++) f.controller.refresh();
		element.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 125 })); await settled();
		expect(socket.frames.some(frame => frame.type === "image_state" && (frame.location as ImageLocation).entry_id === id)).toBe(false);
		expect(f.vault.readBinary).toHaveBeenCalledTimes(reads);
		expect(jest.mocked(platformFetch).mock.calls.filter(([url]) => String(url).includes("/image-location?"))).toHaveLength(requests);
		await f.controller.setVisible(false); expect(root.querySelector(".relay-image-presence-pointer")).not.toBeNull();
		const initialSubscription = observations()[0].subscription_id;
		for (const view of [f.notes[1].view, f.image.view, f.notes[0].view]) {
			f.select(view); await settled();
			expect(observations()).toHaveLength(1);
			expect(socket.frames.some(frame => frame.type === "unobserve" && frame.subscription_id === initialSubscription)).toBe(false);
			expect(root.querySelector(".relay-image-presence-pointer")?.textContent).toBe("Image peer");
		}
		f.select(foreground === "image" ? f.image.view : f.notes[0].view); await settled();
		if (foreground === "image") {
			box(f.image.view.contentEl.querySelector<HTMLElement>(".relay-image-presence")!);
			socket.roster(); socket.imageState(); window.dispatchEvent(new Event("resize")); await settled();
		}
		const denied = observations().at(-1)!.subscription_id;
		socket.message({ type: "roster", subscription_id: denied, status: "unavailable" });
		await until(() => !root.querySelector(".relay-image-presence-pointer")); expect(f.controller.canRetry).toBe(true);
		expect(f.controller.peers.map(peer => peer.name)).toEqual(foreground === "image" ? ["Peer"] : []);
		expect(f.image.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent).toBe(foreground === "image" ? "Peer" : undefined);
		for (let i = 0; i < 10; i++) f.controller.refresh(); await settled(); expect(observations()).toHaveLength(1);
		f.controller.retry(); await until(() => observations().length === 2); await painted();
		socket.message({ type: "roster", subscription_id: denied, status: "available", peers: [{ target, name: "Old peer" }] });
		expect(root.querySelector(".relay-image-presence-pointer")?.textContent).toBe("Image peer");
		f.logout(); expect(root.querySelector(".relay-image-presence")).toBeNull(); expect(network.sockets).toHaveLength(1);
	} finally { f.close(); root.remove(); network.close(); }
});



test("Reading embedded-image capture, identity overlays and Jump/Follow share the note socket", async () => {
    const network = crossNetwork(true, () => f.image.location, true), f = fixture(true, true), first = f.notes[0];
    const stops: (() => void)[] = [], anchors = new EmbeddedImageAnchors(first.text);
    let remote: ReturnType<typeof remotePeer> | undefined;
    const box = (element: HTMLElement, top = 0, width = 400, height = 250) => {
        Object.defineProperties(element, { offsetWidth: { configurable: true, value: width }, offsetHeight: { configurable: true, value: height }, clientWidth: { configurable: true, value: width }, clientHeight: { configurable: true, value: height } });
        element.getBoundingClientRect = () => ({ x: 0, y: top, left: 0, top, right: width, bottom: top + height, width, height, toJSON: () => ({}) });
    };
    try {
        first.text.delete(0, first.text.length); first.text.insert(0, "![[Picture.png]]\n\n![[Picture.png]]");
        first.mode("preview"); stops.push(bindReadingComments(first.view, () => ({ documentId: first.doc.entityGuid, text: first.text })));
        box(first.view.contentEl, 0, 400, 600);
        const images = [0, 300].map((top, index) => {
            const section = first.view.contentEl.appendChild(document.createElement("div")); box(section, top);
            const image = section.appendChild(document.createElement("img")); image.src = "app://local/Picture.png"; box(image, top);
            Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
            section.scrollIntoView = jest.fn(); image.scrollIntoView = jest.fn();
            const context = { sourcePath: first.view.file!.path, getSectionInfo: () => ({ text: first.text.toString(), lineStart: index * 2, lineEnd: index * 2 }),
                addChild: (child: { onload(): void; unload(): void }) => { child.onload(); stops.push(() => child.unload()); } } as unknown as MarkdownPostProcessorContext;
            f.processors.forEach(processor => processor(section, context)); return image;
        });
        remote = remotePeer(f); f.controller.refresh();
        await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
        await until(() => socket.frames.some(frame => frame.type === "watch_embeds"));
        images[1].dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 425 }));
        await until(() => socket.frames.some(frame => frame.type === "image_embed" && frame.embed));
        const captured = socket.frames.filter(frame => frame.type === "image_embed" && frame.embed).at(-1)!.embed as EmbeddedImage;
        expect(await anchors.resolve(captured)).toEqual(anchors.images[1]); expect(captured.state.pointer).toEqual({ x: 0.25, y: 0.5 });
        const send = (embed: EmbeddedImage) => socket.message({ type: "image_embeds", subscription_id: socket.frames.filter(frame => frame.type === "watch_embeds").at(-1)!.subscription_id, status: "available", peers: [{ target: { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" }, embed }] });
        send(captured); await until(() => f.controller.peers.length === 1);
        first.view.contentEl.querySelectorAll<HTMLElement>(".relay-image-presence").forEach(layer => box(layer, 0, 400, 600));
        send({ ...captured, state: { ...captured.state, pointer: { x: 0.5, y: 0.5 } } });
        await until(() => first.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent === "Peer");
        const marker = first.view.contentEl.querySelector<HTMLElement>(".relay-image-presence-pointer")!;
        expect(marker.style.top).toBe("425px");
        const original = first.text.toString(), selection = f.editors[0].editor.state.selection.toJSON();
        expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(true);
        expect(socket.frames.filter(frame => frame.type === "follow")).toHaveLength(1);
        expect(f.controller.following?.name).toBe("Peer"); expect(first.text.toString()).toBe(original);
        expect(f.editors[0].editor.state.selection.toJSON()).toEqual(selection);
        const reads = f.vault.readBinary.mock.calls.length;
        for (let x = 0; x < 10; x++) send({ ...captured, state: { pointer: { x: x / 10, y: 0.5 }, viewport: null } });
        await settled(); expect(f.vault.readBinary).toHaveBeenCalledTimes(reads);
        await f.controller.setVisible(false); expect(socket.frames.filter(frame => frame.type === "presence").at(-1)).toEqual({ type: "presence", location: null });
        expect(first.view.contentEl.querySelector(".relay-image-presence-pointer")).not.toBeNull();
        expect(network.sockets).toHaveLength(1);
        // Source mode navigates to the exact Markdown occurrence without
        // switching mode or replacing the user's selection.
        const editor = f.editors[0].editor;
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: first.text.toString() } });
        first.mode("source"); f.controller.refresh(); send(captured); await settled();
        const dispatch = jest.spyOn(editor, "dispatch"), sourceSelection = editor.state.selection.toJSON();
        expect(await f.controller.navigate(f.controller.peers[0].key, false)).toBe(true);
        expect(dispatch).toHaveBeenCalled(); expect(editor.state.selection.toJSON()).toEqual(sourceSelection);
        expect(first.view.getMode()).toBe("source");
        socket.message({ type: "image_embeds", subscription_id: socket.frames.filter(frame => frame.type === "watch_embeds").at(-1)!.subscription_id, status: "unavailable" });
        expect(f.controller.canRetry).toBe(true); expect(f.controller.following).toBeUndefined();
        const start = socket.frames.length;
        f.controller.retry(); await until(() => socket.frames.slice(start).some(frame => frame.type === "watch_embeds"));
        expect(network.sockets).toHaveLength(1); expect(socket.frames.slice(start).some(frame => frame.type === "image_embed" || frame.type === "follow")).toBe(false);
        socket.readyState = 3; socket.onclose?.call(socket as unknown as WebSocket, { code: 1006 } as CloseEvent);
        await until(() => network.sockets.length === 2); const next = network.sockets[1]; next.ready();
        await until(() => next.frames.some(frame => frame.type === "watch_embeds"));
        expect(next.frames.some(frame => frame.type === "image_embed" || frame.type === "follow")).toBe(false);
        f.logout(); expect(first.view.contentEl.querySelector(".relay-image-presence")).toBeNull(); expect(f.controller.following).toBeUndefined();
    } finally { stops.forEach(stop => stop()); anchors.close(); remote?.close(); f.close(); network.close(); }
});


test("Live Preview widget maps image presence to the exact bound CodeMirror occurrence", async () => {
    const previousRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects"), previousBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    // jsdom has no text layout; CodeMirror still needs its measurement APIs
    // while mounting the real widget. Image geometry is supplied separately.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 8, 14) });
    const network = crossNetwork(true, () => f.image.location, true), f = fixture(true, true), note = f.notes[0], editor = f.editors[0].editor;
    const anchors = new EmbeddedImageAnchors(note.text);
    const box = (element: HTMLElement) => {
        Object.defineProperties(element, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: 250 }, clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 250 } });
        element.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 250, width: 400, height: 250, toJSON: () => ({}) });
    };
    try {
        note.text.delete(0, note.text.length); note.text.insert(0, "Prefix\n\n![[Picture.png]]\n\nEnd");
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: note.text.toString() } });
        const image = document.createElement("img"); image.src = "app://local/Picture.png";
        Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
        const occurrence = anchors.images[0];
        editor.dispatch({ effects: StateEffect.appendConfig.of(EditorView.decorations.of(Decoration.set([
            Decoration.replace({ widget: new class extends WidgetType { toDOM() { return image; } }() }).range(occurrence.from, occurrence.to),
        ]))) });
        for (let element: HTMLElement | null = image; element && note.view.contentEl.contains(element); element = element.parentElement) box(element);
        f.controller.refresh(); await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
        await until(() => socket.frames.some(frame => frame.type === "watch_embeds"));
        image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 125 }));
        await until(() => socket.frames.some(frame => frame.type === "image_embed" && frame.embed));
        const embed = socket.frames.filter(frame => frame.type === "image_embed" && frame.embed).at(-1)!.embed as EmbeddedImage;
        expect(await anchors.resolve(embed)).toEqual(occurrence); expect(embed.state.pointer).toEqual({ x: 0.75, y: 0.5 });
        expect(editor.state.doc.toString()).toBe(note.text.toString());
        // A stale renderer binding cannot keep publishing the widget.
        f.editors[0].stop(); f.controller.refresh(); image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 125 }));
        await settled(); expect(socket.frames.filter(frame => frame.type === "image_embed").at(-1)).toMatchObject({ embed: null });
    } finally {
        anchors.close(); f.close(); network.close();
        if (previousRects) Object.defineProperty(Range.prototype, "getClientRects", previousRects); else Reflect.deleteProperty(Range.prototype, "getClientRects");
        if (previousBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", previousBounds); else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
});

function baseMotionFixture(multiWatch = false) {
	const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
	const read = jest.fn(async (entry: string) => ({ protocol_version: 1, share_id: id(3), entry_id: entry, generation: id(50 + Number(entry.slice(-12))), type: "markdown" }));
	const network = crossNetwork(true, undefined, false, () => f.base!.context, entry => read(entry), multiWatch), f = fixture(true, false, true), base = f.base!;
	const rows = base.setRecords(f.notes.map(note => note.view.file!))[0], renderer = base.renderers[0];
	function box(element: HTMLElement, width: number, height: number, left = 0, top = 0) {
		Object.defineProperties(element, { offsetWidth: { value: width, configurable: true }, offsetHeight: { value: height, configurable: true }, clientWidth: { value: width, configurable: true }, clientHeight: { value: height, configurable: true } });
		element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) });
	}
	box(base.root, 400, 300); box(base.content, 400, 300); box(renderer.containerEl, 400, 300); box(renderer.scrollEl, 400, 200, 0, 40);
	rows.forEach((row, index) => { box(row.el, 400, 50, 0, 50 + index * 100); row.cells.forEach((cell, col) => box(cell.el, 200, 50, col * 200, 50 + index * 100)); });
	const state = (record = 1, generation = 50 + record, x = 0.25) => ({ version: 1, pointer: { target: { type: "cell", record_id: id(record), record_generation: id(generation), property: { source: "note", name: "status" } }, offset: { x, y: 0.5 } }, viewport: null });
	const send = (record = 1, generation = 50 + record, x = 0.25) => { const socket = network.sockets[0]; socket.message({ type: "base_states", subscription_id: socket.frames.filter(frame => frame.type === "watch").at(-1)!.subscription_id, status: "available",
		peers: [{ target: { user_id: id(8), session_id: "a".repeat(32), instance_id: id(9) }, state: state(record, generation, x) }] }); };
	return { f, base, network, rows, renderer, read, state, send, box, open: async () => {
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready(); f.select(base.view);
		await until(() => socket.frames.some(frame => frame.type === "watch" && frame.base_states === true));
		const layer = base.content.querySelector<HTMLElement>(".relay-base-presence")!; box(layer, 400, 300); socket.roster(); return { socket, layer };
	}, close: () => { f.close(); network.close(); } };
}

test("passive Bases preserve exact cells across foreground changes and isolate saved views and denial", async () => {
	const m = baseMotionFixture(true), { f, base } = m;
	f.extraViews.push(base.view);
	base.content.getClientRects = () => [base.content.getBoundingClientRect()] as unknown as DOMRectList;
	const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
	try {
		await until(() => m.network.sockets.length === 1); const socket = m.network.sockets[0]; socket.ready();
		const observations = () => socket.frames.filter(frame => frame.type === "observe" && (frame.location as { kind: string }).kind === "base");
		await until(() => observations().length === 1);
		const initial = observations()[0].subscription_id, sourceReads = f.vault.read.mock.calls.length;
		const send = (subscription_id: unknown, name = "Base peer") => {
			socket.message({ type: "roster", subscription_id, status: "available", peers: [{ target, name }] });
			socket.message({ type: "base_states", subscription_id, status: "available", peers: [{ target, state: m.state() }] });
		};
		const layer = base.content.querySelector<HTMLElement>(".relay-base-presence")!; m.box(layer, 400, 300);
		send(initial); await until(() => layer.querySelector(".relay-base-presence-pointer")?.textContent === "Base peer");
		expect(layer.querySelector<HTMLElement>(".relay-base-presence-pointer")?.style.left).toBe("250px");
		expect(f.controller.peers).toEqual([]);
		m.rows[0].cells[1].el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 })); await settled();
		expect(socket.frames.some(frame => frame.type === "base_state")).toBe(false);
		f.select(f.notes[1].view); await settled(); expect(observations()).toHaveLength(1);
		expect(layer.querySelector(".relay-base-presence-pointer")?.textContent).toBe("Base peer");
		await f.controller.setVisible(false); expect(layer.querySelector(".relay-base-presence-pointer")).not.toBeNull();
		base.controller.selectView("Cards");
		const cards = base.renderers[1]; m.box(cards.containerEl, 400, 300); m.box(cards.scrollEl, 400, 200, 0, 40);
		for (const row of cards.rows as { el: HTMLElement; cells: { el: HTMLElement }[] }[]) {
			m.box(row.el, 400, 50, 0, 50); row.cells.forEach((cell, index) => m.box(cell.el, 200, 50, index * 200, 50));
		}
		await until(() => observations().length === 2);
		expect(observations()[1].location).toEqual(base.location(1));
		expect(socket.frames.some(frame => frame.type === "unobserve" && frame.subscription_id === initial)).toBe(true);
		send(initial, "Stale peer"); await settled(); expect(base.content.textContent).not.toContain("Stale peer");
		send(observations()[1].subscription_id);
		await until(() => base.content.querySelector(".relay-base-presence-pointer")?.textContent === "Base peer");
		expect(f.vault.read).toHaveBeenCalledTimes(sourceReads);
		const denied = observations()[1].subscription_id;
		socket.message({ type: "roster", subscription_id: denied, status: "unavailable" }); await settled();
		expect(base.content.querySelector(".relay-base-presence-pointer")).toBeNull(); expect(f.controller.canRetry).toBe(true);
		for (let i = 0; i < 10; i++) f.controller.refresh(); await settled(); expect(observations()).toHaveLength(2);
		f.controller.retry(); await until(() => observations().length === 3); send(observations()[2].subscription_id);
		await until(() => base.content.querySelector(".relay-base-presence-pointer")?.textContent === "Base peer");
		expect(f.vault.read.mock.calls.length).toBeGreaterThan(sourceReads);
		f.logout(); expect(base.content.querySelector(".relay-base-presence")).toBeNull(); expect(m.network.sockets).toHaveLength(1);
	} finally { m.close(); }
});

test("passive Base copies share one proof and a pane budget while saved-view rosters stay independent", async () => {
	const m = baseMotionFixture(true), { f, base } = m, copies = Array.from({ length: 10 }, () => nativePresenceBase());
	const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
	const layout = (copy: ReturnType<typeof nativePresenceBase>) => {
		m.box(copy.root, 400, 300); m.box(copy.content, 400, 300);
		copy.content.getClientRects = () => [copy.content.getBoundingClientRect()] as unknown as DOMRectList;
		for (const renderer of copy.renderers) {
			m.box(renderer.containerEl, 400, 300); m.box(renderer.scrollEl, 400, 200, 0, 40);
			for (const row of renderer.rows as { el: HTMLElement; cells: { el: HTMLElement }[] }[]) {
				m.box(row.el, 400, 50, 0, 50); row.cells.forEach((cell, index) => m.box(cell.el, 200, 50, index * 200, 50));
			}
		}
	};
	try {
		for (const copy of copies) {
			copy.host.file = base.file; copy.query.file = base.file; copy.setRecords(f.notes.map(note => note.view.file!)); layout(copy); f.extraViews.push(copy.view);
		}
		await until(() => m.network.sockets.length === 1); const socket = m.network.sockets[0]; socket.ready();
		const observations = () => socket.frames.filter(frame => frame.type === "observe" && (frame.location as { kind: string }).kind === "base");
		await until(() => observations().length === 1);
		expect(document.querySelectorAll(".relay-base-presence")).toHaveLength(8);
		expect(f.vault.read).toHaveBeenCalledTimes(1);
		expect(jest.mocked(platformFetch).mock.calls.filter(([url]) => String(url).includes("/base-context?"))).toHaveLength(1);
		for (const copy of copies.slice(0, 8)) m.box(copy.content.querySelector<HTMLElement>(".relay-base-presence")!, 400, 300);
		const send = (subscription_id: unknown, name: string) => {
			socket.message({ type: "roster", subscription_id, status: "available", peers: [{ target, name }] });
			socket.message({ type: "base_states", subscription_id, status: "available", peers: [{ target, state: m.state() }] });
		};
		const work = observations()[0].subscription_id; send(work, "Work peer");
		await until(() => document.querySelectorAll(".relay-base-presence-pointer").length === 8);
		copies[0].controller.selectView("Cards"); await until(() => observations().length === 2);
		const cards = observations()[1].subscription_id; send(cards, "Cards peer");
		await until(() => copies[0].content.querySelector(".relay-base-presence-pointer")?.textContent === "Cards peer");
		expect(copies[1].content.querySelector(".relay-base-presence-pointer")?.textContent).toBe("Work peer");
		expect(observations()[1].location).toEqual(base.location(1)); expect(f.vault.read).toHaveBeenCalledTimes(1);
		socket.message({ type: "roster", subscription_id: cards, status: "unavailable" }); await settled();
		expect(copies[0].content.querySelector(".relay-base-presence-pointer")).toBeNull();
		expect(copies[1].content.querySelector(".relay-base-presence-pointer")?.textContent).toBe("Work peer");
		for (let i = 0; i < 10; i++) f.controller.refresh(); await settled(); expect(observations()).toHaveLength(2);
		f.extraViews.splice(0); f.controller.refresh(); expect(document.querySelectorAll(".relay-base-presence")).toHaveLength(0);
		expect(socket.frames.some(frame => frame.type === "unobserve" && frame.subscription_id === work)).toBe(true);
		expect(m.network.sockets).toHaveLength(1); expect(f.controller.peers).toEqual([]);
	} finally { m.close(); copies.forEach(copy => copy.close()); }
});

test("same-view Base copies reuse the foreground roster and move together to passive observation", async () => {
	const m = baseMotionFixture(true), { f, base } = m, copy = nativePresenceBase();
	copy.host.file = base.file; copy.query.file = base.file; const rows = copy.setRecords(f.notes.map(note => note.view.file!))[0];
	for (const element of [copy.root, copy.content, copy.renderers[0].containerEl, copy.renderers[0].scrollEl]) m.box(element, 400, 300);
	rows.forEach(row => { m.box(row.el, 400, 50, 0, 50); row.cells.forEach((cell, index) => m.box(cell.el, 200, 50, index * 200, 50)); });
	for (const view of [base.view, copy.view]) view.contentEl.getClientRects = () => [view.contentEl.getBoundingClientRect()] as unknown as DOMRectList;
	f.extraViews.push(base.view, copy.view);
	try {
		const { socket, layer } = await m.open();
		await until(() => !!copy.content.querySelector(".relay-base-presence"));
		m.box(copy.content.querySelector<HTMLElement>(".relay-base-presence")!, 400, 300); m.send();
		await until(() => copy.content.querySelector(".relay-base-presence-pointer") !== null);
		expect(layer.querySelector(".relay-base-presence-pointer")).not.toBeNull();
		const observations = () => socket.frames.filter(frame => frame.type === "observe" && (frame.location as { kind: string }).kind === "base");
		const before = observations().length;
		f.select(f.notes[0].view); await until(() => observations().length > before);
		const subscription_id = observations().at(-1)!.subscription_id;
		const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
		socket.message({ type: "roster", subscription_id, status: "available", peers: [{ target, name: "Shared Base peer" }] });
		socket.message({ type: "base_states", subscription_id, status: "available", peers: [{ target, state: m.state() }] });
		await until(() => base.content.querySelector(".relay-base-presence") !== null);
		m.box(base.content.querySelector<HTMLElement>(".relay-base-presence")!, 400, 300); f.controller.refresh();
		await until(() => document.querySelectorAll(".relay-base-presence-pointer").length === 2);
		expect(f.controller.peers).toEqual([]); expect(m.network.sockets).toHaveLength(1);
		f.select(copy.view); await settled();
		expect(socket.frames.some(frame => frame.type === "unobserve" && frame.subscription_id === subscription_id)).toBe(true);
		expect(document.querySelectorAll(".relay-base-presence")).toHaveLength(2);
	} finally { m.close(); copy.close(); }
});

test("foreground Bases publish exact cells, render remote cursors, Jump/Follow and preserve hidden observation", async () => {
	const m = baseMotionFixture();
	try {
		const { socket, layer } = await m.open();
		m.send(); await until(() => layer.querySelector(".relay-base-presence-pointer") !== null);
		const peer = m.f.controller.peers[0]; expect(peer.surface).toBe("base");
		expect(await m.f.controller.navigate(peer.key, true)).toBe(true); expect(m.rows[0].cells[1].el.scrollIntoView).toHaveBeenCalled();
		m.rows[0].cells[1].el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 250, clientY: 75 }));
		expect(m.f.controller.following).toBeUndefined();
		await until(() => socket.frames.some(frame => frame.type === "base_state" && (frame.state as ReturnType<typeof m.state>)?.pointer?.target.record_id === m.f.notes[0].doc.entityGuid));
		const pointer = layer.querySelector<HTMLElement>(".relay-base-presence-pointer")!; expect(pointer.style.left).toBe("250px");
		await m.f.controller.setVisible(false); expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
		await until(() => layer.querySelector(".relay-base-presence-pointer") === pointer); expect(m.f.controller.peers).toHaveLength(1);
		const reads = m.read.mock.calls.length;
		for (let n = 0; n < 50; n++) m.f.controller.refresh(); await new Promise(resolve => window.setTimeout(resolve, 150)); expect(m.read).toHaveBeenCalledTimes(reads);
		m.f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: { [m.base.file.path]: "read" } });
		await until(() => layer.children.length === 0); expect(m.f.controller.peers).toHaveLength(1); expect(await m.f.controller.navigate(peer.key, false)).toBe(false);
		expect(m.base.host.data).toBe(m.base.source); expect(m.f.openFile).not.toHaveBeenCalled();
		m.f.logout(); expect(m.f.controller.peers).toEqual([]); expect(m.base.content.querySelector(".relay-base-presence")).toBeNull();
	} finally { m.close(); }
});

test("a newer precise Follow target supersedes delayed record verification without scrolling the old target", async () => {
	const m = baseMotionFixture(); let finish!: (value: Awaited<ReturnType<typeof m.read>>) => void;
	try {
		await m.open(); m.send(); await until(() => m.read.mock.calls.some(call => call[0] === m.f.notes[0].doc.entityGuid));
		expect(await m.f.controller.navigate(m.f.controller.peers[0].key, true)).toBe(true);
		const original = m.read.getMockImplementation()!;
		m.read.mockImplementation(entry => entry === m.f.notes[1].doc.entityGuid ? new Promise(resolve => { finish = resolve; }) : original(entry));
		m.send(2, 60); await until(() => !!finish); await new Promise(resolve => window.setTimeout(resolve, 150)); m.send(1, 51, 0.75);
		await until(() => jest.mocked(m.rows[0].cells[1].el.scrollIntoView).mock.calls.length >= 2);
		finish({ protocol_version: 1, share_id: m.f.folder.entityGuid, entry_id: m.f.notes[1].doc.entityGuid, generation: "00000000-0000-4000-8000-000000000060", type: "markdown" });
		await new Promise(resolve => window.setTimeout(resolve, 200)); expect(m.rows[1].cells[1].el.scrollIntoView).not.toHaveBeenCalled(); expect(m.f.controller.following).toBeDefined();
	} finally { m.close(); }
});

test.each(["sabidurian-timeline", "sabidurian-sequence"])("precise %s presence uses the real bridge client and respects navigation locks", async type => {
	const m = baseMotionFixture(), { base, renderer, f } = m; let busy = false, changed: (() => void) | undefined;
	base.serial.views[0].type = renderer.type = renderer.config.type = type;
	base.source = base.host.data = base.host.lastSavedData = JSON.stringify(base.serial); base.record.hash = createHash("sha256").update(base.source).digest("hex");
	base.file.stat.size = Buffer.byteLength(base.source); base.file.stat.mtime++;
	base.context = { ...base.context, content_sha256: base.record.hash, views: base.context.views.map(view => view.slot === 0 ? { ...view, type } : view) };
	const svg = renderer.scrollEl.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg")), cell = svg.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
	cell.getBoundingClientRect = m.rows[0].cells[1].el.getBoundingClientRect;
	const handle = { target: { type: "cell", file: f.notes[0].view.file, property: "note.status" }, element: cell, current: () => cell.isConnected };
	const remote = { protocolVersion: 1, owner: renderer, root: renderer.containerEl,
		capabilities: ["item", "cell", "geometry", "reveal", "annotation"], current: () => base.controller.view === renderer && renderer.containerEl.isConnected,
		viewport: () => renderer.scrollEl, handles: () => [handle], hit: (node: Node) => cell.contains(node) ? handle : undefined,
		reveal: jest.fn(() => "revealed"), beginAnnotation: () => () => {} };
	const bridge = { protocolVersion: 1, available: true, viewTypes: [type], getSurfaces: () => [remote], canNavigate: () => !busy,
		onChange: (callback: () => void) => { changed = callback; return () => { changed = undefined; }; } };
	f.workspace.trigger.mockImplementation((name: string, receive: (value: unknown) => void) => { if (name === "time-and-line:collaboration-request") receive(bridge); });
	try {
		const { socket, layer } = await m.open(); m.send(); await until(() => layer.querySelector(".relay-base-presence-pointer") !== null);
		cell.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 250, clientY: 75 }));
		await until(() => socket.frames.some(frame => frame.type === "base_state" && (frame.state as ReturnType<typeof m.state>)?.pointer?.target.record_id === f.notes[0].doc.entityGuid));
		expect(await f.controller.navigate(f.controller.peers[0].key, false)).toBe(true);
		expect(remote.reveal).toHaveBeenCalledWith({ type: "cell", file: f.notes[0].view.file, property: "note.status" });
		busy = true; expect(await f.controller.navigate(f.controller.peers[0].key, true)).toBe(false);
		bridge.available = false; changed?.(); await until(() => layer.children.length === 0); expect(f.controller.peers).toEqual([]);
		expect(base.host.data).toBe(base.source); expect(base.host.dirty).toBe(false);
	} finally { m.close(); expect(changed).toBeUndefined(); }
});

test.each(["table", "sabidurian-timeline", "sabidurian-sequence"])("foreground %s group publication, overlay, Jump/Follow and permission loss use native adapters", async type => {
	const m = baseMotionFixture(), { base, renderer, f } = m; let busy = false, changed: (() => void) | undefined;
	base.serial.views[0].type = renderer.type = renderer.config.type = type;
	Object.assign(base.serial.views[0], { groupBy: { property: "note.status" } }); Object.assign(renderer.config, { groupBy: { property: "note.status" } });
	base.source = base.host.data = base.host.lastSavedData = JSON.stringify(base.serial); base.record.hash = createHash("sha256").update(base.source).digest("hex");
	base.file.stat.size = Buffer.byteLength(base.source); base.file.stat.mtime++;
	base.context = { ...base.context, content_sha256: base.record.hash, views: base.context.views.map(view => view.slot === 0 ? { ...view, type } : view) };
	const group = renderer.data.groupedData[0]; group.entries.forEach(entry => Object.assign(entry, { getValue: () => new StringValue("Done") }));
	const heading = type === "table" ? renderer.scrollEl.appendChild(document.createElement("div")) : renderer.scrollEl.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg")).appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
	heading.classList.add("bases-group-heading"); heading.scrollIntoView = jest.fn();
	heading.getBoundingClientRect = () => ({ x: 0, y: 40, left: 0, top: 40, right: 400, bottom: 50, width: 400, height: 10, toJSON: () => ({}) });
	Object.assign(renderer.groups[0], { view: renderer, group, groupHeadingEl: heading, tableEl: renderer.scrollEl });
	const groupHandle = { target: { type: "group", group }, element: heading, current: () => heading.isConnected };
	const remote = { protocolVersion: 1, owner: renderer, root: renderer.containerEl,
		capabilities: ["item", "cell", "geometry", "reveal", "annotation", "groups"], current: () => base.controller.view === renderer && renderer.containerEl.isConnected,
		viewport: () => renderer.scrollEl, handles: () => [], hit: () => undefined,
		reveal: jest.fn(() => "revealed"), groups: () => [groupHandle], revealGroup: jest.fn(() => "revealed"), beginAnnotation: () => () => {} };
	const bridge = { protocolVersion: 1, available: true, viewTypes: [type], getSurfaces: () => [remote], canNavigate: () => !busy,
		onChange: (callback: () => void) => { changed = callback; return () => { changed = undefined; }; } };
	if (type !== "table") f.workspace.trigger.mockImplementation((name: string, receive: (value: unknown) => void) => { if (name === "time-and-line:collaboration-request") receive(bridge); });
	try {
		const { socket, layer } = await m.open();
		expect(socket.frames.find(frame => frame.type === "watch")).toMatchObject({ base_target_version: 2 });
		heading.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 45 }));
		await until(() => socket.frames.some(frame => frame.type === "base_state" && (frame.state as BasePresenceState)?.pointer?.target.type === "group"));
		const state = socket.frames.filter(frame => frame.type === "base_state" && (frame.state as BasePresenceState)?.pointer?.target.type === "group").at(-1)!.state as BasePresenceState;
		const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
		socket.message({ type: "base_states", subscription_id: socket.frames.filter(frame => frame.type === "watch").at(-1)!.subscription_id, status: "available", peers: [{ target, state: { ...state, viewport: null } }] });
		await until(() => layer.children.length === 1); expect(layer.querySelector<HTMLElement>(".relay-base-presence-pointer")?.style.left).toBe("100px");
		const peer = f.controller.peers[0]; expect(await f.controller.navigate(peer.key, true)).toBe(true);
		if (type === "table") expect(heading.scrollIntoView).toHaveBeenCalled(); else expect(remote.revealGroup).toHaveBeenCalledWith(group);
		heading.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 45 })); expect(f.controller.following).toBeUndefined();
		if (type !== "table") { busy = true; expect(await f.controller.navigate(peer.key, true)).toBe(false); }
		await f.controller.setVisible(false); await until(() => socket.frames.filter(frame => frame.type === "presence").at(-1)?.location === null); expect(layer.children).toHaveLength(1);
		f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: { [base.file.path]: "read" } });
		await until(() => layer.children.length === 0); expect(f.controller.peers).toHaveLength(1); expect(await f.controller.navigate(peer.key, false)).toBe(false);
		bridge.available = false; changed?.(); expect(base.host.data).toBe(base.source); expect(base.host.dirty).toBe(false);
	} finally { m.close(); expect(changed).toBeUndefined(); }
});

test.each([['sabidurian-timeline', false], ['sabidurian-timeline', true], ['sabidurian-sequence', false], ['sabidurian-sequence', true]] as const)("foreground %s range presence (lane=%s) publishes, projects and follows semantic positions", async (type, withLane) => {
	const m = baseMotionFixture(), { base, renderer, f } = m; let busy = false, rangeLive = true, changed: (() => void) | undefined;
	base.serial.views[0].type = renderer.type = renderer.config.type = type;
	if (withLane) { Object.assign(base.serial.views[0], { groupBy: { property: "note.status" } }); Object.assign(renderer.config, { groupBy: { property: "note.status" } }); }
	base.source = base.host.data = base.host.lastSavedData = JSON.stringify(base.serial); base.record.hash = createHash("sha256").update(base.source).digest("hex");
	base.file.stat.size = Buffer.byteLength(base.source); base.file.stat.mtime++;
	base.context = { ...base.context, content_sha256: base.record.hash, views: base.context.views.map(view => view.slot === 0 ? { ...view, type } : view) };
	const group = renderer.data.groupedData[0]; group.entries.forEach(entry => Object.assign(entry, { getValue: () => new StringValue("Done") }));
	const heading = renderer.scrollEl.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg")).appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
	heading.getBoundingClientRect = () => ({ x: 0, y: 40, left: 0, top: 40, right: 400, bottom: 50, width: 400, height: 10, toJSON: () => ({}) });
	const groupHandle = { target: { type: "group", group }, element: heading, current: () => heading.isConnected };
	const sequence = type === "sabidurian-sequence", axis = { version: 1, renderer: type, start_property: { source: "note", name: sequence ? "order" : "start" }, end_property: null, time_zone: sequence ? null : "UTC" };
	const context = { axis, effectiveTimeZone: axis.time_zone, kinds: sequence ? ["ordinal"] : ["instant"], current: () => rangeLive };
	const range = sequence ? { version: 1, kind: "ordinal", start: "1.25", end: "1.25", unit: "property-value", start_inclusive: true, end_inclusive: true } :
		{ version: 1, kind: "instant", start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T00:00:00.000Z", time_zone: "UTC", start_inclusive: true, end_inclusive: true };
	const visibleRange = { ...range, end: sequence ? "3" : "2026-01-02T00:00:00.000Z" };
	const remote = { protocolVersion: 1, owner: renderer, root: renderer.containerEl,
		capabilities: ["item", "cell", "geometry", "reveal", "annotation", "groups", "ranges", "range-presence"], current: () => base.controller.view === renderer && renderer.containerEl.isConnected,
		viewport: () => renderer.scrollEl, handles: () => [], hit: () => undefined, reveal: jest.fn(() => "revealed"), groups: () => withLane ? [groupHandle] : [], revealGroup: jest.fn(() => "revealed"), beginAnnotation: () => () => {},
		rangeContext: () => context, rangeGeometry: jest.fn(), revealRange: jest.fn(), beginRange: jest.fn(),
		rangePresence: jest.fn((point?: unknown) => ({ context, range: point ? range : visibleRange, group: withLane ? group : null, offset: { x: 0.5, y: 0.5 }, current: () => rangeLive })),
		rangePresenceGeometry: jest.fn(() => ({ startX: 100, endX: 100, top: 50, bottom: 150, discontinuous: false, current: () => rangeLive })),
		revealRangePresence: jest.fn(() => "revealed") };
	const bridge = { protocolVersion: 1, available: true, viewTypes: [type], getSurfaces: () => [remote], canNavigate: () => !busy,
		onChange: (callback: () => void) => { changed = callback; return () => { changed = undefined; }; } };
	f.workspace.trigger.mockImplementation((name: string, receive: (value: unknown) => void) => { if (name === "time-and-line:collaboration-request") receive(bridge); });
	try {
		const { socket, layer } = await m.open();
		renderer.scrollEl.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
		await until(() => socket.frames.some(frame => frame.type === "base_state" && (frame.state as BasePresenceState)?.pointer?.target.type === "timeline_range"));
		const state = socket.frames.filter(frame => frame.type === "base_state" && (frame.state as BasePresenceState)?.pointer?.target.type === "timeline_range").at(-1)!.state as BasePresenceState;
		expect(state.version).toBe(2); expect(state.viewport?.target).toMatchObject({ type: "timeline_range", range: visibleRange });
		expect(state.pointer?.target).toMatchObject({ type: "timeline_range", lane: withLane ? expect.objectContaining({ type: "group" }) : null });
		const target = { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" };
		socket.message({ type: "base_states", subscription_id: socket.frames.filter(frame => frame.type === "watch").at(-1)!.subscription_id, status: "available", peers: [{ target, state }] });
		await until(() => layer.children.length === 1); const marker = layer.querySelector<HTMLElement>(".relay-base-presence-pointer")!;
		expect([marker.style.left, marker.style.top]).toEqual(["100px", "100px"]);
		const peer = f.controller.peers[0]; expect(await f.controller.navigate(peer.key, false)).toBe(true);
		expect(remote.revealRangePresence).toHaveBeenLastCalledWith(range, axis, { x: 0.5, y: 0.5 }, withLane ? group : undefined);
		expect(await f.controller.navigate(peer.key, true)).toBe(true);
		expect(remote.revealRangePresence).toHaveBeenLastCalledWith(visibleRange, axis, { x: 0.5, y: 0.5 }, withLane ? group : undefined);
		renderer.scrollEl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 })); expect(f.controller.following).toBeUndefined();
		busy = true; expect(await f.controller.navigate(peer.key, true)).toBe(false); busy = false;
		await f.controller.setVisible(false); expect(layer.children).toHaveLength(1);
		if (withLane) {
			f.folder.crdtDoc.getMap("managed_base_v1").set("snapshot", { owner: false, permissions: { [base.file.path]: "read" } });
			await until(() => layer.children.length === 0); expect(f.controller.peers).toHaveLength(1); expect(await f.controller.navigate(peer.key, false)).toBe(false);
		}
		rangeLive = false; window.dispatchEvent(new Event("resize")); await until(() => layer.children.length === 0);
		expect(remote.beginRange).not.toHaveBeenCalled(); expect(remote.revealRange).not.toHaveBeenCalled(); expect(base.host.data).toBe(base.source);
		f.logout(); expect(base.content.querySelector(".relay-base-presence")).toBeNull();
	} finally { m.close(); expect(changed).toBeUndefined(); }
});

test.each([["reading", false], ["live-preview", false], ["reading", true], ["live-preview", true]] as const)("%s split panes (different notes=%s) share one connection without passive publication", async (mode, different) => {
	const network = crossNetwork(true, () => f.image.location, true, undefined, undefined, different), f = fixture(true, true), [first, second] = f.notes;
	const stops: (() => void)[] = [], anchors = new EmbeddedImageAnchors(first.text), secondAnchors = new EmbeddedImageAnchors(second.text);
	const oldRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects"), oldBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
	Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
	Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect(0, 0, 8, 14) });
	let remote: ReturnType<typeof remotePeer> | undefined, passiveRemote: ReturnType<typeof remotePeer> | undefined, shown = true;
	let bindPassive: (() => void) | undefined;
	const box = (element: HTMLElement, height = 250) => {
		Object.defineProperties(element, { offsetWidth: { configurable: true, value: 400 }, offsetHeight: { configurable: true, value: height }, clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: height } });
		element.getBoundingClientRect = () => new DOMRect(0, 0, 400, height);
		element.getClientRects = () => [element.getBoundingClientRect()] as unknown as DOMRectList;
	};
	try {
		first.text.delete(0, first.text.length); first.text.insert(0, "![[Picture.png]]");
		if (different) { second.text.delete(0, second.text.length); second.text.insert(0, "![[Picture.png]]"); }
		else { second.view.file = first.view.file; second.binding.boundDocument = first.binding.boundDocument; second.view.getViewData = () => first.text.toString(); }
		const images = [first, second].map(note => {
			const text = different ? note.text : first.text, documentId = different ? note.doc.entityGuid : first.doc.entityGuid;
			if (note === second && mode === "live-preview") {
				note.mode("source"); f.editors[1].stop();
				const editor = f.editors[1].editor, image = document.createElement("img"); image.src = "app://local/Picture.png";
				Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
				editor.setState(EditorState.create({ doc: text.toString(), extensions: [editorInfoField.init(() => ({ file: note.view.file, editor: second.view.editor } as never)), ...f.extensions,
					EditorView.decorations.of(Decoration.set([Decoration.replace({ widget: new class extends WidgetType { toDOM() { return image; } }() }).range(0, text.length)]))] }));
				bindPassive = () => stops.push(bindCommentEditor(editor, () => ({ documentId, text })));
				for (let element: HTMLElement | null = image; element && note.view.contentEl.contains(element); element = element.parentElement) box(element);
				return image;
			}
			note.mode("preview"); stops.push(bindReadingComments(note.view, () => ({ documentId, text })));
			box(note.view.contentEl, 600);
			const section = note.view.contentEl.appendChild(document.createElement("div")); box(section);
			const image = section.appendChild(document.createElement("img")); image.src = "app://local/Picture.png"; box(image);
			Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 500 } });
			const context = { sourcePath: note.view.file!.path, getSectionInfo: () => ({ text: text.toString(), lineStart: 0, lineEnd: 0 }),
				addChild: (child: { onload(): void; unload(): void }) => { child.onload(); stops.push(() => child.unload()); } } as unknown as MarkdownPostProcessorContext;
			f.processors.forEach(processor => processor(section, context)); return image;
		});
		second.view.contentEl.getClientRects = () => (shown ? [second.view.contentEl.getBoundingClientRect()] : []) as unknown as DOMRectList;
		remote = remotePeer(f); if (different) passiveRemote = remotePeer(f, 1); f.controller.refresh();
		await until(() => network.sockets.length === 1); const socket = network.sockets[0]; socket.ready();
		await until(() => socket.frames.some(frame => frame.type === "watch_embeds"));
		const captures = await Promise.all((different ? [anchors, secondAnchors] : [anchors]).map(anchor => anchor.capture(anchor.images[0],
			{ kind: "managed", entry_id: f.image.location.entry_id, generation: f.image.location.generation, sha256: f.image.location.content_sha256 },
			{ width: 800, height: 500, orientation: "display" }, { pointer: { x: 0.5, y: 0.5 }, viewport: null })));
		const send = () => {
			for (const [index, note] of (different ? [first, second] : [first]).entries()) {
				const request = socket.frames.filter(frame => ["watch_embeds", "observe"].includes(String(frame.type)) && (frame.location as { entry_id: string }).entry_id === note.doc.entityGuid).at(-1);
				if (request) socket.message({ type: "image_embeds", subscription_id: request.subscription_id, status: "available",
					peers: [{ target: { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" }, embed: captures[index] }] });
			}
		};
		const deniedSubscriptions = new Set<unknown>();
		const painted = async () => {
			await until(() => (different ? [first, second] : [first]).every(note => socket.frames.some(frame =>
				["watch_embeds", "observe"].includes(String(frame.type)) && (frame.location as { entry_id: string }).entry_id === note.doc.entityGuid && !deniedSubscriptions.has(frame.subscription_id) &&
				!socket.frames.some(other => ["unwatch", "unobserve"].includes(String(other.type)) && other.subscription_id === frame.subscription_id))));
			send();
			await until(() => [first, second].every(note => note.view.contentEl.querySelector(".relay-image-presence")));
			for (const note of [first, second]) note.view.contentEl.querySelectorAll<HTMLElement>(".relay-image-presence").forEach(layer => box(layer, 600));
			window.dispatchEvent(new Event("resize"));
			await until(() => [first, second].every(note => note.view.contentEl.querySelector(".relay-image-presence-pointer")?.textContent === "Peer"));
		};
		send();
		if (bindPassive) {
			// The Live Preview editor may finish binding after the pane switch,
			// without another layout/selection event or remote message.
			await new Promise(resolve => setTimeout(resolve, 350));
			expect(second.view.contentEl.querySelector(".relay-image-presence")).toBeNull();
			bindPassive();
			await until(() => !!second.view.contentEl.querySelector(".relay-image-presence"));
		}
		await painted(); expect(socket.frames.filter(frame => frame.type === "watch_embeds")).toHaveLength(1);
		expect(socket.frames.filter(frame => frame.type === "observe")).toHaveLength(different ? 1 : 0);
		const reads = f.vault.readBinary.mock.calls.length;
		for (let i = 0; i < 10; i++) { f.controller.refresh(); send(); }
		images[1].dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 125 }));
		await settled(); expect(socket.frames.some(frame => frame.type === "image_embed" && frame.embed)).toBe(false);
		expect(f.vault.readBinary).toHaveBeenCalledTimes(reads); expect(network.sockets).toHaveLength(1);
		if (different) {
			passiveRemote!.send();
			await until(() => !second.view.contentEl.querySelector(".relay-image-presence-pointer"));
			expect(first.view.contentEl.querySelector(".relay-image-presence-pointer")).not.toBeNull();
			passiveRemote!.send(6); await painted();
			const request = socket.frames.filter(frame => frame.type === "observe").at(-1)!;
			// Identical image syntax in a different Y.Text is not an anchor match.
			socket.message({ type: "image_embeds", subscription_id: request.subscription_id, status: "available",
				peers: [{ target: { user_id: "00000000-0000-4000-8000-000000000008", session_id: "a".repeat(32), instance_id: "00000000-0000-4000-8000-000000000009" }, embed: captures[0] }] });
			await until(() => !second.view.contentEl.querySelector(".relay-image-presence-pointer"));
			await painted();
			deniedSubscriptions.add(request.subscription_id);
			socket.message({ type: "image_embeds", subscription_id: request.subscription_id, status: "unavailable" });
			await until(() => !second.view.contentEl.querySelector(".relay-image-presence-pointer"));
			expect(first.view.contentEl.querySelector(".relay-image-presence-pointer")).not.toBeNull(); expect(f.controller.canRetry).toBe(true);
			const count = socket.frames.filter(frame => frame.type === "observe").length;
			for (let i = 0; i < 10; i++) f.controller.refresh();
			expect(socket.frames.filter(frame => frame.type === "observe")).toHaveLength(count);
			f.controller.retry(); await painted();
		}
		await f.controller.setVisible(false); expect(second.view.contentEl.querySelector(".relay-image-presence-pointer")).not.toBeNull();
		shown = false; f.controller.refresh(); expect(second.view.contentEl.querySelector(".relay-image-presence")).toBeNull();
		shown = true; f.controller.refresh(); await painted();
		second.binding.connectionAllowed = false; f.controller.refresh(); expect(second.view.contentEl.querySelector(".relay-image-presence")).toBeNull();
		second.binding.connectionAllowed = true; f.controller.refresh(); await painted();
		// Changing the foreground pane must not create a second publisher or
		// leave the old pane's delayed verification attached to the wrong owner.
		await f.controller.setVisible(true); f.select(second.view); send(); await painted();
		expect(network.sockets).toHaveLength(1);
		if (different) { f.select(f.image.view); await painted(); expect(network.sockets).toHaveLength(1); }
		f.logout(); expect(first.view.contentEl.querySelector(".relay-image-presence")).toBeNull(); expect(second.view.contentEl.querySelector(".relay-image-presence")).toBeNull();
	} finally {
		stops.forEach(stop => stop()); anchors.close(); secondAnchors.close(); remote?.close(); passiveRemote?.close(); f.close(); network.close();
		if (oldRects) Object.defineProperty(Range.prototype, "getClientRects", oldRects); else Reflect.deleteProperty(Range.prototype, "getClientRects");
		if (oldBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", oldBounds); else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
	}
});

test("embedded Bases render precise peers and Jump/Follow without opening a standalone file", async () => {
	const m = baseMotionFixture(true), { f, base } = m, note = f.notes[0];
	note.view.contentEl.append(base.root);
	Object.assign(note.view, { _children: [{ _loaded: true, file: base.file, containingFile: note.view.file, containerEl: base.content, controller: base.controller }] });
	base.content.getClientRects = () => [base.content.getBoundingClientRect()] as unknown as DOMRectList;
	try {
		await until(() => m.network.sockets.length === 1); const socket = m.network.sockets[0]; socket.ready();
		await until(() => base.content.querySelector(".relay-base-presence") !== null);
		base.content.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		await until(() => socket.frames.some(frame => frame.type === "watch" && frame.base_states === true));
		const layer = base.content.querySelector<HTMLElement>(".relay-base-presence")!; m.box(layer, 400, 300);
		socket.roster(); m.send(); await until(() => layer.querySelector(".relay-base-presence-pointer") !== null);
		const peer = f.controller.peers[0];
		expect(f.controller.surfaceName).toBe("Bases view");
		expect(await f.controller.navigate(peer.key, false)).toBe(true);
		expect(await f.controller.navigate(peer.key, true)).toBe(true);
		expect(m.rows[0].cells[1].el.scrollIntoView).toHaveBeenCalled();
		expect(f.openFile).not.toHaveBeenCalled();
		m.send(1, 51, 0.75); await new Promise(resolve => window.setTimeout(resolve, 200));
		expect(f.controller.following).toBeDefined(); expect(f.openFile).not.toHaveBeenCalled();
		note.view.contentEl.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		await until(() => f.controller.surfaceName !== "Bases view"); expect(f.controller.following).toBeUndefined();
	} finally { m.close(); }
});
