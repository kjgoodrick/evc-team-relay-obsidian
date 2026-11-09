import * as Y from "yjs";
import { toBase64 } from "lib0/buffer";
import { commentMarkdownParser } from "../collaboration/anchors/blocks";

export type InlineBaseSource = { from: number; to: number; headerTo: number; source: string };
export type InlineBaseSourceRequest = { dependency: string; start: string; end: string; selected_length: number };
export type InlineBaseAnchor = { anchor: Y.RelativePosition; head: Y.RelativePosition };

/** Keep identical inline definitions distinct by their opening fence's CRDT
 * identity. Body edits preserve that identity; deleting/replacing the opening
 * fence does not silently transfer discussions to a different block. */
export class InlineBaseAnchors {
	private snapshot?: { source: string; definitions: InlineBaseSource[] };
	private closed = false;
	private changed = () => { this.snapshot = undefined; };
	constructor(readonly text: Y.Text) { text.observe(this.changed); }
	get definitions(): readonly InlineBaseSource[] {
		if (this.closed) return [];
		if (!this.snapshot) {
			const source = this.text.toString();
			this.snapshot = { source, definitions: inlineBaseSources(source) };
		}
		return this.snapshot.definitions;
	}
	capture(definition: InlineBaseSource): InlineBaseAnchor | undefined {
		if (!this.text.doc || !this.definitions.some(item => item.from === definition.from && item.headerTo === definition.headerTo && item.source === definition.source)) return;
		return { anchor: Y.createRelativePositionFromTypeIndex(this.text, definition.from, 0),
			head: Y.createRelativePositionFromTypeIndex(this.text, definition.headerTo, -1) };
	}
	request(anchor: InlineBaseAnchor): InlineBaseSourceRequest | undefined {
		const definition = this.resolve(anchor); if (!definition || !this.text.doc) return;
		const dependency = Y.encodeSnapshot(Y.snapshot(this.text.doc));
		const start = Y.encodeRelativePosition(anchor.anchor), end = Y.encodeRelativePosition(anchor.head);
		const length = definition.headerTo - definition.from;
		if (dependency.length > 65_536 || start.length > 256 || end.length > 256 || length > 256) return;
		return { dependency: toBase64(dependency), start: toBase64(start), end: toBase64(end), selected_length: length };
	}
	resolve(anchor: InlineBaseAnchor): InlineBaseSource | undefined {
		if (this.closed || !this.text.doc) return;
		try {
			const start = Y.createAbsolutePositionFromRelativePosition(anchor.anchor, this.text.doc);
			const end = Y.createAbsolutePositionFromRelativePosition(anchor.head, this.text.doc);
			if (!start || !end || start.type !== this.text || end.type !== this.text || start.index >= end.index) return;
			return this.definitions.find(item => item.from === start.index && item.headerTo === end.index);
		} catch { return; }
	}
	close(): void { if (this.closed) return; this.closed = true; this.text.unobserve(this.changed); this.snapshot = undefined; }
}

/** Parse fenced definitions rather than searching for fence-looking strings
 * inside other code blocks. Lezer removes quote/list prefixes from CodeText. */
export function inlineBaseSources(source: string): InlineBaseSource[] {
	const result: InlineBaseSource[] = [];
	const frontmatter = /^(?:\uFEFF)?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(source);
	commentMarkdownParser.parse(source).iterate({ enter(ref) {
		if (frontmatter && ref.from < frontmatter[0].length && ref.name !== "Document") return false;
		if (ref.name !== "FencedCode") return;
		const node = ref.node, info = node.getChild("CodeInfo"), marks = node.getChildren("CodeMark");
		if (!info || source.slice(info.from, info.to).trim() !== "base" || marks.length !== 2) return false;
		const body = node.getChildren("CodeText").map(text => source.slice(text.from, text.to)).join("").replace(/\r\n/g, "\n");
		if (body.length <= 262_144) result.push({ from: marks[0].from, headerTo: info.to - (source.slice(info.from, info.to).match(/[ \t\r]+$/)?.[0].length ?? 0), to: node.to, source: body });
		return false;
	} });
	return result;
}
