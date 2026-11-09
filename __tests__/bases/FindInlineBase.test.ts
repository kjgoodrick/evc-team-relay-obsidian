import * as Y from "yjs";
import { findInlineBase } from "../../src/bases/FindInlineBase";

const block = '```base\nviews:\n  - type: table\n    name: Same\n```\n';
test("identical offscreen definitions are selected by fence proof and rebase after preceding edits", async () => {
	const doc = new Y.Doc(), text = doc.getText("content"); text.insert(0, block + '\n' + block);
	let calls = 0;
	const target = await findInlineBase(text, "second", async () => {
		if (++calls === 1) return { definition_id: "first" };
		text.insert(0, "Heading\n"); return { definition_id: "second" };
	}, () => true);
	expect(target?.from).toBe(block.length + 1 + "Heading\n".length);
	expect(text.toString().slice(target!.from, target!.to).trim()).toBe(block.trim());
	doc.destroy();
});
test.each(["cancel", "replace"])("a late %s prevents scrolling to a stale inline target", async action => {
	const doc = new Y.Doc(), text = doc.getText("content"); text.insert(0, block); let current = true;
	const result = await findInlineBase(text, "target", async () => {
		if (action === "cancel") current = false;
		else { text.delete(0, text.length); text.insert(0, block); }
		return { definition_id: "target" };
	}, () => current);
	expect(result).toBeUndefined(); doc.destroy();
});
