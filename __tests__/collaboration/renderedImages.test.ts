/** @jest-environment jsdom */
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { editorImageTargets, fitImage, intersectBox, readingImageTargets } from "../../src/collaboration/anchors/renderedImages";
import { markdownImages } from "../../src/collaboration/anchors/images";

const basis = { width: 800, height: 400, orientation: "display" as const };
test("maps letterboxing, cover crops, object position and display scaling to intrinsic coordinates", () => {
	const frame = { left: 10, top: 20, width: 200, height: 200 };
	expect(fitImage(frame, basis, "contain", "50% 50%")?.content).toEqual({ left: 10, top: 70, width: 200, height: 100 });
	expect(fitImage(frame, basis, "cover", "100% 0%")?.content).toEqual({ left: -190, top: 20, width: 400, height: 200 });
	expect(fitImage(frame, basis, "fill", "50% 50%")?.content).toEqual(frame);
	expect(fitImage(frame, basis, "none", "left top", 2, 2)?.content).toEqual({ left: 10, top: 20, width: 1600, height: 800 });
	expect(fitImage({ ...frame, width: 1600, height: 1200 }, basis, "scale-down", "25% 50%")?.content).toEqual({ left: 210, top: 420, width: 800, height: 400 });
	expect(fitImage(frame, basis, "contain", "right 10px bottom 20px")).toBeUndefined();
	expect(fitImage({ ...frame, width: 0 }, basis, "fill", "50% 50%")).toBeUndefined();
	expect(intersectBox(frame, { left: 50, top: 0, width: 100, height: 100 })).toEqual({ left: 50, top: 20, width: 100, height: 80 });
});

test("Reading section order distinguishes duplicate embeds and refuses incomplete or injected renders", () => {
	const source = "![[chart.png|320]] ![[chart.png|180]]", images = markdownImages(source), root = document.createElement("p");
	root.innerHTML = '<span class="internal-embed"><img src="app://local/chart.png"></span> <span class="internal-embed"><img src="app://local/chart.png"></span>';
	const mapped = readingImageTargets(root, source, 0, source.length, images);
	expect(mapped.map(item => item.occurrence.from)).toEqual(images.map(item => item.from));
	expect(mapped[1].image).toBe(root.querySelectorAll("img")[1]);
	root.querySelector("img")!.remove();
	expect(readingImageTargets(root, source, 0, source.length, images)).toEqual([]);
	root.innerHTML = '<img src="app://local/chart.png">';
	const html = '![[chart.png]] <img src="chart.png">';
	expect(readingImageTargets(root, html, 0, html.length, markdownImages(html))).toEqual([]);
});

test("actual CodeMirror replacement widgets retain their source occurrence, independent of duplicate image URLs", () => {
	const source = "![[chart.png|320]]\n\n![[chart.png|180]]", occurrences = markdownImages(source), parent = document.createElement("div"); document.body.append(parent);
	class ImageWidget extends WidgetType { toDOM() { const image = document.createElement("img"); image.src = "https://images.test/chart.png"; return image; } }
	const replacements = Decoration.set(occurrences.map(image => Decoration.replace({ widget: new ImageWidget() }).range(image.from, image.to)));
	const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: [EditorView.decorations.of(replacements)] }) });
	try {
		const mapped = editorImageTargets(view.contentDOM, occurrences, node => view.posAtDOM(node));
		expect(mapped).toHaveLength(2); expect(mapped.map(item => item.occurrence.from)).toEqual(occurrences.map(image => image.from));
		expect(editorImageTargets(view.contentDOM, occurrences, () => { throw Error("unmapped"); })).toEqual([]);
	} finally { view.destroy(); parent.remove(); }
});
