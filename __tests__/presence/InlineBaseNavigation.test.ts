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
