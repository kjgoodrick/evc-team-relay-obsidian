import * as Y from "yjs";
import { captureBlockAnchor, markdownBlocks, selectMarkdownBlocks } from "../../src/collaboration/anchors/blocks";
import { resolveTextAnchor } from "../../src/collaboration/anchors/text";
import { localTextAnchor, parseAnchor, wireTextAnchor } from "../../src/collaboration/DiscussionProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = "---\ntitle: Review\n---\n\n# Heading\n\nA **paragraph**. ^existing\n\n- first\n  - nested\n- last\n\n> [!note] Callout\n> Details\n\n| a | b |\n|---|---|\n| c | d |\n\n```ts\nconst x = 1;\n```\n\n---\n";

test("block targets follow Markdown structure, retain existing IDs, and do not edit source", () => {
	const blocks = markdownBlocks(source);
	expect(blocks.map(block => block.kind)).toEqual(["frontmatter", "heading", "paragraph", "list_item", "list_item", "list_item", "callout", "table", "code", "rule"]);
	const select = (word: string) => selectMarkdownBlocks(source, source.indexOf(word), source.indexOf(word) + 1);
	expect(select("paragraph").structure.blocks).toEqual([{ kind: "paragraph", explicit_id: "existing" }]);
	const nested = select("nested"); expect(source.slice(nested.from, nested.to)).toBe("- nested");
	expect(select("Details").structure.blocks).toEqual([{ kind: "callout" }]);
	expect(select("const").structure.blocks).toEqual([{ kind: "code" }]);
	expect(select("title").structure.blocks).toEqual([{ kind: "frontmatter" }]);
	expect(selectMarkdownBlocks(source, source.indexOf("paragraph"), source.indexOf("Heading")).structure.blocks)
		.toEqual([{ kind: "heading" }, { kind: "paragraph", explicit_id: "existing" }]);
	expect(() => selectMarkdownBlocks(source, source.indexOf("\n\n") + 1, source.indexOf("\n\n") + 1)).toThrow();
});

test("block anchors use relative source ranges through edits and round trips", () => {
	const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, source);
	const position = source.indexOf("paragraph"), anchor = captureBlockAnchor(text, id(1), id(2), position, position);
	const wire = wireTextAnchor(anchor); expect(localTextAnchor(parseAnchor(wire) as typeof wire)).toEqual(anchor);
	text.insert(0, "Introduction.\n\n");
	const resolved = resolveTextAnchor(text, id(1), id(2), anchor);
	expect(resolved.status).toBe("attached");
	if (resolved.status === "attached") expect(text.toString().slice(resolved.from, resolved.to)).toBe("A **paragraph**. ^existing");
	expect(text.toString()).toBe("Introduction.\n\n" + source);
	expect(() => parseAnchor({ ...wire, structure: { kind: "blocks", blocks: [{ kind: "pixel" }] } })).toThrow();
	expect(() => parseAnchor({ ...wire, structure: { kind: "blocks", blocks: [] } })).toThrow();
	doc.destroy();
});

test("block selection handles CRLF, combining marks, RTL, and bounded multi-block spans", () => {
	const content = "# 🙂\r\n\r\né العربية\r\n\r\nnext\r\n";
	const from = content.indexOf("é"), selected = selectMarkdownBlocks(content, from, from + 1);
	expect(content.slice(selected.from, selected.to)).toBe("é العربية");
	const many = Array.from({ length: 33 }, (_, index) => `Paragraph ${index}`).join("\n\n");
	expect(() => selectMarkdownBlocks(many, 0, many.length)).toThrow("32");
});
