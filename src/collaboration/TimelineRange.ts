/** Bounded semantic coordinates only. Saved-view/axis identity, lane witnesses,
 * authorization and renderer projection are separate from this wire value. */
export type HistoricalPoint = { precision: "year"; year: number } |
	{ precision: "month"; year: number; month: number } | { precision: "day"; year: number; month: number; day: number };
type Bounds = { version: 1; start_inclusive: boolean; end_inclusive: boolean };
export type TimelineRange = Bounds & (
	{ kind: "calendar" | "instant"; start: string; end: string; time_zone: string } |
	{ kind: "historical"; start: HistoricalPoint; end: HistoricalPoint; calendar: "proleptic-gregorian"; year_numbering: "astronomical" } |
	{ kind: "ordinal"; start: string; end: string; unit: "property-value" }
);
type RecordValue = Record<string, unknown>;
type Civil = [number, number, number];
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("Invalid timeline range"); }
function fields(value: RecordValue, keys: readonly string[]): void {
	requireValue(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
const integer = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const days = (year: number, month: number) => month === 2 ? leap(year) ? 29 : 28 : [4, 6, 9, 11].includes(month) ? 30 : 31;
const compare = (a: Civil, b: Civil) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function nextDay([year, month, day]: Civil): Civil {
	return day < days(year, month) ? [year, month, day + 1] : month < 12 ? [year, month + 1, 1] : [year + 1, 1, 1];
}
function date(value: unknown): Civil {
	requireValue(typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value));
	const [year, month, day] = value.split("-").map(Number);
	requireValue(year >= 1 && integer(month, 1, 12) && integer(day, 1, days(year, month))); return [year, month, day];
}
export function parseTimelineTimeZone(value: unknown): string {
	requireValue(typeof value === "string" && value.length <= 128 && /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value));
	// Decoding must preserve zones absent from this device's timezone database.
	// Capture validates support separately; rendering must never guess a zone.
	return value;
}
/** Capture/projection check, separate from durable decoding and identity. */
export function validateTimelineTimeZone(value: unknown): string {
	const name = parseTimelineTimeZone(value);
	try { new Intl.DateTimeFormat("en", { timeZone: name }); } catch { throw new Error("Unsupported timeline time zone"); }
	return name;
}
function instant(value: unknown): { value: string; utc: string; epoch: number } {
	requireValue(typeof value === "string" && value.length <= 29);
	const match = value.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?(Z|[+-][0-9]{2}:[0-9]{2})$/);
	requireValue(match); const [year, month, day] = date(match[1]);
	const hour = Number(match[2]), minute = Number(match[3]), second = Number(match[4]), millis = Number((match[5] ?? "").padEnd(3, "0"));
	requireValue(hour < 24 && minute < 60 && second < 60 && match[6] !== "-00:00");
	const suffix = match[6], offsetHour = suffix === "Z" ? 0 : Number(suffix.slice(1, 3)), offsetMinute = suffix === "Z" ? 0 : Number(suffix.slice(4));
	requireValue(offsetHour < 24 && offsetMinute < 60);
	const offset = (offsetHour * 60 + offsetMinute) * (suffix.startsWith("-") ? -1 : 1);
	const civil = new Date(0); civil.setUTCFullYear(year, month - 1, day); civil.setUTCHours(hour, minute, second, millis);
	const epoch = civil.getTime() - offset * 60_000, utc = new Date(epoch);
	requireValue(utc.getUTCFullYear() >= 1 && utc.getUTCFullYear() <= 9999);
	return { value: `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${String(millis).padStart(3, "0")}${offset === 0 ? "Z" : suffix}`, utc: utc.toISOString(), epoch };
}
function historical(value: unknown): HistoricalPoint {
	requireValue(record(value) && integer(value.year, -1_000_000_000, 1_000_000_000));
	if (value.precision === "year") { fields(value, ["precision", "year"]); return { precision: "year", year: value.year }; }
	requireValue(integer(value.month, 1, 12));
	if (value.precision === "month") { fields(value, ["precision", "year", "month"]); return { precision: "month", year: value.year, month: value.month }; }
	requireValue(value.precision === "day" && integer(value.day, 1, days(value.year, value.month)));
	fields(value, ["precision", "year", "month", "day"]); return { precision: "day", year: value.year, month: value.month, day: value.day };
}
function period(point: HistoricalPoint): [Civil, Civil] {
	if (point.precision === "year") return [[point.year, 1, 1], [point.year + 1, 1, 1]];
	if (point.precision === "month") return [[point.year, point.month, 1], point.month < 12 ? [point.year, point.month + 1, 1] : [point.year + 1, 1, 1]];
	const start: Civil = [point.year, point.month, point.day]; return [start, nextDay(start)];
}
function decimal(value: unknown): { value: string; scaled: bigint } {
	requireValue(typeof value === "string" && value.length <= 26 && /^-?(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,9})?$/.test(value));
	const negative = value.startsWith("-"), [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
	const scaled = BigInt(whole) * BigInt(1_000_000_000) + BigInt(fraction.padEnd(9, "0"));
	const trimmed = fraction.replace(/0+$/, "");
	return { value: scaled === BigInt(0) ? "0" : (negative ? "-" : "") + whole + (trimmed ? "." + trimmed : ""), scaled: negative ? -scaled : scaled };
}
function ordered(start: number | bigint, end: number | bigint, bounds: Bounds): void {
	requireValue(start < end || start === end && bounds.start_inclusive && bounds.end_inclusive);
}
/** Closed calendar/historical bounds include the whole stated day/month/year.
 * Open bounds exclude that whole period. Instant/ordinal bounds are points. */
export function parseTimelineRange(value: unknown): TimelineRange {
	requireValue(record(value) && value.version === 1 && typeof value.start_inclusive === "boolean" && typeof value.end_inclusive === "boolean");
	const bounds: Bounds = { version: 1, start_inclusive: value.start_inclusive, end_inclusive: value.end_inclusive };
	const common = ["version", "kind", "start", "end", "start_inclusive", "end_inclusive"];
	if (value.kind === "calendar" || value.kind === "instant") {
		fields(value, [...common, "time_zone"]); const time_zone = parseTimelineTimeZone(value.time_zone);
		if (value.kind === "calendar") {
			const start = date(value.start), end = date(value.end);
			requireValue(compare(start, end) <= 0 && compare(bounds.start_inclusive ? start : nextDay(start), bounds.end_inclusive ? nextDay(end) : end) < 0);
			return { ...bounds, kind: "calendar", start: value.start as string, end: value.end as string, time_zone };
		}
		const start = instant(value.start), end = instant(value.end); ordered(start.epoch, end.epoch, bounds);
		return { ...bounds, kind: "instant", start: start.value, end: end.value, time_zone };
	}
	if (value.kind === "historical") {
		fields(value, [...common, "calendar", "year_numbering"]);
		requireValue(value.calendar === "proleptic-gregorian" && value.year_numbering === "astronomical");
		const start = historical(value.start), end = historical(value.end), a = period(start), b = period(end);
		requireValue(compare(a[bounds.start_inclusive ? 0 : 1], b[bounds.end_inclusive ? 1 : 0]) < 0);
		return { ...bounds, kind: "historical", start, end, calendar: "proleptic-gregorian", year_numbering: "astronomical" };
	}
	requireValue(value.kind === "ordinal" && value.unit === "property-value"); fields(value, [...common, "unit"]);
	const start = decimal(value.start), end = decimal(value.end); ordered(start.scaled, end.scaled, bounds);
	return { ...bounds, kind: "ordinal", start: start.value, end: end.value, unit: "property-value" };
}
/** Coordinate identity only; callers must also include managed view/axis/lane IDs. */
export function timelineRangeKey(value: TimelineRange): string {
	const range = parseTimelineRange(value), points = range.kind === "instant" ? [instant(range.start).utc, instant(range.end).utc] :
		range.kind === "historical" ? [range.start, range.end].map(point => [point.precision, point.year, "month" in point ? point.month : null, "day" in point ? point.day : null]) : [range.start, range.end];
	return JSON.stringify([1, range.kind, ...points, range.start_inclusive, range.end_inclusive,
		"time_zone" in range ? range.time_zone : range.kind === "historical" ? [range.calendar, range.year_numbering] : range.unit]);
}

export function timelineRangeLabel(range: TimelineRange, shape: "range" | "point" = "range"): string {
	const point = (value: HistoricalPoint) => {
		const year = value.year > 0 ? String(value.year) : `${1 - value.year} BCE`;
		return value.precision === "year" ? year : `${String(value.month).padStart(2, "0")}${value.precision === "day" ? "-" + String(value.day).padStart(2, "0") : ""}, ${year}`;
	};
	const start = range.kind === "historical" ? point(range.start) : range.start;
	const end = range.kind === "historical" ? point(range.end) : range.end;
	return `${range.kind === "ordinal" ? "Sequence" : "Timeline"} ${shape}: ${start}${shape === "range" ? " – " + end : ""}${"time_zone" in range ? " · " + range.time_zone : ""}`;
}
