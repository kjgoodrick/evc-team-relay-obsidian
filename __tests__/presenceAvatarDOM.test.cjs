const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");

test("actual presence components render pictures, recover from load failure and refresh without remounting", () => {
	const { dom, default: Component, mountComponent, flushSync } = loadSvelteComponent(path.resolve(__dirname, "../src/components/CollaboratorAwareness.svelte"));
	const listeners = new Set();
	const states = new Map([[1, { user: { id: "alice", name: "Alice", avatarUrl: "https://id.example/a.png" } }], [2, { user: { id: "bob", name: "Bob" } }]]);
	const awareness = { getStates: () => states, getLocalState: () => states.get(1), on: (_event, cb) => listeners.add(cb), off: (_event, cb) => listeners.delete(cb) };
	const target = dom.window.document.body;
	const component = mountComponent(Component, { target, props: { collabAwareness: awareness } });
	try {
		flushSync();
		let image = target.querySelector("img");
		expect(image.src).toBe("https://id.example/a.png");
		expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
		image.dispatchEvent(new dom.window.Event("load")); flushSync();
		expect(image.classList.contains("evc-picture-loaded")).toBe(true);
		expect(target.querySelectorAll(".evc-user-initial")).toHaveLength(2);
		image.dispatchEvent(new dom.window.Event("error")); flushSync();
		expect(target.querySelector("img")).toBeNull();
		expect(target.textContent).toContain("A");
		states.get(1).user.avatarUrl = "https://id.example/updated.png";
		listeners.forEach(cb => cb()); flushSync();
		expect(target.querySelector("img").src).toBe("https://id.example/updated.png");
		target.querySelector(".evc-avatar-stack").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); flushSync();
		expect(target.querySelector(".evc-user-popover img").src).toBe("https://id.example/updated.png");
		expect(target.textContent).toContain("Alice (You)");
		states.get(1).user.avatarUrl = "file:///private/picture.png";
		listeners.forEach(cb => cb()); flushSync();
		expect(target.querySelector("img")).toBeNull();
	} finally { component.destroy(); dom.window.close(); }
	expect(listeners.size).toBe(0);
});
