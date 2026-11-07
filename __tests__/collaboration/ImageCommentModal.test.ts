/** @jest-environment jsdom */
import type { App } from "obsidian";
import { ImageCommentModal } from "../../src/collaboration/ui/ImageCommentModal";
import type { ImagePreview } from "../../src/collaboration/ImageAssets";

jest.mock("obsidian", () => ({ Modal: class {
	contentEl = document.createElement("div"); titleEl = document.createElement("h2");
	onOpen() {} onClose() {}
	open() { document.body.append(this.titleEl, this.contentEl); this.onOpen(); }
	close() { this.onClose(); this.titleEl.remove(); this.contentEl.remove(); }
} }));
Object.assign(HTMLElement.prototype, {
	empty(this: HTMLElement) { this.replaceChildren(); }, setText(this: HTMLElement, text: string) { this.textContent = text; },
	addClass(this: HTMLElement, name: string) { this.classList.add(name); },
});
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let images: HTMLImageElement[];
beforeEach(() => {
	jest.useFakeTimers(); images = [];
	const original = document.createElement.bind(document);
	jest.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
		const element = original(tag, options); if (tag === "img") { images.push(element as HTMLImageElement); Object.defineProperties(element, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } }); } return element;
	});
	jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { document.body.replaceChildren(); jest.restoreAllMocks(); jest.useRealTimers(); });
function fixture(options: Partial<ConstructorParameters<typeof ImageCommentModal>[1]> = {}) {
	const preview: ImagePreview = { asset: { kind: "external", url: "https://images.test/chart.png", version_evidence: "unknown" }, url: "https://images.test/chart.png", valid: () => true, release: jest.fn() };
	const save = jest.fn().mockResolvedValue(undefined), current = jest.fn(() => true);
	const modal = new ImageCommentModal({} as App, { title: "Image", load: async () => preview, current, save, ...options });
	modal.open(); return { modal, preview, save, current };
}
async function loaded() { await flush(); images[images.length - 1].dispatchEvent(new Event("load")); await flush(); }
function button(label: string): HTMLButtonElement { return [...document.querySelectorAll("button")].find(button => button.textContent === label)!; }

test("uses a static bounded preview, provides numeric pin placement, and saves intrinsic geometry", async () => {
	const f = fixture(); await loaded();
	expect(images[0].referrerPolicy).toBe("no-referrer");
	expect(document.body.textContent).toContain("version unknown");
	button("Pin").click();
	const fields = document.querySelectorAll("input");
	fields[0].value = "25"; fields[0].dispatchEvent(new Event("change"));
	fields[1].value = "75"; fields[1].dispatchEvent(new Event("change"));
	expect(document.querySelector<HTMLElement>(".relay-image-comment-mark")!.style.left).toBe("25%");
	button("Add comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(f.preview, { width: 1200, height: 800, orientation: "display" }, { type: "pin", x: 0.25, y: 0.75 });
	expect(f.preview.release).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test("invalid regions cannot save and loss of context clears image bytes and controls immediately", async () => {
	const f = fixture(); await loaded(); button("Region").click();
	const width = document.querySelectorAll("input")[2]; width.value = "90"; width.dispatchEvent(new Event("change"));
	button("Add comment").click(); await flush(); expect(f.save).not.toHaveBeenCalled();
	f.current.mockReturnValue(false); f.modal.validate();
	expect(document.querySelector("canvas")!.width).toBe(0); expect(button("Add comment").disabled).toBe(true);
	expect(f.preview.release).toHaveBeenCalledTimes(1); f.modal.close();
});

test("pointer coordinates remain subpixel-precise and do not fail numeric input step validation", async () => {
	const f = fixture(); await loaded(); button("Pin").click();
	const canvas = document.querySelector("canvas")!, stage = canvas.parentElement!;
	jest.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 249, top: 287, width: 526, height: 328 } as DOMRect);
	stage.setPointerCapture = jest.fn(); stage.releasePointerCapture = jest.fn();
	const event = (type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, button: 0, clientX: 381, clientY: 533 }); return event; };
	// jsdom does not dispatch onpointer* properties; invoke the native handlers.
	stage.onpointerdown!.call(stage, event("pointerdown") as PointerEvent); stage.onpointerup!.call(stage, event("pointerup") as PointerEvent);
	expect(document.querySelector("input:invalid")).toBeNull();
	button("Add comment").click(); await flush();
	expect(f.save).toHaveBeenCalledWith(f.preview, expect.anything(), { type: "pin", x: 132 / 526, y: 246 / 328 });
});

test("replacement images suppress stored coordinates and keep an explicit review message", async () => {
	const f = fixture({ save: undefined, geometry: { type: "pin", x: 0.25, y: 0.5 }, changed: true }); await loaded();
	expect(document.body.textContent).toContain("Image changed");
	expect(document.querySelector<HTMLElement>(".relay-image-comment-overlay")!.classList.contains("is-unavailable")).toBe(true);
	expect(button("Add comment")).toBeUndefined(); f.modal.close();
});

test("inline-to-preview handoff rejects changed dimensions instead of reusing the selected coordinates", async () => {
	const f = fixture({ basis: { width: 400, height: 300, orientation: "display" }, geometry: { type: "pin", x: 0.2, y: 0.8 } }); await loaded();
	expect(document.body.textContent).toContain("dimensions changed"); expect(button("Add comment").disabled).toBe(true);
	button("Add comment").click(); await flush(); expect(f.save).not.toHaveBeenCalled(); expect(f.preview.release).toHaveBeenCalledTimes(1); f.modal.close();
});

test("late image loading after close releases the source without creating a new image or timer", async () => {
	let finish!: (value: ImagePreview) => void;
	const f = fixture({ load: () => new Promise(resolve => { finish = resolve; }) });
	f.modal.close(); finish(f.preview); await flush();
	expect(images).toHaveLength(0); expect(f.preview.release).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test("broken images and loading deadlines retain a clear status and cannot submit", async () => {
	const f = fixture(); await flush(); jest.advanceTimersByTime(15001);
	expect(button("Add comment").disabled).toBe(true); expect(document.body.textContent).toContain("did not finish loading");
	expect(f.preview.release).toHaveBeenCalledTimes(1); expect(images[0].getAttribute("src")).toBeNull(); f.modal.close();
});
