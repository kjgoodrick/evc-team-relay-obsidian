import { Schema, type Mark, type Node as EditorNode, type NodeSpec } from "prosemirror-model";
import { isRecord, parseBody, safeDiscussionUrl, type InlineNode, type MessageBody, type Paragraph, type TextMark, type TextNode } from "../DiscussionProtocol";

const paragraph: NodeSpec = { content: "inline*", group: "block", parseDOM: [{ tag: "p", preserveWhitespace: "full" }], toDOM: () => ["p", 0] };

/** The editor schema deliberately matches the bounded version-one message
 * format. External HTML cannot create a mention or private picture reference. */
export const commentSchema = new Schema({
	nodes: {
		doc: { content: "block+" },
		paragraph,
		text: { group: "inline" },
		mention: { group: "inline", inline: true, atom: true, selectable: true, marks: "", attrs: { user_id: {}, label: { default: "Member" } },
			toDOM: node => ["span", { class: "relay-comment-mention", contenteditable: "false" }, "@" + node.attrs.label] },
		picture: { group: "block", atom: true, selectable: true, attrs: { picture_id: {}, alt: { default: "" } },
			toDOM: node => ["div", { class: "relay-comment-picture-placeholder", contenteditable: "false" }, node.attrs.alt || "Picture"] },
		code_block: { content: "text*", group: "block", marks: "", code: true, defining: true, attrs: { language: { default: "" } },
			parseDOM: [{ tag: "pre", preserveWhitespace: "full" }], toDOM: () => ["pre", ["code", 0]] },
		bullet_list: { content: "list_item+", group: "block", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] },
		ordered_list: { content: "list_item+", group: "block", parseDOM: [{ tag: "ol" }], toDOM: () => ["ol", 0] },
		list_item: { content: "paragraph", defining: true, parseDOM: [{ tag: "li" }], toDOM: () => ["li", 0] },
	},
	marks: {
		bold: { parseDOM: [{ tag: "strong" }, { tag: "b" }, { style: "font-weight=bold" }], toDOM: () => ["strong", 0] },
		italic: { parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }], toDOM: () => ["em", 0] },
		code: { code: true, excludes: "", parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
		strike: { parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }], toDOM: () => ["s", 0] },
		link: { attrs: { href: {} }, inclusive: false, parseDOM: [{ tag: "a[href]", getAttrs: element => {
			const href = element.getAttribute("href"); return safeDiscussionUrl(href) ? { href } : false;
		} }], toDOM: mark => ["a", { href: safeDiscussionUrl(mark.attrs.href) ? mark.attrs.href : "", rel: "noopener noreferrer", target: "_blank" }, 0] },
	},
});

/** Drafts can contain the empty paragraph/code block where the user is typing.
 * Validate every other protocol constraint without erasing those empty nodes. */
export function readRichDraftBody(value: unknown): MessageBody {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.blocks) || value.blocks.length === 0 || value.blocks.length > 100) throw new Error("Invalid rich comment draft");
	const copy = JSON.parse(JSON.stringify(value)) as MessageBody;
	const fill = (block: unknown): unknown => isRecord(block) && block.type === "paragraph" && Array.isArray(block.children) && block.children.length === 0 ?
		{ ...block, children: [{ type: "text", text: "\n" }] } : block;
	parseBody({ ...copy, blocks: copy.blocks.map(block => block.type === "list" ? { ...block, items: block.items.map(fill) } :
		block.type === "code" && block.text === "" ? { ...block, text: "\n" } : fill(block)) });
	return copy;
}

export function bodyToCommentDoc(value: MessageBody, name: (id: string) => string): EditorNode {
	const body = readRichDraftBody(value);
	const textNode = (node: TextNode, link?: Mark) => commentSchema.text(node.text, [...(node.marks ?? []).map(mark => commentSchema.marks[mark].create()), ...(link ? [link] : [])]);
	const inline = (nodes: InlineNode[]): EditorNode[] => nodes.flatMap(node => node.type === "text" ? [textNode(node)] : node.type === "mention" ?
		[commentSchema.nodes.mention.create({ user_id: node.user_id, label: name(node.user_id) })] :
		node.children.map(child => textNode(child, commentSchema.marks.link.create({ href: node.url }))));
	const paragraphNode = (node: Paragraph) => commentSchema.nodes.paragraph.create(null, inline(node.children));
	return commentSchema.nodes.doc.create(null, body.blocks.map(block => block.type === "paragraph" ? paragraphNode(block) : block.type === "picture" ?
		commentSchema.nodes.picture.create({ picture_id: block.picture_id, alt: block.alt ?? "" }) : block.type === "code" ?
		commentSchema.nodes.code_block.create({ language: block.language ?? "" }, block.text ? commentSchema.text(block.text) : null) :
		commentSchema.nodes[block.ordered ? "ordered_list" : "bullet_list"].create(null, block.items.map(item => commentSchema.nodes.list_item.create(null, paragraphNode(item))))));
}

function textParts(text: string, marks: readonly Mark[]): TextNode[] {
	const points = Array.from(text), result: TextNode[] = [];
	const names = marks.filter(mark => mark.type.name !== "link").map(mark => mark.type.name as TextMark);
	for (let i = 0; i < points.length; i += 8192) result.push({ type: "text", text: points.slice(i, i + 8192).join(""), ...(names.length ? { marks: names } : {}) });
	return result;
}

export function commentDocBody(doc: EditorNode): MessageBody {
	doc.check();
	const inline = (parent: EditorNode): InlineNode[] => {
		const nodes: InlineNode[] = [];
		parent.forEach(node => {
			if (node.type.name === "mention") nodes.push({ type: "mention", user_id: node.attrs.user_id });
			else if (node.isText) {
				const parts = textParts(node.text!, node.marks), link = node.marks.find(mark => mark.type.name === "link");
				if (!link) nodes.push(...parts);
				else for (const part of parts) {
					const previous = nodes[nodes.length - 1];
					if (previous?.type === "link" && previous.url === link.attrs.href && previous.children.length < 20) previous.children.push(part);
					else nodes.push({ type: "link", url: link.attrs.href, children: [part] });
				}
			} else throw new Error("Unsupported inline comment content");
		});
		return nodes;
	};
	const paragraph = (node: EditorNode): Paragraph => ({ type: "paragraph", children: inline(node) });
	const blocks: MessageBody["blocks"] = [];
	doc.forEach(node => {
		if (node.type.name === "paragraph") blocks.push(paragraph(node));
		else if (node.type.name === "picture") blocks.push({ type: "picture", picture_id: node.attrs.picture_id, alt: node.attrs.alt });
		else if (node.type.name === "code_block") blocks.push({ type: "code", text: node.textContent, language: node.attrs.language });
		else if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
			const items: Paragraph[] = []; node.forEach(item => items.push(paragraph(item.firstChild!)));
			blocks.push({ type: "list", ordered: node.type.name === "ordered_list", items });
		} else throw new Error("Unsupported comment block");
	});
	return readRichDraftBody({ version: 1, blocks });
}

/** Preserve blank lines in a nonempty message; a fully blank draft cannot send. */
export function richCommentBody(value: MessageBody): MessageBody {
	const body = readRichDraftBody(value);
	const meaningful = (node: unknown): boolean => isRecord(node) ? node.type === "mention" || node.type === "picture" ||
		typeof node.text === "string" && !!node.text.trim() || Object.values(node).some(meaningful) : Array.isArray(node) && node.some(meaningful);
	if (!meaningful(body)) throw new Error("Write a comment before sending.");
	const paragraph = (item: Paragraph): Paragraph => item.children.length ? item : { type: "paragraph", children: [{ type: "text", text: "\n" }] };
	return parseBody({ ...body, blocks: body.blocks.map(block => block.type === "paragraph" ? paragraph(block) : block.type === "list" ?
		{ ...block, items: block.items.map(paragraph) } : block.type === "code" && !block.text ? { ...block, text: "\n" } : block) });
}
