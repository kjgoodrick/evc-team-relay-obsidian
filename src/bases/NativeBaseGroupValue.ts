import { BooleanValue, DateValue, DurationValue, FileValue, LinkValue, ListValue, NullValue, NumberValue,
	StringValue, TFile, UrlValue, Value, parseLinktext } from "obsidian";

/** Local renderer evidence, not a wire anchor or an authorization proof. Files
 * must be converted to managed identities before any target leaves this device.
 * Private value fields are confined to the version-gated native surface adapter.
 */
export type NativeBaseGroupValue =
	| { type: "empty" }
	| { type: "text" | "date" | "instant" | "url"; value: string }
	| { type: "number"; value: number }
	| { type: "boolean"; value: boolean }
	| { type: "duration"; value: number[] }
	| { type: "file"; file: TFile }
	| { type: "link"; file: TFile; subpath: string }
	| { type: "unresolved_link"; link: string; source: string }
	| { type: "list"; value: NativeBaseGroupValue[] };

type Fields = Record<string, unknown>;
export type NativeGroupLinkResolver = (link: string, source: string) => TFile | null;
export interface NativeGroupValueBudget { nodes: number; characters: number }
export const nativeGroupValueBudget = (): NativeGroupValueBudget => ({ nodes: 65_536, characters: 262_144 });
const durationFields = ["years", "months", "days", "hours", "minutes", "seconds", "milliseconds"] as const;

/** Never use a formatted label: aliases, locales and loose native equality can
 * make different values look identical. No expression is evaluated here; list
 * elements are materialized through the host's bounded Value API.
 */
export function nativeBaseGroupValue(value: unknown, resolve: NativeGroupLinkResolver, budget = nativeGroupValueBudget()): NativeBaseGroupValue | undefined {
	let nodes = 256, characters = 0;
	const seen = new Set<Value>();
	function string(text: unknown): string {
		if (typeof text !== "string" || (characters += text.length) > 8192 || (budget.characters -= text.length) < 0 ||
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) throw new Error("Unsupported group text");
		return text;
	}
	function read(item: unknown, depth: number): NativeBaseGroupValue {
		if (--nodes < 0 || --budget.nodes < 0 || depth > 8) throw new Error("Group value exceeds capture limits");
		if (item === null || item === undefined) return { type: "empty" };
		if (!(item instanceof Value) || seen.has(item)) throw new Error("Unsupported group value");
		const fields = item as unknown as Fields;
		seen.add(item);
		try {
			if (item.constructor === NullValue) return { type: "empty" };
			if (item.constructor === LinkValue) {
				const link = string(fields.data), source = string(fields.sourcePath), parsed = parseLinktext(link), file = resolve(parsed.path, source);
				return file instanceof TFile ? { type: "link", file, subpath: parsed.subpath } : { type: "unresolved_link", link, source };
			}
			if (item.constructor === FileValue && fields.file instanceof TFile) return { type: "file", file: fields.file };
			if (item.constructor === StringValue) return { type: "text", value: string(fields.data) };
			if (item.constructor === UrlValue) return { type: "url", value: string(fields.data) };
			if (item.constructor === NumberValue && typeof fields.data === "number" && Number.isFinite(fields.data)) return { type: "number", value: fields.data === 0 ? 0 : fields.data };
			if (item.constructor === BooleanValue && typeof fields.data === "boolean") return { type: "boolean", value: fields.data };
			if (item instanceof DateValue && typeof fields.time === "boolean") {
				// Date-only values use the host's local calendar fields. Instants use
				// UTC, so DST folds and equivalent explicit offsets remain distinct/correct.
				const date = fields.date as Date, stamp = Date.prototype.getTime.call(date);
				if (!Number.isFinite(stamp)) throw new Error("Invalid group date");
				if (fields.time) return { type: "instant", value: Date.prototype.toISOString.call(date) };
				const year = Date.prototype.getFullYear.call(date), month = Date.prototype.getMonth.call(date) + 1, day = Date.prototype.getDate.call(date);
				if (year < 0 || year > 9999) throw new Error("Unsupported calendar year");
				return { type: "date", value: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
			}
			if (item.constructor === DurationValue) {
				const values = durationFields.map(field => fields[field]);
				if (!values.every(n => typeof n === "number" && Number.isFinite(n))) throw new Error("Invalid duration");
				// A month is not a fixed millisecond duration; preserve its components.
				return { type: "duration", value: (values as number[]).map(n => n === 0 ? 0 : n) };
			}
			if (item.constructor === ListValue) {
				const length = (item as ListValue).length();
				if (!Number.isSafeInteger(length) || length < 0 || length > nodes) throw new Error("Group list exceeds capture limits");
				return { type: "list", value: Array.from({ length }, (_, index) => read((item as ListValue).get(index), depth + 1)) };
			}
			throw new Error("Unsupported group value");
		} finally { seen.delete(item); }
	}
	try { return read(value, 0); } catch { return undefined; }
}

/** Ephemeral lookup only: file paths here are never persisted or sent as IDs. */
export function nativeBaseGroupValueKey(value: NativeBaseGroupValue): string {
	function key(item: NativeBaseGroupValue): unknown[] {
		switch (item.type) {
			case "empty": return [item.type];
			case "link": return [item.type, item.file.path, item.subpath];
			case "file": return [item.type, item.file.path];
			case "unresolved_link": return [item.type, item.link, item.source];
			case "list": return [item.type, item.value.map(key)];
			default: return [item.type, item.value];
		}
	}
	return JSON.stringify(key(value));
}
