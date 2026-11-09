/** @jest-environment jsdom */
import { EmbeddedBaseFocus } from "../../src/bases/EmbeddedBaseFocus";
function fixture() {
	const parent = { contentEl: document.body.appendChild(document.createElement("div")) };
	const view = { contentEl: parent.contentEl.appendChild(document.createElement("div")) };
	const other = { contentEl: parent.contentEl.appendChild(document.createElement("div")) };
	const changed = jest.fn(); const focus = new EmbeddedBaseFocus(changed); let allowed = true;
	focus.set([{ parent, view, current: () => allowed }, { parent, view: other, current: () => allowed }]);
	return { parent, view, other, changed, focus, revoke: () => { allowed = false; } };
}
const click = (el: HTMLElement, type = "pointerdown") => el.dispatchEvent(new Event(type, { bubbles: true }));
afterEach(() => document.body.replaceChildren());
test("interaction picks the exact embed, sidebar retains it, and note interaction restores note presence", () => {
	const f = fixture();
	try {
		expect(f.focus.active(f.parent)).toBeUndefined();
		click(f.view.contentEl); expect(f.focus.active(f.parent)).toBe(f.view);
		click(document.body); expect(f.focus.active(f.parent)).toBe(f.view);
		click(f.other.contentEl, "focusin"); expect(f.focus.active(f.parent)).toBe(f.other);
		click(f.parent.contentEl); expect(f.focus.active(f.parent)).toBeUndefined();
		expect(f.changed).toHaveBeenCalledTimes(3);
	} finally { f.focus.close(); }
});
test("navigation, access loss, and removed embeds clear selection; closing removes listeners", () => {
	const f = fixture();
	click(f.view.contentEl); expect(f.focus.active(f.other)).toBeUndefined();
	click(f.view.contentEl); f.revoke(); expect(f.focus.active(f.parent)).toBeUndefined();
	f.focus.set([]); click(f.view.contentEl); expect(f.focus.active(f.parent)).toBeUndefined();
	f.focus.close(); const calls = f.changed.mock.calls.length; click(f.other.contentEl); expect(f.changed).toHaveBeenCalledTimes(calls);
});


test("verified navigation selects the requested embed without cancelling Follow as user interaction", () => {
	const f = fixture();
	try {
		expect(f.focus.select(f.parent, f.other)).toBe(true);
		expect(f.focus.active(f.parent)).toBe(f.other);
		expect(f.changed).not.toHaveBeenCalled();
		expect(f.focus.select(f.other, f.view)).toBe(false);
		f.revoke(); expect(f.focus.select(f.parent, f.view)).toBe(false);
	} finally { f.focus.close(); }
});
