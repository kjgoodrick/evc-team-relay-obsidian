/** @jest-environment jsdom */
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { MarkdownView } from "obsidian";
import type { YSweetProvider } from "../../src/client/provider";
import { ReadingPresenceLayer } from "../../src/collaboration/presence/ReadingPresenceLayer";
import { ReadingSource, ReadingSectionMap, mapReadingSection } from "../../src/collaboration/anchors/reading";

const rect = (left: number, top: number, width: number, height: number) => ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON() {} });
let rangeRects: jest.Mock;
const cssDescriptor = Object.getOwnPropertyDescriptor(window, "CSS"), highlightDescriptor = Object.getOwnPropertyDescriptor(window, "Highlight");
beforeEach(() => {
	jest.useFakeTimers();
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
		return this.dataset.section ? rect(20, 60, 500, 50) : rect(0, 0, 600, 400);
	});
	jest.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [rect(0, 0, 600, 400)] as unknown as DOMRectList);
	jest.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
	jest.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
	rangeRects = jest.fn(function(this: Range) { return [rect(80 + this.startOffset * 8, 80, this.collapsed ? 0 : this.toString().length * 8, 18)]; });
	Range.prototype.getClientRects = rangeRects;
});
afterEach(() => {
	document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers();
	if (cssDescriptor) Object.defineProperty(window, "CSS", cssDescriptor); else Reflect.deleteProperty(window, "CSS");
	if (highlightDescriptor) Object.defineProperty(window, "Highlight", highlightDescriptor); else Reflect.deleteProperty(window, "Highlight");
});
async function settle() { await jest.advanceTimersByTimeAsync(150); }
function fixture() {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "repeat **repeat**");
	const awareness = new Awareness(doc), root = document.createElement("div"), section = document.createElement("div"); section.dataset.section = "true";
	section.innerHTML = "<p>repeat <strong>repeat</strong></p>"; root.append(section); document.body.append(root);
	const listeners = new Map<string, Set<() => void>>(); let allowed = true, connected = true, source = new ReadingSource(text.toString());
	const provider = { awareness, on: (name: string, fn: () => void) => { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); }, off: (name: string, fn: () => void) => listeners.get(name)?.delete(fn) };
	let mapped: ReadingSectionMap | undefined, mappedSource: ReadingSource | undefined;
	const snapshots = () => [{ root: section, from: 0, to: source.source.length, map: () => {
		if (!mapped?.isCurrent() || mappedSource !== source) { mappedSource = source; mapped = mapReadingSection(section, source.source, 0, source.source.length, source); } return mapped;
	} }];
	const scope = { view: { contentEl: root } as unknown as MarkdownView, text, id: "note", provider: provider as unknown as YSweetProvider, current: () => allowed && connected };
	const layer = new ReadingPresenceLayer(scope, snapshots, () => { source = new ReadingSource(text.toString()); });
	const remotes: { doc: Y.Doc; awareness: Awareness }[] = [];
	const peer = (surface: "reading" | "editor" = "reading", name = "Ada", from = 9, to = 15) => {
		const remoteDoc = new Y.Doc(), remote = new Awareness(remoteDoc); remotes.push({ doc: remoteDoc, awareness: remote });
		const send = (start = from, end = to, label = name) => {
			const anchor = Y.createRelativePositionFromTypeIndex(text, start), head = Y.createRelativePositionFromTypeIndex(text, end);
			remote.setLocalState({ user: { id: "ada-" + remote.clientID, name: label }, sessionId: "a".repeat(32), surface,
				[surface === "reading" ? "selection" : "cursor"]: { anchor, head } });
			applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
		};
		const leave = () => { remote.setLocalState(null); applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), "test"); };
		send(); return { send, leave, remote };
	};
	return { doc, text, awareness, root, section, peer, layer, scope, listeners,
		revoke: () => { allowed = false; layer.validate(); },
		connection: (value: boolean) => { connected = value; listeners.get("status")?.forEach(fn => fn()); },
		close: () => { layer.close(); remotes.forEach(remote => { remote.awareness.destroy(); remote.doc.destroy(); }); awareness.destroy(); doc.destroy(); root.remove(); },
	};
}

test("draws the second repeated selection, keeps names as text, and never changes local selection or publishes", async () => {
	const f = fixture();
	try {
		const range = document.createRange(); range.selectNodeContents(f.section.querySelector("strong")!); document.getSelection()!.addRange(range);
		const original = document.getSelection()!.toString(), local = f.awareness.getLocalState(), mapping = jest.spyOn(ReadingSectionMap.prototype, "domRanges");
		f.peer("reading", "<img src=x>"); await settle();
		expect(mapping).toHaveBeenCalledWith(9, 15, expect.anything()); expect(f.root.querySelector(".relay-reading-presence-selection")).not.toBeNull();
		expect(f.root.querySelector(".relay-reading-presence-name")?.textContent).toBe("<img src=x>"); expect(f.root.querySelector("img")).toBeNull();
		expect(f.root.querySelector(".relay-reading-presence-caret")).toBeNull(); expect(document.getSelection()!.toString()).toBe(original);
		expect(f.awareness.getLocalState()).toEqual(local); expect(f.text.toString()).toBe("repeat **repeat**");
	} finally { f.close(); }
});

test("shows exact editor carets but does not invent a caret inside invisible Markdown syntax", async () => {
	const f = fixture();
	try {
		const peer = f.peer("editor", "Ada", 9, 9); await settle();
		expect(f.root.querySelector(".relay-reading-presence-caret")).not.toBeNull();
		peer.send(8, 8); await settle(); expect(f.root.querySelector(".relay-reading-presence-caret")).toBeNull(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
	} finally { f.close(); }
});

test("uses independent native highlight names per pane and cleans only its own registry entries", async () => {
	class Highlight { constructor(readonly ranges: Range[]) {} }
	const highlights = new Map<string, unknown>([["relay-comments-open", {}]]);
	Object.defineProperty(window, "CSS", { configurable: true, value: { highlights } });
	Object.defineProperty(window, "Highlight", { configurable: true, value: class extends Highlight { constructor(...ranges: Range[]) { super(ranges); } } });
	const a = fixture(), b = fixture();
	try {
		a.peer(); b.peer(); await settle(); expect(highlights.size).toBe(3);
		expect([...highlights.values()].filter(value => value instanceof Highlight).map(value => (value as Highlight).ranges[0].toString())).toEqual(["repeat", "repeat"]);
		expect(a.root.querySelector(".relay-reading-presence-selection")).toBeNull(); a.layer.close(); expect(highlights.size).toBe(2);
		b.layer.close(); expect([...highlights.keys()]).toEqual(["relay-comments-open"]);
	} finally { a.close(); b.close(); }
});

test("source edits clear old geometry immediately and reattach relative positions only after matching render", async () => {
	const f = fixture();
	try {
		f.peer(); await settle(); f.text.insert(0, "prefix ");
		expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull(); await settle(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
		f.section.querySelector("p")!.firstChild!.textContent = "prefix repeat "; await settle();
		expect(f.root.querySelector(".relay-reading-presence-name")?.textContent).toBe("Ada");
	} finally { f.close(); }
});

test("changed-peer mapping is reused for unchanged peers and scroll-only redraws", async () => {
	const f = fixture(), mapping = jest.spyOn(ReadingSectionMap.prototype, "domRanges");
	try {
		const a = f.peer(); f.peer("reading", "Grace"); await settle(); const calls = mapping.mock.calls.length;
		document.dispatchEvent(new Event("scroll")); await settle(); expect(mapping).toHaveBeenCalledTimes(calls);
		a.send(0, 6); await settle(); expect(mapping).toHaveBeenCalledTimes(calls + 1);
	} finally { f.close(); }
});

test("leave, disconnect and permission loss clear labels before delayed updates can revive them", async () => {
	const f = fixture();
	try {
		const peer = f.peer(); await settle(); peer.leave(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
		peer.send(); await settle(); f.connection(false); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
		peer.send(0, 6); await settle(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
		f.connection(true); await settle(); expect(f.root.querySelector(".relay-reading-presence-name")).not.toBeNull();
		f.revoke(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull(); await settle(); expect(f.root.querySelector(".relay-reading-presence-name")).toBeNull();
	} finally { f.close(); }
});

test("clips selections, bounds fallback rectangles, and removes all observers and scheduled work on close", async () => {
	const f = fixture();
	rangeRects.mockImplementation(function(this: Range) { return this.collapsed ? [rect(100, 80, 0, 18)] : Array.from({ length: 500 }, () => rect(-20, 80, 100, 18)); });
	try {
		for (let i = 0; i < 16; i++) f.peer("reading", "Peer " + i); await settle();
		expect(f.root.querySelectorAll(".relay-reading-presence-selection")).toHaveLength(256);
		expect(f.root.querySelector<HTMLElement>(".relay-reading-presence-selection")!.style.left).toBe("0px");
		expect(f.root.querySelectorAll(".relay-reading-presence-name")).toHaveLength(16);
		f.layer.close(); document.dispatchEvent(new Event("scroll")); await settle();
		expect([...f.listeners.values()].every(listeners => listeners.size === 0)).toBe(true); expect(f.root.querySelector(".relay-reading-presence")).toBeNull();
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("large shared selections have a total native-range budget while retaining each peer label", async () => {
	class Highlight { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } }
	const highlights = new Map<string, Highlight>();
	Object.defineProperty(window, "CSS", { configurable: true, value: { highlights } }); Object.defineProperty(window, "Highlight", { configurable: true, value: Highlight });
	const f = fixture();
	try {
		const lines = Array.from({ length: 400 }, (_, index) => "row" + index);
		f.text.delete(0, f.text.length); f.text.insert(0, lines.join("\n\n")); f.section.innerHTML = lines.map(line => `<p>${line}</p>`).join("");
		for (let i = 0; i < 16; i++) f.peer("reading", "Peer " + i, 0, f.text.length);
		await settle(); expect(highlights.size).toBe(16);
		expect([...highlights.values()].reduce((count, highlight) => count + highlight.ranges.length, 0)).toBe(512);
		expect(f.root.querySelectorAll(".relay-reading-presence-name")).toHaveLength(16);
	} finally { f.close(); }
});
