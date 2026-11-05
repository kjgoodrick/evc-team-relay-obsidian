const path = require("node:path");
const { loadSvelteComponent } = require("../scripts/test/svelteDOM.cjs");

test("the same person has the same stack and popover border in independent notes with older peer colors", () => {
	const { dom, default: Component, mountComponent, flushSync } = loadSvelteComponent(path.resolve(__dirname, "../src/components/CollaboratorAwareness.svelte"));
	const notes = ["#ff0000", "#0000ff"].map(color => {
		const listeners = new Set();
		const states = new Map([[1, { user: { id: "alice", name: "Alice", color } }], [2, { user: { id: "bob", name: "Bob", color } }]]);
		const awareness = { getStates: () => states, getLocalState: () => states.get(1), on: (_event, cb) => listeners.add(cb), off: (_event, cb) => listeners.delete(cb) };
		const target = dom.window.document.body.appendChild(dom.window.document.createElement("section"));
		return { target, states, listeners, component: mountComponent(Component, { target, props: { collabAwareness: awareness } }) };
	});
	const border = (note, name) => note.target.querySelector(`.evc-stacked-avatar[aria-label="${name}"] .evc-avatar-with-border`).style.borderColor;
	try {
		flushSync();
		const alice = border(notes[0], "Alice"), bob = border(notes[0], "Bob");
		expect(alice).toBeTruthy();
		expect(border(notes[1], "Alice")).toBe(alice);
		expect(border(notes[1], "Bob")).toBe(bob);
		notes[1].states.get(1).user = { id: "alice", name: "Renamed Alice", color: "#ffffff" };
		notes[1].listeners.forEach(cb => cb()); flushSync();
		expect(border(notes[1], "Renamed Alice")).toBe(alice);
		notes[1].target.querySelector(".evc-avatar-stack").click(); flushSync();
		expect(notes[1].target.querySelector(".evc-user-popover .evc-avatar-with-border").style.borderColor).toBe(alice);
	} finally { notes.forEach(note => note.component.destroy()); dom.window.close(); }
	expect(notes.every(note => note.listeners.size === 0)).toBe(true);
});

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
