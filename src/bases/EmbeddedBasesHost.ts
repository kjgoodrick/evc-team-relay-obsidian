import { TFile } from "obsidian";
import { NATIVE_BASES_VERSIONS } from "./NativeBasesSurface";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === "object";
export interface EmbeddedBase {
	owner: RecordValue;
	file: TFile;
	containingFile: TFile;
	containerEl: HTMLElement;
}

/** Obsidian 1.13.7 component ownership, not DOM labels or rendered row order.
 * Inline code blocks deliberately do not match: they need their own identity. */
export function embeddedBases(view: unknown, version: string): EmbeddedBase[] {
	if (!NATIVE_BASES_VERSIONS.includes(version) || !object(view) || !(view.file instanceof TFile)) return [];
	const root = view.contentEl as HTMLElement | undefined;
	if (!root?.isConnected) return [];
	const queue: unknown[] = [view], seen = new Set<unknown>(), found: EmbeddedBase[] = [];
	while (queue.length && seen.size < 256) {
		const value = queue.shift(); if (!object(value) || seen.has(value)) continue; seen.add(value);
		if (value.file instanceof TFile && value.file.extension === "base" && value.containingFile === view.file && object(value.controller)) {
			const container = value.containerEl as HTMLElement | undefined;
			if (container?.nodeType === 1 && root.contains(container) && container.isConnected && value._loaded === true) {
				found.push({ owner: value, file: value.file, containingFile: view.file, containerEl: container });
			}
		}
		if (Array.isArray(value._children) && value._children.length <= 256) queue.push(...value._children);
	}
	return queue.length ? [] : found;
}

/** Read-only facade for the existing exact-byte/registry adapter. Getters keep
 * renderer changes observable; a changed source or revoked host invalidates it. */
export function embeddedBaseHost(embed: EmbeddedBase, source: string, allowed: () => boolean) {
	const { mtime, size } = embed.file.stat;
	const current = () => allowed() && embed.owner._loaded === true && embed.owner.file === embed.file &&
		embed.owner.containingFile === embed.containingFile && embed.owner.containerEl === embed.containerEl &&
		embed.containerEl.isConnected && embed.file.stat.mtime === mtime && embed.file.stat.size === size;
	return {
		file: embed.file, contentEl: embed.containerEl,
		getViewType: () => "bases",
		get controller() { return current() ? embed.owner.controller : undefined; },
		get query() { const controller = embed.owner.controller; return current() && object(controller) ? controller.query : undefined; },
		get data() { return current() ? source : undefined; },
		get lastSavedData() { return current() ? source : undefined; },
		get dirty() { return !current(); },
	};
}
