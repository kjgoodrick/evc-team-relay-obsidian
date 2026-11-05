const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");

test("actual update settings exposes check/install, prevents double clicks, and keeps errors and restart instructions accessible", () => {
	const { dom, default: Component, mountComponent, flushSync } = loadSvelteComponent(path.resolve(__dirname, "../src/components/PluginUpdates.svelte"));
	const listeners = new Set();
	let state = { currentVersion: "0.2.5", automatic: true, busy: false, message: "Ready" };
	const set = patch => { state = { ...state, ...patch }; listeners.forEach(f => f(state)); flushSync(); };
	const updater = {
		subscribe(f) { listeners.add(f); f(state); return () => listeners.delete(f); },
		check: jest.fn(() => set({ release: { version: "0.2.6", url: "https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/tag/0.2.6" }, message: "Version 0.2.6 is available." })),
		install: jest.fn(() => set({ busy: true, message: "Downloading…" })),
		setAutomatic: jest.fn(automatic => set({ automatic })),
	};
	const target = dom.window.document.body;
	const component = mountComponent(Component, { target, props: { updater } });
	try {
		flushSync(); target.querySelector('button').click(); flushSync();
		expect(updater.check).toHaveBeenCalledTimes(1);
		const install = [...target.querySelectorAll('button')].find(b => b.textContent.includes('Update to'));
		install.click(); install.click(); expect(updater.install).toHaveBeenCalledTimes(1);
		expect([...target.querySelectorAll('button')].every(b => b.disabled)).toBe(true);
		set({ busy: false, error: "Checksum verification failed. Nothing was installed." });
		expect(target.querySelector('[role=alert]').textContent).toContain('Checksum');
		target.querySelector('input').click(); expect(updater.setAutomatic).toHaveBeenCalledWith(false);
		set({ installedVersion: "0.2.6", error: undefined, message: "Installed 0.2.6. Save your edits and restart Obsidian." });
		expect(target.querySelector('[role=status]').textContent).toContain('restart Obsidian');
		expect([...target.querySelectorAll('button')].some(b => b.textContent.includes('Update to'))).toBe(false);
		expect(target.querySelector('button').disabled).toBe(true);
	} finally { component.destroy(); dom.window.close(); }
	expect(listeners.size).toBe(0);
});
