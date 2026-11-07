import { localMarkerRange, localMarkerMatchKey, promotedMarkerId } from "../../src/collaboration/LocalTimelineMarkers";
import { timelineLocalMarkers, type NativeLocalMarker } from "../../src/bases/TimelineLocalMarkerBridge";

const id = (n: number) => `74000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const local = (values: Partial<NativeLocalMarker> = {}): NativeLocalMarker => ({ id: id(1), label: "Launch", date: "2026-11-07", color: "var(--color-blue)", enabled: true, current: () => true, ...values });

test("promotion identity survives reload and content edits, and differs by base/generation/local origin", () => {
	const shared = promotedMarkerId(id(2), id(3), id(1));
	expect(shared).toBe(promotedMarkerId(id(2).toUpperCase(), id(3), id(1)));
	expect(shared).not.toBe(id(1));
	expect(new Set([shared, promotedMarkerId(id(4), id(3), id(1)), promotedMarkerId(id(2), id(4), id(1)), promotedMarkerId(id(2), id(3), id(4))]).size).toBe(4);
	expect(localMarkerMatchKey(id(2), id(3), id(1))).toContain(shared);
	expect(() => promotedMarkerId("label", id(3), id(1))).toThrow();
});
test("calendar point precision and the provider's exclusive band end are retained", () => {
	expect(localMarkerRange(local(), null)).toBeUndefined();
	expect(localMarkerRange(local(), "America/Denver")).toMatchObject({ kind: "calendar", start: "2026-11-07", end: "2026-11-07", end_inclusive: true, time_zone: "America/Denver" });
	expect(localMarkerRange(local({ date: undefined, start: "2026-11-07", end: "2026-11-09" }), "UTC")).toMatchObject({ kind: "calendar", end: "2026-11-09", start_inclusive: true, end_inclusive: false });
});
test.each([["501 BCE", -500, "year"], ["0", 0, "year"], ["2026-11", 2026, "month"], ["0050-03", 50, "month"]])("historical %s preserves its precision and astronomical numbering", (date, year, precision) => {
	expect(localMarkerRange(local({ date: String(date) }), "UTC")).toMatchObject({ kind: "historical", start: { year, precision }, end: { year, precision }, year_numbering: "astronomical" });
});
test.each(["2026-02-30", "2026-99-01", "2026-11-07T01:30", "2026-11-07T01:30:00-06:00", "today", "2026-11-07 trailing", "1000000001", "10000", "-500-12"])("unsupported or invalid %s requires explicit selection", date => {
	expect(localMarkerRange(local({ date }), "UTC")).toBeUndefined();
});
test("reversed or zero-width local bands are not silently reordered", () => {
	expect(localMarkerRange(local({ date: undefined, start: "2026-11-09", end: "2026-11-07" }), "UTC")).toBeUndefined();
	expect(localMarkerRange(local({ date: undefined, start: "2026", end: "2026" }), "UTC")).toBeUndefined();
});
test("bridge copies bounded snapshots and fences mutable values and provider lifetime", () => {
	const marker = local(); let active = true;
	const source = { capabilities: ["local-markers"], localMarkers: () => [marker] };
	const result = timelineLocalMarkers(source, () => active)[0];
	expect(result).not.toBe(marker); expect(result.current()).toBe(true);
	marker.label = "Changed"; expect(result.label).toBe("Launch"); expect(result.current()).toBe(false);
	const next = timelineLocalMarkers(source, () => active)[0]; active = false; expect(next.current()).toBe(false);
});
test("bridge rejects duplicate IDs, oversized pages and malformed sources without a partial list", () => {
	const source = { capabilities: ["local-markers"], localMarkers: () => [local(), local()] };
	expect(() => timelineLocalMarkers(source, () => true)).toThrow();
	source.localMarkers = () => Array(257).fill(local()); expect(() => timelineLocalMarkers(source, () => true)).toThrow();
	source.localMarkers = () => [local({ color: "x".repeat(257) })]; expect(() => timelineLocalMarkers(source, () => true)).toThrow();
	source.capabilities = []; expect(timelineLocalMarkers(source, () => true)).toEqual([]);
});
