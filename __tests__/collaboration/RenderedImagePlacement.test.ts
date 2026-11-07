/** @jest-environment jsdom */
import { RenderedImagePlacement } from "../../src/collaboration/ui/RenderedImagePlacement";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
let imageBox: DOMRect, drawImage: jest.Mock;
beforeEach(() => {
	jest.useFakeTimers(); imageBox = rect(50, 100, 200, 125); drawImage = jest.fn();
	jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
	jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
		return this.tagName === "IMG" ? imageBox : this.classList.contains("relay-image-placement-toolbar") ? rect(4, 0, 992, 80) : rect(0, 0, 1000, 800);
	});
	for (const property of ["clientWidth", "offsetWidth", "clientHeight", "offsetHeight"] as const) jest.spyOn(HTMLElement.prototype, property, "get").mockImplementation(function(this: HTMLElement) {
		return property.endsWith("Width") ? this.tagName === "IMG" ? 200 : 1000 : this.tagName === "IMG" ? 125 : 800;
	});
	HTMLElement.prototype.setPointerCapture = jest.fn(); HTMLElement.prototype.releasePointerCapture = jest.fn();
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
	const root = document.createElement("div"), image = document.createElement("img"), trigger = document.createElement("button");
	image.src = "https://images.test/chart.png"; root.append(image, trigger); document.body.append(root); trigger.focus();
	Object.defineProperties(image, { complete: { value: true, configurable: true }, naturalWidth: { value: 4000, configurable: true }, naturalHeight: { value: 2500, configurable: true } });
	const current = jest.fn(() => true), save = jest.fn().mockResolvedValue(undefined), preview = jest.fn(), closed = jest.fn();
	const surface = { root, image, current: jest.fn(() => true) };
	const placement = new RenderedImagePlacement({ surface, current, save, preview, closed, external: true }); placement.open();
	return { root, image, trigger, surface, current, save, preview, closed, placement,
		button: (label: string) => [...root.querySelectorAll("button")].find(button => button.textContent === label)!,
		mark: () => root.querySelector<HTMLButtonElement>(".relay-image-placement-mark")!,
		scene: () => root.querySelector<HTMLElement>(".relay-image-placement-scene")!,
		close: () => placement.close(),
	};
}
function pointer(target: Element, type: string, x: number, y: number, id = 1) {
	const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { clientX: x, clientY: y, button: 0, pointerId: id, isPrimary: id === 1 }); target.dispatchEvent(event);
}
function key(target: Element, value: string, shiftKey = false) { target.dispatchEvent(new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); }

test("freezes bounded pixels and saves exact intrinsic pin coordinates from the rendered occurrence", async () => {
	const f = fixture();
	try {
		const canvas = f.root.querySelector("canvas")!; expect([canvas.width, canvas.height]).toEqual([2048, 1280]);
		expect(drawImage).toHaveBeenCalledWith(f.image, 0, 0, 2048, 1280); expect(f.root.textContent).toContain("version unknown");
		f.button("Pin").click(); pointer(f.scene(), "pointerdown", 100, 162.5); pointer(f.scene(), "pointermove", 150, 193.75); pointer(f.scene(), "pointerup", 150, 193.75);
		expect(f.mark().style.left).toBe("100px"); expect(f.mark().style.top).toBe("93.75px");
		f.button("Add comment").click(); await flush();
		expect(f.save).toHaveBeenCalledWith({ width: 4000, height: 2500, orientation: "display" }, { type: "pin", x: 0.5, y: 0.75 });
		expect(canvas.width).toBe(0); expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(f.closed).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test("draws, translates, resizes and keyboard-adjusts a region without changing its image", async () => {
	const f = fixture();
	try {
		f.button("Region").click(); pointer(f.scene(), "pointerdown", 100, 125); pointer(f.scene(), "pointermove", 200, 200); pointer(f.scene(), "pointerup", 200, 200);
		pointer(f.mark(), "pointerdown", 125, 150); pointer(f.scene(), "pointermove", 145, 150); pointer(f.scene(), "pointerup", 145, 150);
		expect(f.mark().style.left).toBe("70px"); expect(f.mark().style.width).toBe("100px");
		const se = f.root.querySelector<HTMLButtonElement>('[data-handle="se"]')!;
		pointer(se, "pointerdown", 220, 200); pointer(f.scene(), "pointermove", 240, 212.5); pointer(f.scene(), "pointerup", 240, 212.5);
		key(f.mark(), "ArrowLeft"); key(se, "ArrowUp");
		f.button("Add comment").click(); await flush(); const geometry = f.save.mock.calls[0][1];
		expect(geometry.type).toBe("region"); expect(geometry.x).toBeCloseTo(0.34); expect(geometry.y).toBeCloseTo(0.2);
		expect(geometry.width).toBeCloseTo(0.6); expect(geometry.height).toBeCloseTo(0.69);
		expect(f.image.getAttribute("src")).toBe("https://images.test/chart.png"); expect(drawImage).toHaveBeenCalledTimes(1);
	} finally { f.close(); }
});

test.each(["pointercancel", "lostpointercapture"])("%s rolls back an unfinished gesture and releases capture", async event => {
	const f = fixture();
	try {
		f.button("Pin").click(); pointer(f.scene(), "pointerdown", 75, 125); pointer(f.scene(), event, 75, 125);
		f.button("Add comment").click(); await flush(); expect(f.save.mock.calls[0][1]).toEqual({ type: "pin", x: 0.5, y: 0.5 });
		expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(1);
	} finally { f.close(); }
});

test("scroll/layout changes cancel active drags; later pointer events cannot move a new coordinate frame", async () => {
	const f = fixture();
	try {
		f.button("Pin").click(); pointer(f.scene(), "pointerdown", 75, 125);
		imageBox = rect(50, 200, 200, 125); document.dispatchEvent(new Event("scroll")); await jest.advanceTimersByTimeAsync(20);
		pointer(f.scene(), "pointerup", 75, 225); f.button("Add comment").click(); await flush();
		expect(f.save.mock.calls[0][1]).toEqual({ type: "pin", x: 0.5, y: 0.5 });
	} finally { f.close(); }
});

test("object-fit cover uses intrinsic crop coordinates, not the visible frame", async () => {
	const f = fixture();
	try {
		f.image.style.objectFit = "cover"; f.image.style.objectPosition = "50% 50%";
		Object.defineProperty(f.image, "clientHeight", { value: 200 }); Object.defineProperty(f.image, "offsetHeight", { value: 200 }); imageBox = rect(50, 100, 200, 200);
		// Intrinsic content is 320 × 200 at x=-10, with 60 pixels cropped from either side.
		f.button("Pin").click(); pointer(f.scene(), "pointerdown", 70, 150); pointer(f.scene(), "pointerup", 70, 150);
		f.button("Add comment").click(); await flush(); expect(f.save.mock.calls[0][1]).toEqual({ type: "pin", x: 0.25, y: 0.25 });
	} finally { f.close(); }
});

test("ignores letterboxing, unrelated pointers and secondary buttons", async () => {
	const f = fixture();
	try {
		f.image.style.objectFit = "contain"; f.image.style.objectPosition = "50% 50%";
		Object.defineProperty(f.image, "clientHeight", { value: 250 }); Object.defineProperty(f.image, "offsetHeight", { value: 250 }); imageBox = rect(50, 100, 200, 250);
		f.button("Pin").click(); pointer(f.scene(), "pointerdown", 100, 110); // Letterbox above intrinsic pixels.
		pointer(f.scene(), "pointerup", 100, 110); pointer(f.scene(), "pointerdown", 100, 200, 2); pointer(f.scene(), "pointerup", 100, 200, 2);
		f.button("Add comment").click(); await flush(); expect(f.save.mock.calls[0][1]).toEqual({ type: "pin", x: 0.5, y: 0.5 });
	} finally { f.close(); }
});

test.each(["permission", "mapping", "dimensions", "removed"])("%s changes close the surface and prevent stale save callbacks", async change => {
	const f = fixture(); const canvas = f.root.querySelector("canvas")!, save = f.button("Add comment");
	if (change === "permission") f.current.mockReturnValue(false);
	if (change === "mapping") f.surface.current.mockReturnValue(false);
	if (change === "dimensions") Object.defineProperty(f.image, "naturalWidth", { value: 4010 });
	if (change === "removed") f.image.remove();
	f.placement.validate(); save.click(); await flush();
	expect(f.save).not.toHaveBeenCalled(); expect(canvas.width).toBe(0); expect(f.root.querySelector(".relay-image-placement")).toBeNull(); expect(jest.getTimerCount()).toBe(0);
	f.close(); expect(f.closed).toHaveBeenCalledTimes(1);
});

test("preview handoff preserves geometry and basis; Escape restores focus and leaves no listeners/timers", async () => {
	const f = fixture();
	f.button("Region").click(); f.button("Larger preview / coordinates").click();
	expect(f.preview).toHaveBeenCalledWith({ type: "region", x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, { width: 4000, height: 2500, orientation: "display" });
	f.mark().focus(); key(f.mark(), "Escape"); expect(document.activeElement).toBe(f.trigger);
	document.dispatchEvent(new Event("scroll")); await flush(); expect(jest.getTimerCount()).toBe(0); expect(f.save).not.toHaveBeenCalled();
});

test("keeps failed saves editable, deduplicates pending confirmation, and ignores late completion after close", async () => {
	const f = fixture();
	try {
		f.save.mockRejectedValueOnce(Error("local quota")); f.button("Add comment").click(); await flush();
		expect(f.root.textContent).toContain("could not be saved"); expect(f.button("Pin").disabled).toBe(false);
		let finish!: () => void; f.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
		const save = f.button("Add comment"); save.click(); save.click(); expect(f.save).toHaveBeenCalledTimes(2);
		f.close(); finish(); await flush(); expect(f.closed).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
	} finally { f.close(); }
});
