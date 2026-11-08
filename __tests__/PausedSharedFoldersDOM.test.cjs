const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");

test("paused folder settings show retained work, serialize retry, expose failures and clear completed entries", async () => {
	const { dom, default: Component, mountComponent, flushSync } = loadSvelteComponent(path.resolve(__dirname, "../src/components/PausedSharedFolders.svelte"));
	const listeners = new Set(), target = dom.window.document.body;
	const registry = { startupFailures: [{ guid: "fixture", path: "", message: "Recovery needs review" }], on(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
	let fail;
	const live = { shareRegistry: registry, retrySharedFolderStartup: jest.fn(() => new Promise((_resolve, reject) => { fail = reject; })) };
	const component = mountComponent(Component, { target, props: { live } });
	try {
		flushSync(); expect(target.textContent).toContain("cached history are retained"); expect(target.textContent).toContain("Vault root");
		const button = target.querySelector("button"); button.click(); button.click(); flushSync();
		expect(live.retrySharedFolderStartup).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
		fail(new Error("Journal is still unavailable")); await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
		expect(target.querySelector('[role="status"]').textContent).toContain("still unavailable"); expect(button.disabled).toBe(false);
		live.retrySharedFolderStartup.mockImplementationOnce(async () => { registry.startupFailures = []; listeners.forEach(fn => fn()); });
		button.click(); await new Promise(resolve => setTimeout(resolve, 0)); flushSync();
		expect(target.querySelector("section")).toBeNull();
	} finally { component.destroy(); dom.window.close(); }
	expect(listeners.size).toBe(0);
});
