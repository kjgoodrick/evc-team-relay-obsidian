/** @jest-environment jsdom */
import { LocationHost } from "../../src/collaboration/presence/LocationHost";
import { EmbeddedBaseFocus } from "../../src/bases/EmbeddedBaseFocus";
import type { BaseLocation } from "../../src/collaboration/presence/LocationProtocol";

jest.mock("jose", () => ({ decodeJwt: jest.fn() }));
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ Component: class {}, FileView: class {}, MarkdownView: class {}, TFile: class {}, apiVersion: "1.13.7" }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("inline Follow selects the exact registered definition in the containing note before activating its view", () => {
	const file = { extension: "md" }, parent = { file, contentEl: document.createElement("div") };
	const first = { contentEl: document.createElement("div") }, second = { contentEl: document.createElement("div") };
	const focus = new EmbeddedBaseFocus(jest.fn()), changed = jest.fn(), activate = jest.fn(() => "ready");
	const location: BaseLocation = { kind: "base", share_id: id(1), entry_id: id(2), definition_id: id(3), generation: id(4), view_id: id(5), registry_revision: 1 };
	const entries = [first, second].map((view, index) => ({ view, parent, current: () => true,
		proof: { ...location, definition_id: index === 0 ? id(99) : location.definition_id } }));
	focus.set(entries);
	const host = Object.assign(Object.create(LocationHost.prototype), { closed: false,
		plugin: { app: { workspace: { getActiveViewOfType: () => parent } } }, inlineViews: new Map(entries.map(entry => [entry.view, entry])),
		embeddedBaseFocus: focus, callbacks: { changed }, base: { activate }, fileFor: () => file }) as LocationHost;
	try {
		expect(host.activateBase(location, () => true)).toBe("waiting");
		expect(focus.active(parent)).toBe(second); expect(changed).toHaveBeenCalledTimes(1); expect(activate).not.toHaveBeenCalled();
		expect(host.activateBase(location, () => true)).toBe("ready"); expect(activate).toHaveBeenCalledWith(location, expect.any(Function));
		activate.mockClear();
		expect(host.activateBase({ ...location, generation: id(90) }, () => true)).toBe("waiting"); expect(activate).not.toHaveBeenCalled();
		expect(host.activateBase(location, () => false)).toBe("unavailable");
	} finally { focus.close(); }
});

test.each([false, true])("off-screen Follow materializes only the authorized generation (cancel: %s)", async cancel => {
	const { MarkdownView } = await import("obsidian"), Y = await import("yjs");
	const doc = new Y.Doc(), text = doc.getText("content");
	text.insert(0, 'Heading\n\n```base\nviews:\n  - name: Work\n    type: table\n```\n');
	const scroll = jest.fn(), file = { extension: "md" };
	const view = Object.assign(Object.create(MarkdownView.prototype), { file, getMode: () => "preview", previewMode: { applyScroll: scroll } });
	const location: BaseLocation = { kind: "base", share_id: id(1), entry_id: id(2), definition_id: id(3), generation: id(4), view_id: id(5), registry_revision: 1 };
	let current = true;
	const channel = { readInlineBaseContext: jest.fn(async () => { if (cancel) current = false; return { definition_id: id(3), generation: id(4) }; }) };
	const host = Object.assign(Object.create(LocationHost.prototype), { closed: false, inlineViews: new Map(),
		inlineScopes: [{ view, text, current: () => true }], channel, callbacks: { changed: jest.fn() }, fileFor: () => file,
		plugin: { app: { workspace: { getActiveViewOfType: () => view } } } }) as LocationHost;
	try {
		expect(host.activateBase(location, () => current)).toBe("waiting");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(channel.readInlineBaseContext).toHaveBeenCalledTimes(1);
		if (cancel) expect(scroll).not.toHaveBeenCalled(); else expect(scroll).toHaveBeenCalledWith(2);
	} finally { doc.destroy(); }
});
