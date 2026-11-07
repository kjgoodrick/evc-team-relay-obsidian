import { baseId, baseObject } from "../bases/BaseContentProtocol";

/** Typed identity only. Authorization comes from the server's source witness. */
export type BaseGroupValue = { type: "empty" } |
	{ type: "text" | "date" | "instant" | "url" | "tag"; value: string } |
	{ type: "number"; value: number } | { type: "boolean"; value: boolean } |
	{ type: "duration"; value: number[] } | { type: "list"; value: BaseGroupValue[] } |
	{ type: "file"; record_id: string; record_generation: string } |
	{ type: "link"; record_id: string; record_generation: string; subpath: string } |
	{ type: "unresolved_link"; record_id: string; record_generation: string; link: string; source_path_sha256: string };

function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid Bases group value"); }
export function parseBaseGroupValue(value: unknown): BaseGroupValue {
	let nodes = 256, characters = 0;
	function text(value: unknown): string {
		requireValue(typeof value === "string" && (characters += value.length) <= 8192 &&
			!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
		return value;
	}
	function read(item: unknown, depth = 0): BaseGroupValue {
		requireValue(--nodes >= 0 && depth <= 8 && baseObject(item));
		const fields: Record<string, string[]> = { empty: [], text: ["value"], number: ["value"], boolean: ["value"],
			date: ["value"], instant: ["value"], url: ["value"], tag: ["value"], list: ["value"], duration: ["value"],
			file: ["record_id", "record_generation"], link: ["record_id", "record_generation", "subpath"],
			unresolved_link: ["record_id", "record_generation", "link", "source_path_sha256"] };
		requireValue(typeof item.type === "string" && Object.prototype.hasOwnProperty.call(fields, item.type));
		const keys = fields[item.type];
		requireValue(Object.keys(item).length === keys.length + 1 && keys.every(key => Object.prototype.hasOwnProperty.call(item, key)));
		if (item.type === "empty") return { type: "empty" };
		if (item.type === "file" || item.type === "link" || item.type === "unresolved_link") {
			requireValue(baseId(item.record_id) && baseId(item.record_generation));
			const record = { record_id: item.record_id.toLowerCase(), record_generation: item.record_generation.toLowerCase() };
			if (item.type === "file") return { type: "file", ...record };
			if (item.type === "link") {
				const subpath = text(item.subpath); requireValue(!subpath || subpath.startsWith("#"));
				return { type: "link", ...record, subpath };
			}
			requireValue(typeof item.source_path_sha256 === "string" && /^[a-f0-9]{64}$/.test(item.source_path_sha256));
			return { type: "unresolved_link", ...record, link: text(item.link), source_path_sha256: item.source_path_sha256 };
		}
		if (item.type === "list") {
			requireValue(Array.isArray(item.value) && item.value.length <= nodes);
			return { type: "list", value: item.value.map(child => read(child, depth + 1)) };
		}
		if (item.type === "number") {
			requireValue(typeof item.value === "number" && Number.isFinite(item.value));
			return { type: "number", value: item.value === 0 ? 0 : item.value };
		}
		if (item.type === "duration") {
			requireValue(Array.isArray(item.value) && item.value.length === 7 && item.value.every(n => typeof n === "number" && Number.isFinite(n)));
			return { type: "duration", value: (item.value as number[]).map(n => n === 0 ? 0 : n) };
		}
		if (item.type === "boolean") { requireValue(typeof item.value === "boolean"); return { type: "boolean", value: item.value }; }
		const result = text(item.value);
		if (item.type === "date") requireValue(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(result));
		if (item.type === "instant") requireValue(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(result));
		if (item.type === "tag") requireValue(result.startsWith("#"));
		return { type: item.type as "text" | "date" | "instant" | "url" | "tag", value: result };
	}
	return read(value);
}
