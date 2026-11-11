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
		expect(target.querySelectorAll(".evc-user-initial")).toHaveLength(1);
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

test("note rebinding retains the loaded self image, removes old peers and unsubscribes the old awareness", () => {
 const { dom, default: Component, mountComponent, flushSync } = loadSvelteComponent(path.resolve(__dirname, "../src/components/CollaboratorAwareness.svelte"));
 const self = { id: "alice", name: "Alice", avatarUrl: "https://id.example/a.png" };
 const make = entries => { const states = new Map(entries), listeners = new Set(); return { states, listeners, getStates: () => states, getLocalState: () => states.get(1), on: (_, cb) => listeners.add(cb), off: (_, cb) => listeners.delete(cb) }; };
 const old = make([[1, { user: self }], [2, { user: { id: "bob", name: "Bob" } }]]), next = make([]);
 const target = dom.window.document.body, component = mountComponent(Component, { target, props: { collabAwareness: old, fallbackSelf: undefined } });
 try {
  const image = target.querySelector("img"); image.dispatchEvent(new dom.window.Event("load")); flushSync();
  component.update({ collabAwareness: next, fallbackSelf: self }); flushSync();
  expect(target.querySelector("img")).toBe(image);
  expect(image.classList.contains("evc-picture-loaded")).toBe(true);
  expect(target.querySelector('[aria-label="Bob"]')).toBeNull();
  expect(old.listeners.size).toBe(0); expect(next.listeners.size).toBe(1);
  next.states.set(1, { user: self }); next.listeners.forEach(cb => cb());
  flushSync();
  next.states.delete(1); next.listeners.forEach(cb => cb()); flushSync();
  expect(target.querySelector("img")).toBe(image);
  expect(target.querySelector(".evc-user-initial")).toBeNull();
  component.update({ authorized: false, fallbackSelf: undefined }); flushSync();
  expect(target.querySelector(".evc-avatar-stack")).toBeNull();
 } finally { component.destroy(); dom.window.close(); }
 expect(next.listeners.size).toBe(0);
});
