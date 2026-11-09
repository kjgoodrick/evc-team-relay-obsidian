/** @jest-environment jsdom */
import { TFile } from "obsidian";
import { embeddedBases, embeddedBaseHost } from "../../src/bases/EmbeddedBasesHost";
jest.mock("obsidian", () => ({ ...jest.requireActual("../mocks/nativeBaseValues"), parseYaml: JSON.parse }));
const file = (path: string) => Object.assign(Object.create(TFile.prototype), { path, extension: path.split(".").pop(), stat: { mtime: 1, size: 20 } }) as TFile;
function fixture() {
	const root = document.createElement("div"), container = document.createElement("div"); root.append(container); document.body.append(root);
	const note = file("Team/Note.md"), base = file("Team/Plan.base"), controller = { query: {} };
	const embed = { _loaded: true, file: base, containingFile: note, controller, containerEl: container, _children: [] as unknown[] };
	const view = { file: note, contentEl: root, _children: [embed] as unknown[] };
	return { root, container, note, base, controller, embed, view };
}
afterEach(() => document.body.replaceChildren());
test("discovers a saved-file embed by component ownership and rejects inline/foreign/detached components", () => {
	const f = fixture();
	expect(embeddedBases(f.view, "1.13.7")).toHaveLength(1);
	expect(embeddedBases(f.view, "1.13.8")).toEqual([]);
	f.embed.file = f.note;
	expect(embeddedBases(f.view, "1.13.7")).toEqual([]);
	f.embed.file = f.base; f.embed.containingFile = file("Other.md");
	expect(embeddedBases(f.view, "1.13.7")).toEqual([]);
	f.embed.containingFile = f.note; f.container.remove();
	expect(embeddedBases(f.view, "1.13.7")).toEqual([]);
});
test("cycles terminate and an oversized component tree is not partially accepted", () => {
	const f = fixture(); f.embed._children = [f.view];
	expect(embeddedBases(f.view, "1.13.7")).toHaveLength(1);
	f.view._children = [f.embed, ...Array.from({ length: 255 }, () => ({ _children: [] }))];
	expect(embeddedBases(f.view, "1.13.7")).toEqual([]);
});
test("facade observes renderer replacement and fences changed bytes or revoked host access", () => {
	const f = fixture(); let allowed = true;
	const host = embeddedBaseHost(embeddedBases(f.view, "1.13.7")[0], "views: []", () => allowed);
	expect(host.query).toBe(f.controller.query); expect(host.dirty).toBe(false);
	f.embed.controller = { query: { changed: true } };
	expect(host.controller).toBe(f.embed.controller);
	allowed = false; expect(host.controller).toBeUndefined(); expect(host.data).toBeUndefined();
	allowed = true; f.base.stat.mtime++;
	expect(host.dirty).toBe(true); expect(host.lastSavedData).toBeUndefined();
});
