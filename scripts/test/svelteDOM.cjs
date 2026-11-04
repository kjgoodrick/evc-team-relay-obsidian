const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const { JSDOM } = require("jsdom");

// Run native imports outside Jest's CJS VM: svelte-preprocess loads its
// processors dynamically. The compiler and preprocess match production.
// src/svelteMount.ts is bundled alongside, so it drives the same Svelte
// runtime instance as the component.
/**
 * The VM exports the compiled component and the runtime re-exports below.
 * @returns {{ dom: import("jsdom").JSDOM, default: import("svelte").Component<any>, flushSync: typeof import("svelte").flushSync, mount: typeof import("svelte").mount, mountComponent: typeof import("../../src/svelteMount").mountComponent }}
 */
function loadSvelteComponent(filename, dependencies = {}) {
	const root = path.resolve(__dirname, "../..");
	const bundle = execFileSync(process.execPath, ["--input-type=module", "-e", `
		import fs from "node:fs";
		import path from "node:path";
		import { compile, preprocess } from "svelte/compiler";
		import { build } from "esbuild";
		import esbuildSvelte from "esbuild-svelte";
		import config from "./svelte.config.mjs";
		const filename = process.argv[1];
		const options = { ...config.compilerOptions };
		const processed = await preprocess(fs.readFileSync(filename, "utf8"), config.preprocess, { filename });
		const compiled = compile(processed.code, { ...options, filename, dev: true });
		const bundle = await build({
			stdin: {
				contents: compiled.js.code + '\\nexport { flushSync, mount } from "svelte";' +
					'\\nexport { mountComponent } from ' + JSON.stringify(path.resolve("src/svelteMount.ts")) + ';',
				resolveDir: path.dirname(filename), sourcefile: filename,
			},
			bundle: true, platform: "browser", format: "cjs", write: false,
			plugins: [esbuildSvelte(config)],
			external: JSON.parse(process.argv[2]),
		});
		process.stdout.write(bundle.outputFiles[0].text);
	`, filename, JSON.stringify(Object.keys(dependencies))], {
		cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 10 * 1024 * 1024,
	});
	const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://ui.example.test" });
	// Svelte captures DOM constructors at module initialization. Use an isolated
	// browser realm instead of replacing Node globals or supplying just document.
	const sandbox = { module: { exports: {} }, console, require(id) {
		if (!(id in dependencies)) throw new Error(`Unexpected dependency: ${id}`);
		return dependencies[id];
	} };
	for (const key of Object.getOwnPropertyNames(dom.window)) {
		try { sandbox[key] = dom.window[key]; } catch { /* unavailable browser storage */ }
	}
	sandbox.activeDocument = dom.window.document;
	sandbox.exports = sandbox.module.exports;
	try {
		vm.runInNewContext(bundle, sandbox, { filename: "compiled-component.cjs" });
		return { dom, ...sandbox.module.exports };
	} catch (error) {
		dom.window.close();
		throw error;
	}
}

module.exports = { loadSvelteComponent };
