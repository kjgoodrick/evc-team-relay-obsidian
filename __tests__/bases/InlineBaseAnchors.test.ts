import * as Y from "yjs";
import { InlineBaseAnchors, inlineBaseSources } from "../../src/bases/InlineBaseAnchors";
const block = '```base\nviews:\n  - type: table\n    name: Table\n```';
test("parses actual closed Base fences, including quoted definitions, without code-example or frontmatter matches", () => {
	const quoted = block.split('\n').map(line => '> '+line).join('\n');
	const found = inlineBaseSources('---\nexample: |\n  '+block.replace(/\n/g,'\n  ')+'\n---\n\n````md\n'+block+'\n````\n\n'+quoted+'\n\n```base\nunclosed');
	expect(found).toHaveLength(1); expect(found[0].source).toBe('views:\n  - type: table\n    name: Table');
});
test("duplicate definitions stay distinct through remote edits and body changes, without writing IDs into Markdown", () => {
	const doc = new Y.Doc(), text = doc.getText('contents'); text.insert(0, block+'\n\n'+block);
	const anchors = new InlineBaseAnchors(text), second = anchors.capture(anchors.definitions[1])!;
	const remote = new Y.Doc(); Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc)); remote.getText('contents').insert(0, '# Intro\n\n'); Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
	expect(anchors.resolve(second)?.from).toBe(anchors.definitions[1].from);
	const at = text.toString().lastIndexOf('Table'); text.delete(at, 5); text.insert(at, 'Renamed');
	expect(anchors.resolve(second)?.source).toContain('Renamed');
	const current = anchors.resolve(second)!; text.delete(current.from, current.to-current.from);
	expect(anchors.resolve(second)).toBeUndefined(); expect(anchors.definitions).toHaveLength(1);
	anchors.close(); remote.destroy(); doc.destroy();
});
test("replacing the opening fence cannot inherit the deleted definition", () => {
	const doc = new Y.Doc(), text = doc.getText('contents'); text.insert(0, block);
	const anchors = new InlineBaseAnchors(text), first = anchors.capture(anchors.definitions[0])!;
	text.delete(0, 7); text.insert(0, '```base');
	expect(anchors.definitions).toHaveLength(1); expect(anchors.resolve(first)).toBeUndefined();
	anchors.close(); doc.destroy();
});

test("wire requests retain fence identity but capture fresh snapshot dependencies", () => {
 const doc = new Y.Doc(), text = doc.getText('contents'); text.insert(0, block.replace('```base', '```base  '));
 const anchors = new InlineBaseAnchors(text), anchor = anchors.capture(anchors.definitions[0])!;
 const first = anchors.request(anchor)!; expect(first.selected_length).toBe(7);
 text.insert(text.length, '\nmore'); const next = anchors.request(anchor)!;
 expect(next.start).toBe(first.start); expect(next.end).toBe(first.end); expect(next.dependency).not.toBe(first.dependency);
 anchors.close(); expect(anchors.request(anchor)).toBeUndefined(); doc.destroy();
});
