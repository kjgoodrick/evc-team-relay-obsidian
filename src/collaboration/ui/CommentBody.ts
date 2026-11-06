import { safeDiscussionUrl, type InlineNode, type MessageBody, type TextNode } from "../DiscussionProtocol";

function textNode(parent: HTMLElement, node: TextNode): void {
	let target = parent;
	const tags = { bold: "strong", italic: "em", code: "code", strike: "s" } as const;
	for (const mark of node.marks ?? []) target = target.createEl(tags[mark]);
	target.appendText(node.text);
}
function inline(parent: HTMLElement, nodes: InlineNode[], name: (id: string) => string): void {
	for (const node of nodes) {
		if (node.type === "text") textNode(parent, node);
		else if (node.type === "mention") parent.createSpan({ cls: "relay-comment-mention", text: "@" + name(node.user_id) });
		else if (safeDiscussionUrl(node.url)) {
			const link = parent.createEl("a", { attr: { href: node.url, rel: "noopener noreferrer", target: "_blank" } });
			for (const child of node.children) textNode(link, child);
		}
	}
}

/** Render only supported nodes with textContent; server/comment text never becomes HTML. */
export function renderCommentBody(parent: HTMLElement, body: MessageBody | null, name: (id: string) => string): void {
	if (!body) { parent.createEl("p", { text: "Comment removed", cls: "relay-comment-muted" }); return; }
	for (const block of body.blocks) {
		if (block.type === "paragraph") inline(parent.createEl("p"), block.children, name);
		else if (block.type === "code") parent.createEl("pre").createEl("code", { text: block.text });
		else {
			const list = parent.createEl(block.ordered ? "ol" : "ul");
			for (const item of block.items) inline(list.createEl("li"), item.children, name);
		}
	}
}

/** Selectable recovery text includes link destinations and readable mention
 * labels. The original structured command stays intact in local storage.
 */
export function commentBodyText(body: MessageBody, name: (id: string) => string): string {
	const inlineText = (nodes: InlineNode[]): string => nodes.map(node => node.type === "text" ? node.text :
		node.type === "mention" ? "@" + name(node.user_id) : node.children.map(child => child.text).join("") + " (" + node.url + ")").join("");
	return body.blocks.map(block => block.type === "paragraph" ? inlineText(block.children) : block.type === "code" ? block.text :
		block.items.map((item, i) => (block.ordered ? `${i + 1}. ` : "- ") + inlineText(item.children)).join("\n")).join("\n\n");
}
