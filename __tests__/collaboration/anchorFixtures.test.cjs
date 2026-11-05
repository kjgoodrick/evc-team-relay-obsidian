const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("checked-in cross-language vectors match the current anchor implementation", () => {
	const root = path.resolve(__dirname, "../..");
	const generated = execFileSync(process.execPath, ["scripts/test/anchor-fixtures.cjs"], { cwd: root, encoding: "utf8" });
	const saved = fs.readFileSync(path.join(__dirname, "fixtures/yjs-text-anchors-v1.json"), "utf8");
	expect(generated).toBe(saved);
});
