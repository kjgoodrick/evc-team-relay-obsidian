/** @jest-environment jsdom */
/* eslint-disable obsidianmd/no-static-styles-assignment -- Fixtures simulate native crop, scroll and transform styles; these are not product UI styles. */
import { ImagePresenceMotion } from "../../src/collaboration/presence/ImagePresenceMotion";
import type { SurfacePresencePeer } from "../../src/collaboration/presence/PresencePeers";

function box(element: HTMLElement, width: number, height: number, left = 0, top = 0) {
	Object.defineProperties(element, { offsetWidth: { value: width, configurable: true }, offsetHeight: { value: height, configurable: true }, clientWidth: { value: width, configurable: true }, clientHeight: { value: height, configurable: true } });
	element.getBoundingClientRect = () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) });
}
function fixture() {
	const root = document.body.appendChild(document.createElement("div")), image = root.appendChild(document.createElement("img"));
	box(root, 200, 200); box(image, 200, 200); image.style.objectFit = "contain";
	Object.defineProperties(image, { complete: { value: true }, naturalWidth: { value: 800 }, naturalHeight: { value: 400 } });
	image.scrollIntoView = jest.fn();
	const publish = jest.fn(), options = { current: () => true, publishing: () => true, publish };
	const motion = new ImagePresenceMotion(root, image, options), layer = root.querySelector<HTMLDivElement>(".relay-image-presence")!; box(layer, 200, 200);
	const peer: SurfacePresencePeer = { key: "peer", userId: "member", sessionId: "session", instanceId: "instance", name: "<img src=x>", surface: "image", location: { kind: "image", share_id: "share", entry_id: "entry", generation: "generation", content_sha256: "a".repeat(64) }, imageState: { pointer: { x: 0.25, y: 0.5 }, viewport: null } };
	return { root, image, layer, options, motion, publish, peer, close: () => { motion.close(); root.remove(); } };
}
const settle = () => jest.advanceTimersByTimeAsync(150);
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("maps native letterboxing, pointer departure and coalesced movement without reading bytes", async () => {
	const f = fixture();
	try {
		expect(f.publish).toHaveBeenLastCalledWith({ pointer: null, viewport: { x: 0, y: 0, width: 1, height: 1 } });
		for (let x = 0; x <= 100; x++) f.image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: 100 }));
		expect(f.publish).toHaveBeenCalledTimes(1); await settle();
		expect(f.publish).toHaveBeenLastCalledWith({ pointer: { x: 0.5, y: 0.5 }, viewport: { x: 0, y: 0, width: 1, height: 1 } });
		f.image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 20 })); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		f.image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 })); await settle();
		f.root.dispatchEvent(new Event("pointerleave")); expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
		f.image.dispatchEvent(Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }), { pointerType: "touch" })); await settle();
		expect(f.publish.mock.calls.at(-1)![0].pointer).toEqual({ x: 0.5, y: 0.5 });
		f.image.dispatchEvent(Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerType: "touch" }));
		expect(f.publish.mock.calls.at(-1)![0].pointer).toBeNull();
	} finally { f.close(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("clips pointers to the actual crop, renders identity as text, and preserves observation while hidden", async () => {
	const f = fixture();
	try {
		f.image.style.objectFit = "cover"; f.image.style.objectPosition = "100% 0%";
		f.motion.setPeers([f.peer]); await settle(); expect(f.layer.querySelectorAll(".relay-image-presence-pointer")).toHaveLength(0);
		const peer = { ...f.peer, imageState: { pointer: { x: 0.75, y: 0.5 }, viewport: null } };
		f.motion.setPeers([peer]); await settle();
		const marker = f.layer.querySelector<HTMLElement>(".relay-image-presence-pointer")!;
		expect(marker.style.left).toBe("100px"); expect(marker.style.top).toBe("100px"); expect(marker.textContent).toBe("<img src=x>"); expect(f.layer.querySelector("img")).toBeNull();
		f.image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 })); await settle();
		expect(f.publish).toHaveBeenLastCalledWith({ pointer: { x: 0.75, y: 0.5 }, viewport: { x: 0.5, y: 0, width: 0.5, height: 1 } });
		f.options.publishing = () => false; f.motion.refresh(); await settle(); expect(f.publish).toHaveBeenLastCalledWith(null);
		expect(f.layer.querySelector(".relay-image-presence-pointer")).toBe(marker);
		f.motion.setPeers([]); await settle(); expect(f.layer.children).toHaveLength(0);
	} finally { f.close(); }
});

test("Jump uses the pointer and Follow uses viewport center without changing zoom", async () => {
	const f = fixture();
	try {
		box(f.root, 200, 100); box(f.image, 800, 400); f.root.style.overflowX = "auto"; f.root.style.overflowY = "auto"; f.image.style.objectFit = "fill";
		Object.defineProperties(f.root, { scrollWidth: { value: 800 }, scrollHeight: { value: 400 } });
		f.image.getBoundingClientRect = () => ({ left: -f.root.scrollLeft, top: -f.root.scrollTop, right: 800 - f.root.scrollLeft, bottom: 400 - f.root.scrollTop, width: 800, height: 400, x: -f.root.scrollLeft, y: -f.root.scrollTop, toJSON: () => ({}) });
		f.root.scrollBy = jest.fn((value?: ScrollToOptions | number, y?: number) => { const scroll = typeof value === "number" ? { left: value, top: y } : value ?? {}; f.root.scrollLeft = Math.max(0, Math.min(600, f.root.scrollLeft + (scroll.left ?? 0))); f.root.scrollTop = Math.max(0, Math.min(300, f.root.scrollTop + (scroll.top ?? 0))); });
		const state = { pointer: { x: 0.25, y: 0.25 }, viewport: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } }, style = f.image.getAttribute("style");
		expect(f.motion.reveal(state, false, () => true)).toBe(true); expect([f.root.scrollLeft, f.root.scrollTop]).toEqual([100, 50]);
		expect(f.motion.reveal(state, true, () => true)).toBe(true); expect([f.root.scrollLeft, f.root.scrollTop]).toEqual([500, 250]);
		expect(f.image.getAttribute("style")).toBe(style); expect(f.image.scrollIntoView).not.toHaveBeenCalled();
		expect(f.motion.reveal(state, true, () => false)).toBe(false);
	} finally { f.close(); }
});

test("unsupported transforms withdraw geometry and close cancels pending paint and publication", async () => {
	const f = fixture();
	try {
		f.motion.setPeers([f.peer]); await settle(); f.root.style.rotate = "30deg"; await settle(); await settle();
		expect(f.publish).toHaveBeenLastCalledWith(null); expect(f.layer.hidden).toBe(true);
		f.image.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 100 }));
		f.motion.close(); const count = f.publish.mock.calls.length; await settle();
		expect(f.publish.mock.calls).toHaveLength(count); expect(f.root.querySelector(".relay-image-presence")).toBeNull(); expect(jest.getTimerCount()).toBe(0);
	} finally { f.close(); }
});
