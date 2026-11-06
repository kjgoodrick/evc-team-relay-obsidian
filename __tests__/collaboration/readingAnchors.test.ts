/** @jest-environment jsdom */
import { mapReadingSection, ReadingSectionMap, ReadingSource } from "../../src/collaboration/anchors/reading";

function fixture(source: string, html: string) {
	const root = document.createElement("div"); root.innerHTML = html; document.body.append(root);
	const map = mapReadingSection(root, source, 0, source.length);
	expect(map).toBeDefined();
	return { root, map: map! };
}
function range(node: Node, from = 0, to = node.textContent!.length) {
	const value = document.createRange(); value.setStart(node, from); value.setEnd(node, to); return value;
}
afterEach(() => document.body.replaceChildren());

test("Reading selections use ordered source positions through emphasis, links, escapes and entities", () => {
	const source = "# Heading #\n\nrepeat **repeat** [label](https://example.test) \\* &amp; end";
	const { root, map } = fixture(source, '<h1>Heading</h1><p>repeat <strong>repeat</strong> <a href="https://example.test">label</a> * &amp; end</p>');
	const selected = range(root.querySelector("strong")!.firstChild!);
	expect(map.sourceRange(selected)).toEqual({ from: source.indexOf("**repeat") + 2, to: source.indexOf("**repeat") + 8 });
	expect(map.domRanges(source.indexOf("**repeat") + 2, source.indexOf("**repeat") + 8).map(value => value.toString())).toEqual(["repeat"]);
	const label = range(root.querySelector("a")!.firstChild!);
	expect(map.sourceRange(label)).toEqual({ from: source.indexOf("label"), to: source.indexOf("label") + 5 });
	const tail = root.querySelector("p")!.lastChild!;
	expect(map.sourceRange(range(tail, 1, 2))).toEqual({ from: source.indexOf("\\*"), to: source.indexOf("\\*") + 2 });
	expect(map.sourceRange(range(tail, 3, 4))).toEqual({ from: source.indexOf("&amp;"), to: source.indexOf("&amp;") + 5 });
	selected.setStart(root.querySelector("h1")!.firstChild!, 0); selected.setEnd(tail, tail.textContent!.length);
	expect(map.sourceRange(selected)).toEqual({ from: 2, to: source.length });
});

test("code preserves meaningful whitespace, normalizes CRLF and trims whole newline atoms in inline code", () => {
	for (const [source, html, selected, expected] of [
		["``\r\n x \r\n``", "<p><code> x </code></p>", " x ", " x "],
		["```js\r\n  x\r\n y\r\n```", "<pre><code>  x\ny\n</code></pre>", "", ""],
		["    x\n    y", "<pre><code>x\ny\n</code></pre>", "y", "y"],
	] as const) {
		if (!selected) { // Incorrect indentation must not be accepted as an exact rendering.
			const root = document.createElement("div"); root.innerHTML = html;
			expect(mapReadingSection(root, source, 0, source.length)).toBeUndefined(); continue;
		}
		const { root, map } = fixture(source, html), text = root.querySelector("code")!.firstChild!;
		const from = text.textContent!.indexOf(selected), result = map.sourceRange(range(text, from, from + selected.length));
		expect(source.slice(result!.from, result!.to)).toBe(expected);
	}
	const source = "```js\r\n  x\r\n y\r\n```", { root, map } = fixture(source, "<pre><code>  x\n y\n</code></pre>");
	expect(map.sourceRange(range(root.querySelector("code")!.firstChild!, 2, 6))).toEqual({ from: source.indexOf("x"), to: source.indexOf("y") + 1 });
});

test("tables, nested lists, checkboxes and blockquotes map across separate rendered leaves", () => {
	const source = "- [x] first\n  - nested\n- last\n\n> quote\n> continued\n\n| a | b |\n|---|---|\n| c | d |";
	const { root, map } = fixture(source, '<ul><li><input type="checkbox" checked> first<ul><li>nested</li></ul></li><li>last</li></ul><blockquote><p>quote\ncontinued</p></blockquote><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table>');
	const cells = root.querySelectorAll("td"), selected = range(cells[0].firstChild!); selected.setEnd(cells[1].firstChild!, 1);
	expect(map.sourceRange(selected)).toEqual({ from: source.indexOf("c |"), to: source.lastIndexOf("d") + 1 });
	expect(map.domRanges(source.indexOf("nested"), source.indexOf("nested") + 6).map(value => value.toString())).toEqual(["nested"]);
});

test("reference links use whole-document definitions and preserve the selected label", () => {
	const source = "[**label**][ID]\n\n[id]: https://example.test", root = document.createElement("p");
	root.innerHTML = '<a href="https://example.test"><strong>label</strong></a>';
	const map = mapReadingSection(root, source, 0, source.indexOf("\n"), new ReadingSource(source));
	expect(map?.sourceRange(range(root.querySelector("strong")!.firstChild!))).toEqual({ from: 3, to: 8 });
});

test("unverified content, outside endpoints, stale text, HTML and partial Unicode entities are rejected", () => {
	const { root, map } = fixture("safe 🙂 &NotEqualTilde;", "<p>safe 🙂 &NotEqualTilde;</p>"), text = root.firstChild!.firstChild!;
	expect(map.sourceRange(range(text, 5, 6))).toBeUndefined();
	expect(map.sourceRange(range(text, 5, 7))).toEqual({ from: 5, to: 7 });
	expect(map.sourceRange(range(text, 8, 9))).toBeUndefined();
	expect(map.sourceRange(range(text, 8, 10))).toEqual({ from: 8, to: "safe 🙂 &NotEqualTilde;".length });
	const outside = document.createTextNode("outside"); document.body.append(outside);
	const selected = range(text, 0, 4); selected.setEnd(outside, 7); expect(map.sourceRange(selected)).toBeUndefined();
	const extra = document.createElement("span"); extra.textContent = "unmapped"; root.append(extra);
	selected.setEnd(extra.firstChild!, 8); expect(map.sourceRange(selected)).toBeUndefined();
	(text as Text).data = "changed"; expect(map.domRanges(0, 4)).toEqual([]);
	const html = document.createElement("div"); html.innerHTML = "<p>safe</p><div>HTML</div>";
	expect(mapReadingSection(html, "safe\n\n<div>HTML</div>", 0, 21)).toBeUndefined();
});

test("cross-section selection refuses missing source sections or reversed DOM order", () => {
	const source = "one\n\ntwo", root = document.createElement("div"); root.innerHTML = "<p>one</p><p>two</p>"; document.body.append(root);
	const [first, second] = Array.from(root.children) as HTMLElement[];
	const maps = [mapReadingSection(first, source, 0, 3)!, mapReadingSection(second, source, 5, 8)!];
	const selected = range(first.firstChild!); selected.setEnd(second.firstChild!, 3);
	expect(ReadingSectionMap.combine(root, maps)?.sourceRange(selected)).toEqual({ from: 0, to: 8 });
	root.prepend(second); expect(ReadingSectionMap.combine(root, maps)).toBeUndefined(); root.prepend(first);
	const hidden = "one\n\nhidden\n\ntwo";
	expect(ReadingSectionMap.combine(root, [mapReadingSection(first, hidden, 0, 3)!, mapReadingSection(second, hidden, 13, 16)!])).toBeUndefined();
});
