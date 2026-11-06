/** @jest-environment jsdom */
import { TextEncoder } from "node:util";
import * as Y from "yjs";
import { captureImageAnchor, imageAssetChanged, markdownImages, resolveImageOccurrence } from "../../src/collaboration/anchors/images";
import { imagePoint, imageRegion, type ImageAsset } from "../../src/collaboration/anchors/imageGeometry";
import { parseAnchor, protocolJson } from "../../src/collaboration/DiscussionProtocol";
import { queuedEnvelope } from "../../src/collaboration/DiscussionTransport";

jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
Object.assign(globalThis, { TextEncoder });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const basis = { width: 1200, height: 800, orientation: "display" as const };
const asset: ImageAsset = { kind: "managed", entry_id: id(4), sha256: "a".repeat(64) };

test("parses distinct wiki and Markdown image occurrences, dimensions, escaped/encoded destinations and references", () => {
	const source = '![[chart.png|400x200]] and ![[chart.png|100]]\n\n![alt](<image name.png> "title") ![link](https://example.test/a(b).png?a=1&amp;b=2)\n\n![ref][picture]\n\n[picture]: chart%20two.png "Chart"';
	const images = markdownImages(source);
	expect(images.map(image => image.destination)).toEqual(["chart.png", "chart.png", "image name.png", "https://example.test/a(b).png?a=1&b=2", "chart%20two.png"]);
	expect(images[0].from).not.toBe(images[1].from);
	expect(images.map(image => source.slice(image.from, image.to))).toEqual(['![[chart.png|400x200]]', '![[chart.png|100]]', '![alt](<image name.png> "title")', '![link](https://example.test/a(b).png?a=1&amp;b=2)', '![ref][picture]']);
});

test("does not target embed-looking code, frontmatter, hidden comments or HTML", () => {
	const source = '---\nimage: "![[yaml.png]]"\n---\n\n`![[code.png]]`\n\n```md\n![code](code.png)\n```\n\n%% ![[hidden.png]] %% ![[visible.png]]\n\n%%\n![[hidden-block.png]]\n%%\n\n<div>![[html.png]]</div>\n\n![[final.png]]';
	expect(markdownImages(source).map(image => image.destination)).toEqual(["visible.png", "final.png"]);
});

test("the second occurrence follows shared edits and asset rename, never the first identical image", () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![[chart.png]]\n\n![[chart.png]]");
	try {
		const anchor = captureImageAnchor(text, id(1), id(2), markdownImages(text.toString())[1], asset, basis, { type: "pin", x: 0.25, y: 0.75 });
		text.insert(0, "Intro\n\n");
		let resolved = resolveImageOccurrence(text, id(1), id(2), anchor);
		expect(resolved).toMatchObject({ status: "attached", image: { from: 23, destination: "chart.png" } });
		if (resolved.status !== "attached") throw new Error();
		const start = resolved.image.from + 3;
		text.delete(start, "chart".length); text.insert(start, "renamed");
		resolved = resolveImageOccurrence(text, id(1), id(2), anchor);
		expect(resolved).toMatchObject({ status: "attached", image: { destination: "renamed.png" } });
		expect(imageAssetChanged(asset, { ...asset })).toBe(false);
		expect(imageAssetChanged(asset, { ...asset, sha256: "b".repeat(64) })).toBe(true);
		if (resolved.status !== "attached") throw new Error();
		text.delete(resolved.image.from, resolved.image.to - resolved.image.from);
		expect(resolveImageOccurrence(text, id(1), id(2), anchor).status).toBe("unanchored");
		expect(text.toString()).toContain("![[chart.png]]");
	} finally { doc.destroy(); }
});

test("waits for actual Yjs dependency and distinguishes generation and semantic replacement", () => {
	const doc = new Y.Doc(), replica = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![[chart.png]]");
	try {
		const anchor = captureImageAnchor(text, id(1), id(2), markdownImages(text.toString())[0], asset, basis, { type: "whole" });
		expect(resolveImageOccurrence(replica.getText("contents"), id(1), id(2), anchor).status).toBe("waiting_for_sync");
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
		expect(resolveImageOccurrence(replica.getText("contents"), id(1), id(2), anchor).status).toBe("attached");
		expect(resolveImageOccurrence(text, id(1), id(9), anchor).status).toBe("generation_mismatch");
		text.delete(0, 1);
		expect(resolveImageOccurrence(text, id(1), id(2), anchor).status).toBe("changed");
	} finally { doc.destroy(); replica.destroy(); }
});

test("normalizes pointer geometry independently of display size and rejects empty or outside regions", () => {
	expect(imagePoint({ left: 50, top: 20, width: 400, height: 200 }, 150, 170)).toEqual({ x: 0.25, y: 0.75 });
	expect(imagePoint({ left: 50, top: 20, width: 800, height: 400 }, 250, 320)).toEqual({ x: 0.25, y: 0.75 });
	expect(imagePoint({ left: 0, top: 0, width: 100, height: 100 }, -10, 50)).toBeUndefined();
	expect(imagePoint({ left: 0, top: 0, width: 100, height: 100 }, -10, 150, true)).toEqual({ x: 0, y: 1 });
	expect(imageRegion({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.3 })).toMatchObject({ type: "region", x: 0.2, y: 0.3 });
	expect(imageRegion({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeUndefined();
	expect(imageRegion({ x: -1, y: 0 }, { x: 0.5, y: 1 })).toBeUndefined();
});

test("image protocol and offline envelope retain evidence and reject malformed geometry, URLs and document scope", () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![[chart.png]]");
	try {
		const anchor = captureImageAnchor(text, id(1), id(2), markdownImages(text.toString())[0], asset, basis, { type: "region", x: 0.1, y: 0.2, width: 0.4, height: 0.3 });
		expect(parseAnchor(JSON.parse(JSON.stringify(anchor)))).toEqual(anchor);
		for (const change of [
			{ geometry: { type: "pin", x: true, y: 0 } }, { geometry: { type: "region", x: 0.9, y: 0, width: 0.2, height: 1 } },
			{ geometry: { type: "region", x: 0, y: 0, width: 0, height: 1 } }, { basis: { ...basis, width: 0 } },
			{ occurrence: { type: "image", occurrence: anchor } },
			...['https:foo', 'https://user:pass@x.test/img', 'file:///tmp/image', 'data:image/png;base64,AA==', 'https://x.test\\foo', 'https://x.test:99999/a.png', 'https://x.test/\ud800.png'].map(url => ({ asset: { kind: "external", url, version_evidence: "unknown" } })),
		]) expect(() => parseAnchor({ ...anchor, ...change })).toThrow();
		const op = { operationId: id(5), scopeId: id(1), type: "thread.create" as const, dependsOn: [], payload: { type: "thread.create", thread_id: id(6), message_id: id(7), anchor: protocolJson(anchor) } };
		expect(JSON.parse(queuedEnvelope(id(3), op)).command.anchor).toEqual(anchor);
		expect(() => queuedEnvelope(id(3), { ...op, scopeId: id(9) })).toThrow("invalid_local_anchor");
	} finally { doc.destroy(); }
});
