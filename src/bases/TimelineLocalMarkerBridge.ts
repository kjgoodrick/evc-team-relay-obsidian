import { isId, isRecord } from "../collaboration/DiscussionProtocol";

export interface NativeLocalMarker {
	id: string; label: string; color: string; enabled: boolean;
	date?: string; start?: string; end?: string;
	current(): boolean;
}
export interface RemoteLocalMarkers { capabilities: string[]; localMarkers?(): unknown }

function copy(value: unknown): Omit<NativeLocalMarker, "current"> {
	if (!isRecord(value) || !isId(value.id) || typeof value.current !== "function" ||
		!Object.keys(value).every(key => ["id", "label", "color", "enabled", "date", "start", "end", "current"].includes(key)) ||
		typeof value.label !== "string" || value.label.length > 512 || typeof value.color !== "string" || value.color.length > 256 ||
		typeof value.enabled !== "boolean" || [value.date, value.start, value.end].some(item => item !== undefined && (typeof item !== "string" || item.length > 128))) {
		throw new Error("A local marker needs repair in Time & Line settings.");
	}
	return { id: value.id.toLowerCase(), label: value.label, color: value.color, enabled: value.enabled,
		...(value.date === undefined ? {} : { date: value.date as string }), ...(value.start === undefined ? {} : { start: value.start as string }),
		...(value.end === undefined ? {} : { end: value.end as string }) };
}
export function timelineLocalMarkers(source: RemoteLocalMarkers, current: () => boolean): NativeLocalMarker[] {
	if (!current() || !source.capabilities.includes("local-markers") || !source.localMarkers) return [];
	const values = source.localMarkers();
	if (!Array.isArray(values) || values.length > 256) throw new Error("Local marker selection supports at most 256 markers.");
	const ids = new Set<string>();
	return values.map(value => {
		const saved = copy(value), key = JSON.stringify(saved);
		if (ids.has(saved.id)) throw new Error("Local marker identities are ambiguous. Reopen Time & Line."); ids.add(saved.id);
		return Object.freeze({ ...saved, current: () => {
			try { return current() && source.capabilities.includes("local-markers") && value.current() === true && JSON.stringify(copy(value)) === key; }
			catch { return false; }
		} });
	});
}
