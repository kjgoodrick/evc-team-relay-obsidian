import { GFM, parser } from "@lezer/markdown";
import type * as Y from "yjs";
import { captureTextAnchor, type TextAnchor } from "./text";

export const BLOCK_KINDS = ["paragraph", "heading", "list_item", "quote", "callout", "code", "table", "html", "rule", "frontmatter"] as const;
export type BlockKind = typeof BLOCK_KINDS[number];
export type BlockStructure = { kind: "blocks"; blocks: { kind: BlockKind; explicit_id?: string }[] };
export type MarkdownBlock = { from: number; to: number; kind: BlockKind; explicit_id?: string };
export const commentMarkdownParser = parser.configure(GFM);
export class BlockSelectionError extends Error {}

/** Source structure is evidence, not a new identity: the durable locator remains
 * the actual Y.Text range. Never add block IDs or normalize the note. */
export function markdownBlocks(source: string): MarkdownBlock[] {
	const blocks: MarkdownBlock[] = [];
	const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(source);
	if (frontmatter) blocks.push({ from: 0, to: frontmatter[0].length, kind: "frontmatter" });
	commentMarkdownParser.parse(source).iterate({ enter(node) {
		if (frontmatter && node.from < frontmatter[0].length && node.name !== "Document") return false;
		let kind: BlockKind | undefined;
		if (/^(ATX|Setext)Heading\d$/.test(node.name)) kind = "heading";
		else if (node.name === "ListItem") kind = "list_item";
		else if (node.name === "Blockquote") kind = /^>[ \t]*\[![^\]\r\n]+\]/.test(source.slice(node.from, node.to)) ? "callout" : "quote";
		else if (node.name === "Paragraph") kind = "paragraph";
		else if (node.name === "FencedCode" || node.name === "CodeBlock") kind = "code";
		else if (node.name === "Table") kind = "table";
		else if (node.name === "HTMLBlock") kind = "html";
		else if (node.name === "HorizontalRule") kind = "rule";
		// List paragraphs belong to the list item; quoted paragraphs belong to
		// their quote/callout. Nested list items retain their own target.
		if (kind && kind !== "list_item") {
			for (let parent = node.node.parent; parent; parent = parent.parent) {
				if (["ListItem", "Blockquote", "Table"].includes(parent.name)) return;
			}
		}
		if (kind) {
			const to = source[node.to - 1] === "\r" ? node.to - 1 : node.to;
			const explicit = /(?:^|\s)\^([A-Za-z0-9-]{1,64})[ \t]*$/.exec(source.slice(node.from, to));
			blocks.push({ from: node.from, to, kind, ...(explicit && kind !== "code" && kind !== "html" ? { explicit_id: explicit[1] } : {}) });
		}
	} });
	return blocks.sort((a, b) => a.from - b.from || b.to - a.to);
}

export function selectMarkdownBlocks(source: string, anchor: number, head: number): { from: number; to: number; structure: BlockStructure } {
	if (!Number.isSafeInteger(anchor) || !Number.isSafeInteger(head) || Math.min(anchor, head) < 0 || Math.max(anchor, head) > source.length) throw new Error("Invalid block selection");
	let from = Math.min(anchor, head), to = Math.max(anchor, head);
	while (from < to && /\s/.test(source[from])) from++;
	while (to > from && /\s/.test(source[to - 1])) to--;
	const blocks = markdownBlocks(source);
	const at = (position: number) => blocks.filter(block => block.from <= position && position < block.to)
		.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
	const first = at(from), last = at(to > from ? to - 1 : from);
	if (!first || !last) throw new BlockSelectionError("Place the cursor in a Markdown block or select its content.");
	from = Math.min(first.from, last.from); to = Math.max(first.to, last.to);
	const selected = blocks.filter(block => block.from >= from && block.to <= to)
		.filter((block, _, all) => !all.some(other => other !== block && other.from <= block.from && other.to >= block.to));
	if (!selected.length || selected.length > 32) throw new BlockSelectionError("Select at most 32 Markdown blocks.");
	return { from, to, structure: { kind: "blocks", blocks: selected.map(({ kind, explicit_id }) => ({ kind, ...(explicit_id ? { explicit_id } : {}) })) } };
}

export function captureBlockAnchor(text: Y.Text, documentId: string, generation: string, anchor: number, head: number): TextAnchor {
	const selected = selectMarkdownBlocks(text.toString(), anchor, head);
	return { ...captureTextAnchor(text, documentId, generation, selected.from, selected.to), structure: selected.structure };
}
