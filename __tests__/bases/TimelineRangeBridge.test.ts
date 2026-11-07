import { timelineRangeBridge, type RemoteTimelineRanges } from "../../src/bases/TimelineRangeBridge";
import type { TimelineAxis } from "../../src/collaboration/DiscussionProtocol";
import type { TimelineRange } from "../../src/collaboration/TimelineRange";

function fixture(sequence = false) {
	const axis: TimelineAxis = { version: 1, renderer: sequence ? "sabidurian-sequence" : "sabidurian-timeline",
		start_property: { source: "note", name: "start" }, end_property: null, time_zone: sequence ? null : "UTC" };
	const range: TimelineRange = sequence ? { version: 1, kind: "ordinal", start: "1", end: "2", unit: "property-value", start_inclusive: true, end_inclusive: true } :
		{ version: 1, kind: "calendar", start: "2026-01-01", end: "2026-01-02", time_zone: "UTC", start_inclusive: true, end_inclusive: true };
	let alive = true, allowed = true, stop: (() => void) | undefined;
	const context = { axis, effectiveTimeZone: axis.time_zone, kinds: sequence ? ["ordinal"] : ["calendar", "instant", "historical"], current: () => alive };
	let choose: (selection: unknown) => void = () => {}, finish: () => void = () => {};
	const remoteStop = jest.fn(() => finish()), geometry = { startX: -5, endX: 50, top: 10, bottom: 20, discontinuous: false, current: () => alive };
	const source: RemoteTimelineRanges = { capabilities: ["ranges"], rangeContext: () => context,
		rangeGeometry: jest.fn(() => geometry), revealRange: jest.fn(() => "revealed"),
		beginRange: jest.fn((_kind, _precision, select, stopped) => { choose = select; finish = stopped; return remoteStop; }) };
	const adapter = timelineRangeBridge(source, axis.renderer, () => alive, () => allowed, {
		cancel: () => stop?.(), register: value => { stop = value; }, retire: value => { if (stop === value) stop = undefined; },
	});
	return { axis, range, context, source, geometry, remoteStop, adapter,
		selection: () => ({ context, draft: { ...range }, current: () => alive }),
		choose: (value: unknown) => choose(value), finish: () => finish(), cancel: () => stop?.(),
		stale: () => { alive = false; }, busy: () => { allowed = false; } };
}

test.each([false, true])("range provider supports the renderer's semantic coordinates (Sequence=%s)", sequence => {
	const f = fixture(sequence), context = f.adapter.rangeContext!()!;
	expect(context.axis).toEqual(f.axis); expect(context.current()).toBe(true);
	expect(Object.isFrozen(context.axis.start_property)).toBe(true);
	const lane = { entries: [] };
	expect(f.adapter.rangeGeometry!(f.range, f.axis, lane)?.startX).toBe(-5);
	expect(f.source.rangeGeometry).toHaveBeenCalledWith(f.range, f.axis, lane);
	expect(f.adapter.revealRange!(f.range, f.axis, lane)).toBe("revealed");
	f.axis.start_property.name = "changed"; expect(context.current()).toBe(false);
});

test.each(["unsupported", "method", "zone", "duplicate-kinds", "wrong-kind", "wrong-renderer", "invalid-axis"])("rejects %s range contexts", reason => {
	const f = fixture();
	if (reason === "unsupported") f.source.capabilities = [];
	if (reason === "method") f.source.beginRange = undefined;
	if (reason === "zone") f.context.effectiveTimeZone = "America/Denver";
	if (reason === "duplicate-kinds") f.context.kinds = ["calendar", "calendar"];
	if (reason === "wrong-kind") f.context.kinds = ["ordinal"];
	if (reason === "wrong-renderer") { f.axis.renderer = "sabidurian-sequence"; f.axis.time_zone = null; f.context.effectiveTimeZone = null; f.context.kinds = ["ordinal"]; }
	if (reason === "invalid-axis") f.axis.start_property.name = "";
	expect(f.adapter.rangeContext!()).toBeUndefined();
	expect(f.adapter.rangeGeometry!(f.range, f.axis)).toBeUndefined();
	expect(f.adapter.revealRange!(f.range, f.axis)).toBe("unavailable");
});

test("context copies are stable, property key order is irrelevant, and retired surfaces invalidate geometry", () => {
	const f = fixture(), context = f.adapter.rangeContext!()!, geometry = f.adapter.rangeGeometry!(f.range, f.axis)!;
	f.axis.start_property = { name: "start", source: "note" };
	expect(context.current()).toBe(true); expect(geometry.current()).toBe(true);
	f.stale(); expect(context.current()).toBe(false); expect(geometry.current()).toBe(false);
});

test("geometry rejects invalid numbers and mutation, while preserving reversed discontinuous endpoints", () => {
	const f = fixture(), geometry = f.adapter.rangeGeometry!(f.range, f.axis)!;
	f.geometry.startX = Infinity; expect(geometry.current()).toBe(false); expect(f.adapter.rangeGeometry!(f.range, f.axis)).toBeUndefined();
	f.geometry.startX = 60; f.geometry.discontinuous = true;
	expect(f.adapter.rangeGeometry!(f.range, f.axis)).toMatchObject({ startX: 60, endX: 50, discontinuous: true });
	f.geometry.bottom = 0; expect(f.adapter.rangeGeometry!(f.range, f.axis)).toBeUndefined();
});

test("mismatched axes and calendar zones never invoke renderer projection or navigation", () => {
	const f = fixture(), changed = { ...f.axis, start_property: { ...f.axis.start_property, name: "other" } };
	expect(f.adapter.rangeGeometry!(f.range, changed)).toBeUndefined();
	expect(f.adapter.revealRange!(f.range, changed)).toBe("unavailable");
	expect(f.source.rangeGeometry).not.toHaveBeenCalled(); expect(f.source.revealRange).not.toHaveBeenCalled();
	f.axis.time_zone = null; f.context.effectiveTimeZone = "America/Denver";
	expect(f.adapter.rangeGeometry!(f.range, f.axis)).toBeUndefined();
});

test("provider cleanup may precede selection; delivery is copied and only occurs once", () => {
	const f = fixture(), select = jest.fn(), stopped = jest.fn(), value = f.selection();
	f.adapter.beginRange!(f.range.kind, "day", select, stopped); f.finish(); f.choose(value); f.choose(value);
	expect(select).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledTimes(1);
	value.draft.start = "changed"; expect(select.mock.calls[0][0].draft.start).toBe("2026-01-01");
	f.axis.start_property.name = "changed"; expect(select.mock.calls[0][0].current()).toBe(false);
});

test.each(["cancel", "stale", "busy"] as const)("%s prevents late selection, and cancellation is idempotent", action => {
	const f = fixture(), select = jest.fn(), stopped = jest.fn(), value = f.selection();
	const stop = f.adapter.beginRange!(f.range.kind, "day", select, stopped)!;
	f[action](); f.choose(value); expect(select).not.toHaveBeenCalled(); stop(); stop();
	expect(f.remoteStop).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledTimes(1);
});

test("dirty inspector and incompatible kinds refuse interaction before calling the provider", () => {
	const f = fixture();
	expect(f.adapter.beginRange!("ordinal", "day", jest.fn(), jest.fn())).toBeUndefined();
	f.busy(); expect(f.adapter.beginRange!("calendar", "day", jest.fn(), jest.fn())).toBeUndefined();
	expect(f.adapter.revealRange!(f.range, f.axis)).toBe("busy"); expect(f.source.beginRange).not.toHaveBeenCalled();
});

test("a bounded incomplete instant draft is retained for explicit offset confirmation", () => {
	const f = fixture(), select = jest.fn();
	f.adapter.beginRange!("instant", "day", select, jest.fn());
	f.choose({ context: f.context, draft: { version: 1, kind: "instant", start: "2026-11-01T01:30:00", end: "2026-11-01T01:45:00" },
		issue: "Enter an explicit UTC offset.", current: () => true });
	expect(select).toHaveBeenCalledWith(expect.objectContaining({ issue: "Enter an explicit UTC offset." }));
});

test("point selection requires negotiation and preserves single closed coordinates", () => {
	const f = fixture(), select = jest.fn();
	expect(f.adapter.rangeContext!()?.pointSelection).toBe(false);
	expect(f.adapter.beginRange!("calendar", "day", select, jest.fn(), true)).toBeUndefined();
	expect(f.source.beginRange).not.toHaveBeenCalled(); f.source.capabilities.push("range-points");
	expect(f.adapter.rangeContext!()?.pointSelection).toBe(true);
	f.adapter.beginRange!("calendar", "day", select, jest.fn(), true);
	expect(f.source.beginRange).toHaveBeenCalledWith("calendar", "day", expect.any(Function), expect.any(Function), true);
	f.choose(f.selection()); expect(select).not.toHaveBeenCalled();
	const value = f.selection(); value.draft.end = value.draft.start; value.draft.end_inclusive = false;
	f.choose(value); expect(select).not.toHaveBeenCalled(); value.draft.end_inclusive = true;
	f.finish(); f.choose(value); expect(select).toHaveBeenCalledTimes(1);
	expect(select.mock.calls[0][0].current()).toBe(true); f.source.capabilities = ["ranges"];
	expect(select.mock.calls[0][0].current()).toBe(false);
});

test("capability withdrawal and cancellation fence late point selections", () => {
	const f = fixture(), select = jest.fn(); f.source.capabilities.push("range-points");
	f.adapter.beginRange!("calendar", "day", select, jest.fn(), true);
	const value = f.selection(); value.draft.end = value.draft.start;
	f.source.capabilities = ["ranges"]; f.choose(value); expect(select).not.toHaveBeenCalled();
	f.cancel(); f.source.capabilities.push("range-points"); f.choose(value); expect(select).not.toHaveBeenCalled();
});

test.each(["cyclic", "oversized", "wrong-kind", "other-axis", "stale-context"])("rejects %s selection callbacks", reason => {
	const f = fixture(), select = jest.fn(), value: Record<string, unknown> = f.selection();
	if (reason === "cyclic") (value.draft as Record<string, unknown>).start = value.draft;
	if (reason === "oversized") (value.draft as Record<string, unknown>).start = "a".repeat(2049);
	if (reason === "wrong-kind") (value.draft as Record<string, unknown>).kind = "ordinal";
	if (reason === "other-axis") value.context = { ...f.context, axis: { ...f.axis, start_property: { source: "note", name: "other" } } };
	if (reason === "stale-context") value.context = { ...f.context, current: () => false };
	f.adapter.beginRange!(f.range.kind, "day", select, jest.fn()); f.choose(value); expect(select).not.toHaveBeenCalled();
});

function presenceFixture(sequence = false) {
	const f = fixture(sequence), value = { context: f.context, range: { ...f.range }, group: null as unknown, offset: { x: 0.5, y: 0.25 }, current: () => true };
	f.source.capabilities.push("range-presence");
	f.source.rangePresence = jest.fn(() => value); f.source.rangePresenceGeometry = jest.fn(() => f.geometry); f.source.revealRangePresence = jest.fn(() => "revealed");
	return { ...f, value };
}

test.each([false, true])("passive range positions are copied, negotiated and independent of annotation (Sequence=%s)", sequence => {
	const f = presenceFixture(sequence), captured = f.adapter.rangePresence!({ clientX: 10, clientY: 20 })!;
	expect(captured.current()).toBe(true); expect(captured.range).toEqual(f.range); expect(Object.isFrozen(captured.range)).toBe(true);
	expect(f.source.beginRange).not.toHaveBeenCalled(); expect(f.source.revealRange).not.toHaveBeenCalled();
	expect(f.adapter.rangePresenceGeometry!(captured.range, captured.context.axis)?.current()).toBe(true);
	expect(f.adapter.revealRangePresence!(captured.range, captured.context.axis, captured.offset)).toBe("revealed");
	f.value.offset.x = 0.75; expect(captured.offset.x).toBe(0.5); expect(captured.current()).toBe(false);
	f.source.capabilities = ["ranges"];
	expect(f.adapter.rangePresence!()).toBeUndefined(); expect(f.adapter.rangePresenceGeometry!(f.range, f.axis)).toBeUndefined();
	expect(f.adapter.revealRangePresence!(f.range, f.axis, { x: 0.5, y: 0.5 })).toBe("unavailable");
});

test.each(["axis", "range", "offset", "group", "stale", "method", "bounds", "reversed"])("rejects %s passive range providers", reason => {
	const f = presenceFixture(), captured = f.adapter.rangePresence!()!;
	if (reason === "axis") f.axis.start_property.name = "changed";
	if (reason === "range") f.value.range.start = "invalid";
	if (reason === "offset") f.value.offset.y = 2;
	if (reason === "group") f.value.group = "Lane label";
	if (reason === "stale") f.stale();
	if (reason === "method") f.source.revealRangePresence = undefined;
	if (reason === "bounds") f.geometry.bottom = Infinity;
	if (reason === "reversed") { f.geometry.discontinuous = true; f.geometry.endX = -10; }
	if (!["bounds", "reversed"].includes(reason)) expect(captured.current()).toBe(false);
	if (["range", "offset", "group", "stale", "method"].includes(reason)) expect(f.adapter.rangePresence!()).toBeUndefined();
	if (["bounds", "reversed", "stale", "method"].includes(reason)) expect(f.adapter.rangePresenceGeometry!(f.range, f.axis)).toBeUndefined();
});

test("range presence refuses bad coordinates and navigation while an inspector is dirty", () => {
	const f = presenceFixture();
	expect(f.adapter.rangePresence!({ clientX: Infinity, clientY: 20 })).toBeUndefined(); expect(f.source.rangePresence).not.toHaveBeenCalled();
	f.busy(); expect(f.adapter.rangePresence!()?.current()).toBe(true);
	expect(f.adapter.revealRangePresence!(f.range, f.axis, { x: 0.5, y: 0.5 })).toBe("busy");
	expect(f.source.revealRangePresence).not.toHaveBeenCalled();
});

test("civil range projection preserves a forward DST discontinuity without treating its width as UTC duration", () => {
	const f = presenceFixture(); f.geometry.discontinuous = true;
	expect(f.adapter.rangePresenceGeometry!(f.range, f.axis)).toMatchObject({ discontinuous: true, startX: -5, endX: 50 });
});
