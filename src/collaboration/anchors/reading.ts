import { commentMarkdownParser } from "./blocks";

type Syntax = ReturnType<typeof commentMarkdownParser.parse>["topNode"];
type Point = { node: Text; offset: number };
type Atom<T> = { char: string; start: T; end: T; verbatim: boolean };
type Projection = { kind: string; atoms: Atom<number>[] };
type Mapped = { source: Atom<number>[]; dom: Atom<Point>[] };
const LEAVES = "p,h1,h2,h3,h4,h5,h6,td,th,pre,li";
const EXCLUDED = "button,input,svg,script,style,img,.copy-code-button,.relay-reading-comment-controls";

/** HTML collapses ordinary whitespace, but code whitespace is meaningful. Keep
 * both endpoints of every collapsed run; never match by quote or fuzzy search. */
function normalize<T>(atoms: Atom<T>[]): Atom<T>[] {
	const result: Atom<T>[] = [];
	for (const atom of atoms) {
		if (!atom.verbatim && /^[ \t\r\n\f]$/.test(atom.char)) {
			const previous = result[result.length - 1];
			if (previous?.char === " " && !previous.verbatim) previous.end = atom.end;
			else result.push({ ...atom, char: " " });
		} else result.push({ ...atom });
	}
	while (result[0]?.char === " " && !result[0].verbatim) result.shift();
	while (result[result.length - 1]?.char === " " && !result[result.length - 1].verbatim) result.pop();
	return result;
}
function children(node: Syntax): Syntax[] {
	const result: Syntax[] = [];
	for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
	return result;
}
const label = (value: string) => value.replace(/^\[|\]$/g, "").trim().replace(/\s+/g, " ").toLowerCase();

/** Project only syntax with known source semantics. A final exact comparison
 * with the actual host render is still mandatory: this parser is not Obsidian's
 * renderer and reference links/third-party extensions can differ. */
function project(source: string, node: Syntax, refs: Set<string>, document: Document): Atom<number>[] | undefined {
	const atoms: Atom<number>[] = [];
	const raw = (from: number, to: number, verbatim = false) => {
		for (let index = from; index < to; index++) atoms.push({ char: source[index], start: index, end: index + 1, verbatim });
	};
	const replacement = (value: string, from: number, to: number, verbatim = false) => {
		for (let index = 0; index < value.length; index++) atoms.push({ char: value[index], start: from, end: to, verbatim });
	};
	const inline = (current: Syntax): boolean => {
		const parts = children(current), text = source.slice(current.from, current.to);
		if (["EmphasisMark", "HeaderMark", "QuoteMark", "TaskMarker", "StrikethroughMark"].includes(current.name)) return true;
		if (current.name === "Image") return true;
		if (current.name === "Escape") { replacement(text.slice(1), current.from, current.to); return true; }
		if (current.name === "HardBreak") { replacement("\n", current.from, current.to); return true; }
		if (current.name === "Entity") {
			if (!/^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);$/i.test(text)) return false;
			const decoder = document.createElement("textarea");
			// Only the validated single entity enters the HTML parser, never note HTML.
			decoder.innerHTML = text; replacement(decoder.value, current.from, current.to); return true;
		}
		if (current.name === "InlineCode") {
			const marks = parts.filter(part => part.name === "CodeMark");
			if (marks.length !== 2) return false;
			const from = marks[0].to, to = marks[1].from, first = atoms.length;
			for (let index = from; index < to; index++) {
				if (source[index] === "\r" && source[index + 1] === "\n") { replacement(" ", index, index + 2, true); index++; }
				else replacement(/[\r\n]/.test(source[index]) ? " " : source[index], index, index + 1, true);
			}
			if (atoms[first]?.char === " " && atoms[atoms.length - 1]?.char === " " && atoms.slice(first).some(atom => atom.char !== " ")) {
				atoms.pop(); atoms.splice(first, 1);
			}
			return true;
		}
		if (current.name === "Autolink") {
			const url = parts.find(part => part.name === "URL");
			if (!url) return false; raw(url.from, url.to); return true;
		}
		if (current.name === "Link") {
			const closing = parts.find(part => part.name === "LinkMark" && source.slice(part.from, part.to) === "]");
			if (!closing || text.startsWith("[[")) return false;
			const reference = parts.find(part => part.name === "LinkLabel");
			if (!parts.some(part => part.name === "URL") && !/\]\(/.test(text) &&
				!refs.has(label(reference ? source.slice(reference.from, reference.to) : source.slice(current.from, closing.to)))) return false;
			let cursor = current.from + 1;
			for (const part of parts) if (part.from >= cursor && part.to <= closing.from) {
				raw(cursor, part.from); if (!inline(part)) return false; cursor = part.to;
			}
			raw(cursor, closing.from); return true;
		}
		if (!["Paragraph", "Task", "TableCell", "Emphasis", "StrongEmphasis", "Strikethrough"].includes(current.name) &&
			!/^(ATX|Setext)Heading\d$/.test(current.name)) return false;
		let cursor = current.from;
		for (const part of parts) {
			raw(cursor, part.from); if (!inline(part)) return false; cursor = part.to;
		}
		raw(cursor, current.to); return true;
	};
	if (node.name === "FencedCode" || node.name === "CodeBlock") {
		const lines = children(node).filter(part => part.name === "CodeText");
		for (let index = 0; index < lines.length; index++) {
			if (index && atoms[atoms.length - 1]?.char !== "\n") replacement("\n", lines[index - 1].to, lines[index].from, true);
			const part = lines[index];
			for (let i = part.from; i < part.to; i++) {
				if (source[i] === "\r" && source[i + 1] === "\n") { replacement("\n", i, i + 2, true); i++; }
				else raw(i, i + 1, true);
			}
		}
		// Core Markdown renderers add a final newline to fenced/indented code.
		if (atoms.length && atoms[atoms.length - 1].char !== "\n") replacement("\n", lines[lines.length - 1].to, lines[lines.length - 1].to, true);
	} else if (!inline(node)) return undefined;
	return normalize(atoms);
}

export class ReadingSource {
	readonly tree: ReturnType<typeof commentMarkdownParser.parse>;
	readonly refs = new Set<string>();
	private lines = [0];
	constructor(readonly source: string) {
		for (let index = 0; index < source.length; index++) if (source[index] === "\n") this.lines.push(index + 1);
		this.tree = commentMarkdownParser.parse(source);
		this.tree.iterate({ enter: node => {
			if (node.name === "LinkReference") { const key = node.node.getChild("LinkLabel"); if (key) this.refs.add(label(source.slice(key.from, key.to))); return false; }
		} });
	}
	section(lineStart: number, lineEnd: number): { from: number; to: number } | undefined {
		if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || lineStart < 0 || lineEnd < lineStart || lineEnd >= this.lines.length) return undefined;
		const from = this.lines[lineStart], to = this.lines[lineEnd + 1] ?? this.source.length;
		return from < to ? { from, to } : undefined;
	}
}

function sourceLeaves(parsed: ReadingSource, from: number, to: number, document: Document): Projection[] | undefined {
	const { source, tree, refs } = parsed, leaves: Projection[] = [];
	let invalid = false;
	tree.iterate({ from, to, enter(node) {
		if (node.from < from || node.to > to) return;
		if (["HTMLBlock", "ProcessingInstruction", "Comment"].includes(node.name)) { invalid = true; return false; }
		const kind = /^(ATX|Setext)Heading\d$/.test(node.name) ? "h" + node.name.slice(-1) :
			["Paragraph", "Task"].includes(node.name) ? "text" : node.name === "TableCell" ? "cell" :
			["CodeBlock", "FencedCode"].includes(node.name) ? "code" : undefined;
		if (!kind) return;
		const atoms = project(source, node.node, refs, document);
		if (!atoms) invalid = true; else leaves.push({ kind, atoms });
		return false;
	} });
	return invalid ? undefined : leaves;
}

function domAtoms(root: Element): Atom<Point>[] {
	const result: Atom<Point>[] = [];
	const visit = (node: Node, verbatim: boolean) => {
		if (node.nodeType === 3) {
			const text = node as Text;
			for (let offset = 0; offset < text.length; offset++) result.push({ char: text.data[offset], start: { node: text, offset }, end: { node: text, offset: offset + 1 }, verbatim });
		} else if (node.nodeType === 1) {
			const element = node as Element;
			if (element !== root && element.matches(EXCLUDED + ",ul,ol,blockquote")) return;
			if (element.tagName === "BR") {
				// The surrounding text nodes map the selection across a line break;
				// a range containing only the BR has no exact text target.
				const previous = result[result.length - 1];
				if (previous) result.push({ ...previous, char: "\n", start: previous.end });
				return;
			}
			for (const child of Array.from(node.childNodes)) visit(child, verbatim || element.matches("pre,code"));
		}
	};
	visit(root, false); return normalize(result);
}

export class ReadingSectionMap {
	private text = new Map<Text, string>();
	private coverage = new Map<Text, { from: number; to: number }[]>();
	constructor(readonly root: HTMLElement, private source: string, private leaves: Mapped[], private from = 0, private to = source.length) {
		for (const leaf of leaves) for (const atom of leaf.dom) {
			for (const point of [atom.start, atom.end]) this.text.set(point.node, point.node.data);
			const add = (node: Text, from: number, to: number) => {
				const ranges = this.coverage.get(node) ?? [], last = ranges[ranges.length - 1];
				if (last && last.to >= from) last.to = Math.max(last.to, to); else ranges.push({ from, to });
				this.coverage.set(node, ranges);
			};
			if (atom.start.node === atom.end.node) add(atom.start.node, atom.start.offset, atom.end.offset);
			else { add(atom.start.node, atom.start.offset, atom.start.node.length); add(atom.end.node, 0, atom.end.offset); }
		}
	}
	private get document(): Document { return this.root.ownerDocument; }
	isCurrent(): boolean { return [...this.text].every(([node, value]) => this.root.contains(node) && node.data === value); }
	/** Only combine verified, nonoverlapping sections from the same source. */
	static combine(root: HTMLElement, maps: ReadingSectionMap[]): ReadingSectionMap | undefined {
		if (!maps.length || maps.some(map => map.source !== maps[0].source || !root.contains(map.root) || !map.isCurrent())) return undefined;
		maps = [...maps].sort((a, b) => a.from - b.from);
		for (let index = 1; index < maps.length; index++) {
			const previous = maps[index - 1], next = maps[index];
			if (previous.to > next.from || previous.source.slice(previous.to, next.from).trim() ||
				previous.root.contains(next.root) || !(previous.root.compareDocumentPosition(next.root) & 4)) return undefined;
		}
		return new ReadingSectionMap(root, maps[0].source, maps.flatMap(map => map.leaves), maps[0].from, maps[maps.length - 1].to);
	}
	/** A native selection can cross formatting nodes, table cells or blocks.
	 * Source positions are recovered from ordered exact matches, not occurrences. */
	sourceRange(selection: Range): { from: number; to: number } | undefined {
		if (selection.collapsed || !this.root.contains(selection.startContainer) || !this.root.contains(selection.endContainer) || !this.isCurrent()) return undefined;
		if ([selection.startContainer, selection.endContainer].some(node => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest(".relay-reading-comment-controls"))) return undefined;
		// Refuse selections containing any unmapped visible characters (including
		// plugin output or controls), rather than silently clamping their ends.
		const walker = this.document.createTreeWalker(selection.commonAncestorContainer, 4);
		let next: Node | null = selection.commonAncestorContainer.nodeType === 3 ? selection.commonAncestorContainer : walker.nextNode();
		while (next) {
			const node = next as Text;
			if (!node.parentElement?.closest(".relay-reading-comment-controls") && selection.intersectsNode(node)) {
				const from = node === selection.startContainer ? selection.startOffset : 0;
				const to = node === selection.endContainer ? selection.endOffset : node.length;
				const spans = this.coverage.get(node) ?? [];
				for (let index = from; index < to; index++) if (!/\s/.test(node.data[index]) && !spans.some(span => span.from <= index && span.to > index)) return undefined;
			}
			next = walker.nextNode();
		}
		const start = selection.cloneRange(), end = selection.cloneRange(), probe = this.document.createRange();
		start.collapse(true); end.collapse(false);
		const compare = (point: Point, boundary: Range) => { probe.setStart(point.node, point.offset); probe.collapse(true); return probe.compareBoundaryPoints(0, boundary); };
		let from: number | undefined, to: number | undefined;
		for (const leaf of this.leaves) {
			let low = 0, high = leaf.dom.length;
			while (low < high) { const mid = (low + high) >>> 1; if (compare(leaf.dom[mid].end, start) <= 0) low = mid + 1; else high = mid; }
			const first = low; high = leaf.dom.length;
			while (low < high) { const mid = (low + high) >>> 1; if (compare(leaf.dom[mid].start, end) < 0) low = mid + 1; else high = mid; }
			const last = low - 1;
			if (first > last) continue;
			// A character entity may expand into multiple code units. Never map a
			// partial expansion to the entire source entity without telling users.
			const sameExpansion = (a: Atom<number>, b: Atom<number>) => a.start === b.start && a.end === b.end;
			if (first > 0 && sameExpansion(leaf.source[first], leaf.source[first - 1]) ||
				last + 1 < leaf.source.length && sameExpansion(leaf.source[last], leaf.source[last + 1])) return undefined;
			from ??= leaf.source[first].start; to = leaf.source[last].end;
		}
		const splitSurrogate = (index: number) => /[\uD800-\uDBFF]/.test(this.source[index - 1] ?? "") && /[\uDC00-\uDFFF]/.test(this.source[index] ?? "");
		return from !== undefined && to !== undefined && to > from && !splitSurrogate(from) && !splitSurrogate(to) ? { from, to } : undefined;
	}
	domRanges(from: number, to: number): Range[] {
		const result: Range[] = [];
		if (!this.isCurrent()) return result;
		for (const leaf of this.leaves) {
			const first = leaf.source.findIndex(atom => atom.end > from && atom.start < to);
			if (first < 0) continue;
			let last = first; while (last + 1 < leaf.source.length && leaf.source[last + 1].start < to) last++;
			const range = this.document.createRange(); range.setStart(leaf.dom[first].start.node, leaf.dom[first].start.offset);
			range.setEnd(leaf.dom[last].end.node, leaf.dom[last].end.offset); result.push(range);
		}
		return result;
	}
}

/** Returns no map when source and render disagree. Callers must then offer a
 * block target or opening Source mode, and must recheck source equality at use. */
export function mapReadingSection(root: HTMLElement, source: string, from: number, to: number, parsed?: ReadingSource): ReadingSectionMap | undefined {
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to > source.length || to <= from || to - from > 65536) return undefined;
	parsed ??= new ReadingSource(source);
	if (parsed.source !== source) return undefined;
	const projections = sourceLeaves(parsed, from, to, root.ownerDocument); if (!projections) return undefined;
	const candidates = [...(root.matches(LEAVES) ? [root] : []), ...Array.from(root.querySelectorAll(LEAVES))]
		.filter(element => !(element.tagName === "LI" && Array.from(element.children).some(child => child.matches("p,blockquote,pre"))) &&
			!element.closest(".internal-embed,.footnotes,.relay-reading-comment-controls"));
	if (candidates.length !== projections.length) return undefined;
	const leaves: Mapped[] = [];
	for (let index = 0; index < projections.length; index++) {
		const element = candidates[index], projection = projections[index];
		const kind = element.tagName === "PRE" ? "code" : /^(TD|TH)$/.test(element.tagName) ? "cell" : /^(P|LI)$/.test(element.tagName) ? "text" : element.tagName.toLowerCase();
		const dom = domAtoms(element);
		if (kind !== projection.kind || dom.map(atom => atom.char).join("") !== projection.atoms.map(atom => atom.char).join("")) return undefined;
		leaves.push({ source: projection.atoms, dom });
	}
	return new ReadingSectionMap(root, source, leaves, from, to);
}
