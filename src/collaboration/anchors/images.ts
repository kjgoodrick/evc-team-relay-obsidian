import type * as Y from "yjs";
import { readingMarkdownParser } from "./readingSyntax";
import { captureTextAnchor, resolveTextAnchor } from "./text";
import { localTextAnchor, parseAnchor, wireTextAnchor, type ImageAnchor } from "../DiscussionProtocol";
import type { ImageAsset, ImageBasis, ImageGeometry } from "./imageGeometry";

export type ImageOccurrence = { from: number; to: number; destination: string; syntax: "wiki" | "markdown" };
const label = (value: string) => value.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();
function destination(value: string): string {
	const raw = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
	return raw.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, "$1").replace(/&(?:#\d{1,7}|#x[\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]{1,31});/g, entity => {
		const decoder = document.createElement("textarea"); decoder.innerHTML = entity; return decoder.value;
	});
}

/** Parse actual Markdown nodes, not a filename/URL search. Repeated destinations
 * retain separate ranges. Code, HTML, frontmatter and hidden comments cannot
 * accidentally become targets merely because they contain embed-like text. */
export function markdownImages(source: string): ImageOccurrence[] {
	const tree = readingMarkdownParser.parse(source), refs = new Map<string, string>(), images: ImageOccurrence[] = [];
	const hidden = [...source.matchAll(/%%[\s\S]*?(?:%%|$)/g)].map(match => ({ from: match.index!, to: match.index! + match[0].length }));
	const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(source);
	const excluded = (from: number, to: number) => from < (frontmatter?.[0].length ?? 0) || hidden.some(range => range.from < to && range.to > from);
	tree.iterate({ enter(node) {
		if (node.name === "LinkReference" && !excluded(node.from, node.to)) {
			const key = node.node.getChild("LinkLabel"), url = node.node.getChild("URL");
			if (key && url && !refs.has(label(source.slice(key.from, key.to)))) refs.set(label(source.slice(key.from, key.to)), destination(source.slice(url.from, url.to)));
		}
	} });
	tree.iterate({ enter(node) {
		if (node.from < (frontmatter?.[0].length ?? 0) && node.name !== "Document") return false;
		if (["Image", "ReadingWikiEmbed"].includes(node.name) && excluded(node.from, node.to)) return false;
		if (["InlineCode", "FencedCode", "CodeBlock", "HTMLBlock", "ReadingHiddenComment"].includes(node.name)) return false;
		let target: string | undefined, syntax: ImageOccurrence["syntax"] = "markdown";
		if (node.name === "ReadingWikiEmbed") { target = source.slice(node.from + 3, node.to - 2).split("|")[0].trim(); syntax = "wiki"; }
		else if (node.name === "Image") {
			const url = node.node.getChild("URL"), ref = node.node.getChild("LinkLabel");
			if (url) target = destination(source.slice(url.from, url.to));
			else if (ref) target = refs.get(label(source.slice(ref.from, ref.to)));
		}
		if (target && target.length <= 2048 && ![...target].some(char => char.charCodeAt(0) < 32)) images.push({ from: node.from, to: node.to, destination: target, syntax });
	} });
	return images.sort((a, b) => a.from - b.from);
}

export function captureImageAnchor(text: Y.Text, documentId: string, generation: string, image: ImageOccurrence,
	asset: ImageAsset, basis: ImageBasis, geometry: ImageGeometry): ImageAnchor {
	if (!markdownImages(text.toString()).some(item => item.from === image.from && item.to === image.to && item.destination === image.destination)) throw new Error("The image occurrence changed.");
	return parseAnchor({ version: 1, type: "image", occurrence: wireTextAnchor(captureTextAnchor(text, documentId, generation, image.from, image.to)), asset, basis, geometry }) as ImageAnchor;
}

export function resolveImageOccurrence(text: Y.Text, documentId: string, generation: string, anchor: ImageAnchor):
	{ status: "attached"; image: ImageOccurrence } | { status: "waiting_for_sync" | "generation_mismatch" | "unanchored" | "invalid" | "changed" } {
	const position = resolveTextAnchor(text, documentId, generation, localTextAnchor(anchor.occurrence));
	if (position.status !== "attached") return position;
	const image = markdownImages(text.toString()).find(item => item.from === position.from && item.to === position.to);
	return image ? { status: "attached", image } : { status: "changed" };
}

export function imageAssetChanged(before: ImageAsset, current: ImageAsset): boolean {
	return before.kind !== current.kind || (before.kind === "managed" && current.kind === "managed" ? before.entry_id !== current.entry_id || before.sha256 !== current.sha256 :
		before.kind === "external" && current.kind === "external" ? before.url !== current.url : true);
}
