/**
 * Mock Obsidian API for Jest tests
 */

export const requestUrl = jest.fn();

/**
 * Mock for Obsidian's `getLanguage()` (@since 1.8.7) -- returns the
 * currently-configured interface language, defaults to "en". Tests that
 * need a different active language call `getLanguage.mockReturnValue(...)`
 * and should restore it (`mockReturnValue("en")` or `mockClear()`) after.
 */
export const getLanguage = jest.fn((): string => "en");

/**
 * Minimal standin for Obsidian's `debounce()` (real signature: cb, timeout,
 * resetTimer). Trailing-edge only (fires `cb` once `timeout` ms after the
 * last call when resetTimer=true, which is the only mode this repo uses).
 * Real `setTimeout` under the hood so callers can drive it with Jest fake
 * timers (`jest.useFakeTimers()` + `jest.advanceTimersByTime()`).
 */
export function debounce<T extends unknown[], V>(
	cb: (...args: T) => V,
	timeout = 0,
	resetTimer = false
): ((...args: T) => void) & { cancel: () => void } {
	let timer: number | null = null;
	let pendingArgs: T | null = null;

	const debounced = ((...args: T): void => {
		pendingArgs = args;
		if (timer && resetTimer) {
			window.clearTimeout(timer);
			timer = null;
		}
		if (!timer) {
			timer = window.setTimeout(() => {
				timer = null;
				const args2 = pendingArgs;
				pendingArgs = null;
				if (args2) cb(...args2);
			}, timeout);
		}
	}) as ((...args: T) => void) & { cancel: () => void };

	debounced.cancel = (): void => {
		if (timer) {
			window.clearTimeout(timer);
			timer = null;
		}
		pendingArgs = null;
	};

	return debounced;
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: true,
	isWin: false,
	isLinux: false,
};

export interface RequestUrlParam {
	url: string;
	method?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

export const normalizePath = (path: string): string =>
	path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\//, "");

export class TFile {
	path: string;
	basename: string;
	extension: string;
	name: string;
	stat: { mtime: number; ctime: number; size: number };

	constructor(path: string) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1];
		const extIdx = this.name.lastIndexOf(".");
		this.basename = extIdx >= 0 ? this.name.substring(0, extIdx) : this.name;
		this.extension = extIdx >= 0 ? this.name.substring(extIdx + 1) : "";
		this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
	}
}

export class TFolder {
	path: string;
	name: string;
	children: (TFile | TFolder)[];

	constructor(path: string, children: (TFile | TFolder)[] = []) {
		this.path = path;
		const parts = path.split("/");
		this.name = parts[parts.length - 1];
		this.children = children;
	}
}

export class Vault {}

/**
 * Enough of `WorkspaceLeaf`/`Workspace`/`ItemView` to let a module that
 * declares `class X extends ItemView` be imported under Jest. Tests that
 * exercise such a view build it with `Object.create(X.prototype)` (the
 * convention already used for Document/CanvasDocument elsewhere in this
 * suite), so none of these constructors is expected to do real work — they
 * exist because a missing `ItemView` binding makes the extending module throw
 * at import time, before any test runs.
 */
export class WorkspaceLeaf {
	detach(): void {}
}

export class Workspace {}

export class Modal {
	app: unknown;

	constructor(app: unknown) {
		this.app = app;
	}
}

export class ItemView {
	leaf: WorkspaceLeaf;

	constructor(leaf: WorkspaceLeaf) {
		this.leaf = leaf;
	}
}

/** Records every Notice construction so tests can assert on it. Reset with noticeMock.mockClear(). */
export const noticeMock = jest.fn<(message: string | DocumentFragment, timeout?: number) => void>();

/** Records every Notice#hide() call so tests can assert a notice was dismissed. */
export const noticeHideMock = jest.fn();

export class Notice {
	message: string | DocumentFragment;
	timeout?: number;

	constructor(message: string | DocumentFragment, timeout?: number) {
		this.message = message;
		this.timeout = timeout;
		noticeMock(message, timeout);
	}

	hide(): void {
		noticeHideMock();
	}
}

export function setIcon(el: HTMLElement, icon: string): void { el.textContent = ""; el.setAttribute("data-icon", icon); }
