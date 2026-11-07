import { nativeBaseGroupValue, nativeBaseGroupValueKey } from "../../src/bases/NativeBaseGroupValue";
import { BooleanValue, DateValue, DurationValue, FileValue, LinkValue, ListValue, NullValue, NumberValue,
	StringValue, TFile, UrlValue, Value } from "../mocks/nativeBaseValues";

jest.mock("obsidian", () => jest.requireActual("../mocks/nativeBaseValues"));
const read = (value: unknown) => nativeBaseGroupValue(value, () => null);
const key = (value: unknown) => nativeBaseGroupValueKey(read(value)!);

test("preserves empty, blank, zero, false and text identities even when native grouping combines them", () => {
	const keys = [NullValue.value, new StringValue(""), new NumberValue(0), new BooleanValue(false), new StringValue("0"),
		new StringValue("1"), new NumberValue(1), new BooleanValue(true)].map(key);
	expect(new Set(keys).size).toBe(keys.length);
	expect(key(null)).toBe(keys[0]); expect(key(undefined)).toBe(keys[0]);
	expect(key(new NumberValue(-0))).toBe(key(new NumberValue(0)));
});

test("dates retain local calendar meaning while instants retain milliseconds and normalize offsets", () => {
	expect(read(new DateValue(new Date(2026, 10, 6), false))).toEqual({ type: "date", value: "2026-11-06" });
	expect(key(new DateValue(new Date("2026-11-06T15:30:00.123-07:00"), true))).toBe(key(new DateValue(new Date("2026-11-06T22:30:00.123Z"), true)));
	expect(key(new DateValue(new Date("2026-11-01T01:30:00-06:00"), true))).not.toBe(key(new DateValue(new Date("2026-11-01T01:30:00-07:00"), true)));
	expect(key(new DateValue(new Date(2026, 10, 6), false))).not.toBe(key(new DateValue(new Date(2026, 10, 6), true)));
	expect(read(new DateValue(new Date(NaN), true))).toBeUndefined();
});

test("link aliases do not change the target; resolution uses the source and retains subpaths", () => {
	const file = Object.assign(new TFile(), { path: "Team/A.md" }), resolve = jest.fn(() => file as never);
	const first = Object.assign(new LinkValue("A#Heading"), { sourcePath: "Team/B.md", display: new StringValue("Alias") });
	const second = Object.assign(new LinkValue("A#Heading"), { sourcePath: "Team/C.md", display: new StringValue("Other") });
	const a = nativeBaseGroupValue(first, resolve)!, b = nativeBaseGroupValue(second, resolve)!;
	expect(resolve).toHaveBeenCalledWith("A", "Team/B.md");
	expect(a).toEqual({ type: "link", file, subpath: "#Heading" });
	expect(nativeBaseGroupValueKey(a)).toBe(nativeBaseGroupValueKey(b));
	expect(read(first)).toEqual({ type: "unresolved_link", link: "A#Heading", source: "Team/B.md" });
	expect(read(new FileValue(file))).toEqual({ type: "file", file });
	expect(key(new UrlValue("https://example.com/a"))).not.toBe(key(new StringValue("https://example.com/a")));
});

test("durations preserve calendar components instead of evaluating relative to the current day", () => {
	const month = Object.assign(new DurationValue(), { months: 1 });
	const days = Object.assign(new DurationValue(), { days: 30 });
	expect(key(month)).not.toBe(key(days));
	expect(read(month)).toEqual({ type: "duration", value: [0, 1, 0, 0, 0, 0, 0] });
});

test("lists preserve order, nested types and empty/singleton distinctions", () => {
	expect(key(new ListValue([new StringValue("1")]))).not.toBe(key(new NumberValue(1)));
	expect(key(new ListValue([]))).not.toBe(key(null));
	expect(key(new ListValue([new StringValue("a"), new StringValue("b")]))).not.toBe(key(new ListValue([new StringValue("b"), new StringValue("a")])));
	expect(read(new ListValue([new ListValue([new BooleanValue(true)]), NullValue.value]))).toEqual({ type: "list", value: [{ type: "list", value: [{ type: "boolean", value: true }] }, { type: "empty" }] });
});

test("unknown, malformed, cyclic, overlarge and throwing host values never fall back to labels", () => {
	class FakeText extends Value { data = "Planned"; toString() { throw new Error("Do not render"); } }
	const cyclic = new ListValue([]); cyclic.data.push(cyclic);
	const throwing = new ListValue([]); throwing.length = () => { throw new Error("Unavailable"); };
	let deep: Value = NullValue.value; for (let i = 0; i < 10; i++) deep = new ListValue([deep]);
	for (const value of [new FakeText(), { data: "Planned" }, new NumberValue(Infinity), new NumberValue(NaN),
		new StringValue("x".repeat(8193)), new StringValue("\uD800"), cyclic, throwing, deep,
		new ListValue(Array(257).fill(NullValue.value)), Object.assign(new DurationValue(), { days: Infinity })]) expect(read(value)).toBeUndefined();
	expect(read(new StringValue("🌿"))).toEqual({ type: "text", value: "🌿" });
});

test("shared work budgets bound aggregate capture across otherwise valid values", () => {
	const budget = { nodes: 3, characters: 4 }, resolve = () => null;
	expect(nativeBaseGroupValue(new StringValue("ab"), resolve, budget)).toEqual({ type: "text", value: "ab" });
	expect(nativeBaseGroupValue(new StringValue("cd"), resolve, budget)).toEqual({ type: "text", value: "cd" });
	expect(nativeBaseGroupValue(new StringValue("e"), resolve, budget)).toBeUndefined();
	expect(nativeBaseGroupValue(NullValue.value, resolve, budget)).toBeUndefined();
});
