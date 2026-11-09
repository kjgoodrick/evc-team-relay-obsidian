import { TFile } from "obsidian";
import { InlineBaseAnchors, type InlineBaseAnchor, type InlineBaseSource } from "./InlineBaseAnchors";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object";
export interface InlineBaseRenderer {
	owner: ObjectValue; controller: ObjectValue; file: TFile; containerEl: HTMLElement;
}
export interface InlineBaseHostInfo {
	anchors: InlineBaseAnchors; anchor: InlineBaseAnchor;
	current(): boolean; read(): Promise<string>;
}
const hosts = new WeakMap<object, InlineBaseHostInfo>();
export const inlineBaseHostInfo = (host: object): InlineBaseHostInfo | undefined => hosts.get(host);

/** Native component ownership distinguishes inline renderers from saved-file
 * embeds. Both editor and Reading components can exist; only mounted ones count. */
export function inlineBaseRenderers(view: unknown, version: string): InlineBaseRenderer[] {
	if (version !== "1.13.7" || !object(view) || !(view.file instanceof TFile) || view.file.extension !== "md") return [];
	const root = view.contentEl as HTMLElement | undefined; if (!root?.isConnected) return [];
	const queue: unknown[] = [view], seen = new Set<unknown>(), found: InlineBaseRenderer[] = [];
	while (queue.length && seen.size < 256) {
		const owner = queue.shift(); if (!object(owner) || seen.has(owner)) continue; seen.add(owner);
		if (!Array.isArray(owner._children) || owner._children.length > 256) continue;
		const container = owner.containerEl as HTMLElement | undefined;
		if (owner._loaded === true && container?.nodeType === 1 && container.isConnected && root.contains(container)) {
			for (const controller of owner._children) if (object(controller) && controller._loaded === true &&
				controller.currentFile === view.file && object(controller.query) && controller.query.file === undefined && object(controller.view)) {
				found.push({ owner, controller, file: view.file, containerEl: container });
			}
		}
		queue.push(...owner._children);
	}
	return queue.length ? [] : found;
}

/** Source-section boundaries come from Obsidian's Markdown processor context.
 * Never match identical definitions by renderer order or query contents. */
export function inlineBaseInSection(anchors: InlineBaseAnchors, from: number, to: number): InlineBaseSource | undefined {
	if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) return;
	const matches = anchors.definitions.filter(item => item.from >= from && item.to <= to);
	return matches.length === 1 ? matches[0] : undefined;
}

export function inlineBaseHost(renderer: InlineBaseRenderer, anchors: InlineBaseAnchors, source: InlineBaseSource, allowed: () => boolean) {
	const anchor = anchors.capture(source); if (!anchor) return;
	const current = () => allowed() && renderer.owner._loaded === true && renderer.controller._loaded === true &&
		Array.isArray(renderer.owner._children) && renderer.owner._children.includes(renderer.controller) &&
		renderer.owner.containerEl === renderer.containerEl && renderer.containerEl.isConnected &&
		renderer.controller.currentFile === renderer.file && anchors.resolve(anchor)?.source === source.source;
	const host = {
		file: renderer.file, contentEl: renderer.containerEl, containerEl: renderer.containerEl,
		getViewType: () => "bases",
		get controller() { return current() ? renderer.controller : undefined; },
		get query() { return current() ? renderer.controller.query : undefined; },
		get data() { return current() ? source.source : undefined; },
		get lastSavedData() { return current() ? source.source : undefined; },
		get dirty() { return !current(); },
	};
	hosts.set(host, { anchors, anchor, current, read: async () => {
		if (!current()) throw new Error("Inline Base changed"); return source.source;
	} });
	return host;
}
