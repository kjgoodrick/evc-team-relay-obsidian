// Deterministic Yjs v1 vectors consumed by both the plugin and Rust relay tests.
// Run with node; stdout is the JSON fixture. No vault or network access.
const Y = require("yjs");
const { buildSync } = require("esbuild");
const compiled = buildSync({ entryPoints: ["src/collaboration/anchors/text.ts"],
	bundle: true, packages: "external", platform: "node", format: "cjs", write: false });
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, loaded, loaded.exports);
const { captureTextAnchor, resolveTextAnchor } = loaded.exports;
const fixtures = [];
function document(source) {
	const doc = new Y.Doc(); doc.clientID = 42;
	doc.getText("contents").insert(0, source); return doc;
}
function record(name, doc, anchor) {
	const expected = resolveTextAnchor(doc.getText("contents"), "note", "generation", anchor);
	fixtures.push({ name, update: Array.from(Y.encodeStateAsUpdate(doc)),
		dependency: Array.from(Buffer.from(anchor.dependency, "base64")),
		start: Array.from(Buffer.from(anchor.start, "base64")),
		end: Array.from(Buffer.from(anchor.end, "base64")), selectedLength: anchor.selectedLength, expected });
}
const doc = document("alpha beta gamma"), text = doc.getText("contents");
const range = captureTextAnchor(text, "note", "generation", 6, 10);
record("original", doc, range);
text.insert(0, "NEW "); record("prefix", doc, range);
text.delete(10, 4); record("deleted", doc, range); doc.destroy();
const unicode = document("🙂 café e\u0301 العربية");
record("utf16", unicode, captureTextAnchor(unicode.getText("contents"), "note", "generation", 3, 7));
record("document-end", unicode, captureTextAnchor(unicode.getText("contents"), "note", "generation", 8, unicode.getText("contents").length));
unicode.destroy();
const deleted = document("alpha beta gamma"), stale = new Y.Doc();
Y.applyUpdate(stale, Y.encodeStateAsUpdate(deleted));
deleted.getText("contents").delete(0, 6);
const afterDelete = captureTextAnchor(deleted.getText("contents"), "note", "generation", 0, 4);
record("delete-only-dependency-missing", stale, afterDelete);
record("delete-only-dependency-applied", deleted, afterDelete);
deleted.getText("secret").insert(0, "secret");
record("wrong-shared-type", deleted, { ...afterDelete,
	start: Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(deleted.getText("secret"), 1))).toString("base64") });
deleted.destroy(); stale.destroy();
process.stdout.write(JSON.stringify({ version: 1, yjsVersion: require("yjs/package.json").version, fixtures }, null, 2) + "\n");
