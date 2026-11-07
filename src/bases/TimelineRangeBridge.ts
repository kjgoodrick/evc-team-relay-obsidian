import { parseTimelineAxis, type TimelineAxis } from "../collaboration/DiscussionProtocol";
import { parseTimelineRange, validateTimelineTimeZone, type HistoricalPoint, type TimelineRange } from "../collaboration/TimelineRange";
import type { NativeBasesExtension, NativeBaseReveal, NativeTimelineContext, NativeTimelineGeometry, NativeTimelineSelection } from "./NativeBasesSurface";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);
export interface RemoteTimelineRanges {
	capabilities: string[];
	rangeContext?(): unknown;
	rangeGeometry?(range: TimelineRange, axis: TimelineAxis, group?: unknown): unknown;
	revealRange?(range: TimelineRange, axis: TimelineAxis, group?: unknown): unknown;
	beginRange?(kind: TimelineRange["kind"], precision: HistoricalPoint["precision"], select: (selection: unknown) => void, stopped: () => void): unknown;
}
interface Lifecycle {
	cancel(): void;
	register(stop: () => void): void;
	retire(stop: () => void): void;
}
type RangeMethods = Pick<NativeBasesExtension, "rangeContext" | "rangeGeometry" | "revealRange" | "beginRange">;

/** A gesture may return an incomplete explicit-offset date for confirmation.
 * Copy bounded JSON without coercion; only the final composer may turn a draft
 * into an authorized durable target. Never traverse arbitrary renderer state. */
function copyDraft(value: unknown): Record<string, unknown> {
	let budget = 32, characters = 0;
	const visit = (input: unknown, depth: number): unknown => {
		if (--budget < 0 || depth > 2) throw new Error("Oversized range draft");
		if (typeof input === "string") { characters += input.length; if (characters > 2048) throw new Error("Oversized range draft"); return input; }
		if (input === null || typeof input === "boolean" || typeof input === "number" && Number.isFinite(input)) return input;
		if (!object(input)) throw new Error("Unsupported range draft");
		const keys = Object.keys(input); if (keys.length > 12) throw new Error("Oversized range draft");
		return Object.fromEntries(keys.map(key => {
			characters += key.length; if (characters > 2048) throw new Error("Oversized range draft");
			return [key, visit(input[key], depth + 1)];
		}));
	};
	if (!object(value)) throw new Error("Unsupported range draft");
	return visit(value, 0) as Record<string, unknown>;
}

/** Optional local renderer boundary, not saved-view identity or authorization. */
export function timelineRangeBridge(source: RemoteTimelineRanges, renderer: string, current: () => boolean,
	canNavigate: () => boolean, lifecycle: Lifecycle): RangeMethods {
	const supported = () => current() && Array.isArray(source.capabilities) && source.capabilities.includes("ranges") &&
		typeof source.rangeContext === "function" && typeof source.rangeGeometry === "function" &&
		typeof source.revealRange === "function" && typeof source.beginRange === "function";
	const context = (value: unknown): NativeTimelineContext | undefined => {
		if (!supported() || !object(value) || typeof value.current !== "function") return;
		const axis = parseTimelineAxis(value.axis), sequence = axis.renderer === "sabidurian-sequence";
		if (axis.renderer !== renderer) return;
		const zone = sequence ? null : validateTimelineTimeZone(value.effectiveTimeZone);
		if (sequence && value.effectiveTimeZone !== null || axis.time_zone !== null && axis.time_zone !== zone) return;
		const rawKinds = value.kinds, allowed = sequence ? ["ordinal"] : ["calendar", "instant", "historical"];
		if (!Array.isArray(rawKinds) || !rawKinds.length || rawKinds.length > allowed.length || new Set(rawKinds).size !== rawKinds.length ||
			!rawKinds.every(kind => allowed.includes(kind))) return;
		const kinds = Object.freeze([...rawKinds]) as readonly TimelineRange["kind"][], key = JSON.stringify(axis), kindKey = JSON.stringify(kinds);
		Object.freeze(axis.start_property); if (axis.end_property) Object.freeze(axis.end_property); Object.freeze(axis);
		return { axis, effectiveTimeZone: zone, kinds, current: () => {
			try { return supported() && (value.current as () => unknown).call(value) === true &&
				JSON.stringify(parseTimelineAxis(value.axis)) === key && value.effectiveTimeZone === zone && JSON.stringify(value.kinds) === kindKey; }
			catch { return false; }
		} };
	};
	const rangeContext = () => {
		try { const result = supported() ? context(source.rangeContext!()) : undefined; return result?.current() ? result : undefined; }
		catch { return; }
	};
	const inputs = (range: TimelineRange, axis: TimelineAxis) => {
		const selected = rangeContext(), parsedAxis = parseTimelineAxis(axis), parsedRange = parseTimelineRange(range);
		if (!selected || JSON.stringify(selected.axis) !== JSON.stringify(parsedAxis) || !selected.kinds.includes(parsedRange.kind) ||
			"time_zone" in parsedRange && parsedAxis.time_zone !== null && parsedRange.time_zone !== parsedAxis.time_zone ||
			parsedRange.kind === "calendar" && parsedRange.time_zone !== selected.effectiveTimeZone) return;
		return { selected, axis: parsedAxis, range: parsedRange };
	};
	return {
		rangeContext,
		rangeGeometry: (range, axis, group): NativeTimelineGeometry | undefined => {
			try {
				const checked = inputs(range, axis); if (!checked) return;
				const value = source.rangeGeometry!(checked.range, checked.axis, group);
				if (!object(value) || typeof value.current !== "function" || typeof value.discontinuous !== "boolean") return;
				const coordinates = [value.startX, value.endX, value.top, value.bottom];
				if (!coordinates.every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate) && Math.abs(coordinate) <= 1e9) ||
					(value.bottom as number) < (value.top as number)) return;
				const [startX, endX, top, bottom] = coordinates as number[], discontinuous = value.discontinuous;
				const live = () => { try { return checked.selected.current() && (value.current as () => unknown).call(value) === true &&
					value.startX === startX && value.endX === endX && value.top === top && value.bottom === bottom && value.discontinuous === discontinuous; } catch { return false; } };
				return live() ? { startX, endX, top, bottom, discontinuous, current: live } : undefined;
			} catch { return; }
		},
		revealRange: (range, axis, group) => {
			try {
				const checked = inputs(range, axis); if (!checked) return "unavailable";
				if (!canNavigate()) return "busy";
				const result = source.revealRange!(checked.range, checked.axis, group);
				return ["revealed", "hidden", "unavailable", "busy", "ambiguous"].includes(String(result)) ? result as NativeBaseReveal : "unavailable";
			} catch { return "unavailable"; }
		},
		beginRange: (kind, precision, select, stopped) => {
			const initial = rangeContext();
			if (!initial?.kinds.includes(kind) || !["year", "month", "day"].includes(precision) || !canNavigate()) return;
			lifecycle.cancel();
			let ended = false, cancelled = false, delivered = false, remote = () => {};
			const done = () => { if (ended) return; ended = true; lifecycle.retire(stop); stopped(); };
			const stop = () => { if (cancelled) return; cancelled = true; try { remote(); } finally { done(); } };
			try {
				const result = source.beginRange!(kind, precision, value => {
					try {
						if (cancelled || delivered || !initial.current() || !canNavigate() || !object(value) || typeof value.current !== "function") return;
						const selected = context(value.context);
						if (!selected?.current() || JSON.stringify(selected.axis) !== JSON.stringify(initial.axis) ||
							selected.effectiveTimeZone !== initial.effectiveTimeZone || !selected.kinds.includes(kind)) return;
						const draft = value.draft === undefined ? undefined : copyDraft(value.draft), issue = value.issue;
						if (draft && (draft.kind !== kind || draft.version !== 1) || issue !== undefined && (typeof issue !== "string" || issue.length > 1024) || !draft && !issue) return;
						const live = () => { try { return initial.current() && selected.current() && (value.current as () => unknown).call(value) === true; } catch { return false; } };
						if (!live()) return;
						const selection: NativeTimelineSelection = { context: selected, draft, issue: issue as string | undefined, current: live };
						delivered = true; select(selection);
					} catch { /* Unsupported local callback cannot create a target. */ }
				}, done);
				if (typeof result !== "function") { cancelled = true; done(); return; }
				remote = result as () => void;
				if (ended) { remote(); return; }
				lifecycle.register(stop); return stop;
			} catch { stop(); return; }
		},
	};
}
