import type { TFile } from "obsidian";
import type { NativeBaseGroupValue } from "../bases/NativeBaseGroupValue";
import { parseBaseGroupValue, type BaseGroupValue } from "./BaseGroupValue";

export type GroupRecordReference = { record_id: string; record_generation: string };
type CaptureReferences = {
	file(file: TFile, capturedPath: string): Promise<GroupRecordReference>;
	source(path: string): Promise<GroupRecordReference & { source_path_sha256: string }>;
};

/** Human-readable typed choices; never expose record UUIDs as a file label. */
export function baseGroupValueLabel(value: BaseGroupValue | NativeBaseGroupValue, depth = 0): string {
	let label: string;
	if (value.type === "empty") return "Empty";
	if (value.type === "file" || value.type === "link") label = "file" in value ? value.file.path : "Shared file";
	else if (value.type === "unresolved_link") label = value.link + ("source" in value ? " · from " + value.source : "");
	else if (value.type === "list") label = depth < 3 ? "[" + value.value.slice(0, 4).map(item => baseGroupValueLabel(item, depth + 1)).join(", ") +
		(value.value.length > 4 ? ", …" : "") + "]" : `${value.value.length} values`;
	else label = value.type === "text" ? JSON.stringify(value.value) : String(value.value);
	if (value.type === "link") label += value.subpath;
	return label.slice(0, 160) + " (" + value.type.replace(/_/g, " ") + ")";
}

/** Freeze the entire bounded tree before the first asynchronous identity read.
 * File objects remain local; paths are only guards and never become record IDs. */
export async function captureBaseGroupValue(value: NativeBaseGroupValue, refs: CaptureReferences): Promise<BaseGroupValue> {
	let nodes = 256, characters = 0;
	const text = (value: string) => { if (typeof value !== "string" || (characters += value.length) > 8192) throw new Error("Group text exceeds capture limits"); return value; };
	function freeze(item: NativeBaseGroupValue, depth = 0): () => Promise<BaseGroupValue> {
		if (--nodes < 0 || depth > 8) throw new Error("Group value exceeds capture limits");
		if (item.type === "list") {
			if (!Array.isArray(item.value) || item.value.length > nodes) throw new Error("Group list exceeds capture limits");
			const children = item.value.map(child => freeze(child, depth + 1));
			return async () => { const value: BaseGroupValue[] = []; for (const child of children) value.push(await child()); return { type: "list", value }; };
		}
		if (item.type === "file" || item.type === "link") {
			const file = item.file, path = text(file.path), type = item.type, subpath = item.type === "link" ? text(item.subpath) : "";
			return async () => { const reference = await refs.file(file, path); return type === "file" ? { type, ...reference } : { type, ...reference, subpath }; };
		}
		if (item.type === "unresolved_link") {
			const source = text(item.source), link = text(item.link);
			return async () => ({ type: "unresolved_link", ...await refs.source(source), link });
		}
		const copied = parseBaseGroupValue(item);
		if ("value" in copied && typeof copied.value === "string") text(copied.value);
		return async () => copied;
	}
	return parseBaseGroupValue(await freeze(value)());
}

/** Reverse only currently readable, generation-matched managed references. */
export async function revealBaseGroupValue(value: BaseGroupValue,
	reference: (value: GroupRecordReference) => Promise<{ file: TFile; sourcePathHash: string }>): Promise<NativeBaseGroupValue> {
	async function read(item: BaseGroupValue): Promise<NativeBaseGroupValue> {
		if (item.type === "list") { const value: NativeBaseGroupValue[] = []; for (const child of item.value) value.push(await read(child)); return { type: "list", value }; }
		if (item.type === "file" || item.type === "link" || item.type === "unresolved_link") {
			const found = await reference(item);
			if (item.type === "file") return { type: "file", file: found.file };
			if (item.type === "link") return { type: "link", file: found.file, subpath: item.subpath };
			if (found.sourcePathHash !== item.source_path_sha256) throw new Error("Unresolved link source moved");
			return { type: "unresolved_link", source: found.file.path, link: item.link };
		}
		return item;
	}
	return read(parseBaseGroupValue(value));
}
