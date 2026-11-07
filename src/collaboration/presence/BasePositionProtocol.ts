import { isRecord } from "../DiscussionProtocol";
import { exactFields, locationId, parseLocationTarget, type BaseLocation, type ImagePoint, type LocationTarget } from "./LocationProtocol";
import { parsePresenceGroup, parsePresenceRange, type BasePresenceGroup, type BasePresenceRange } from "./BaseExtendedTargets";

export type BasePresenceProperty = Readonly<{ source: "note" | "file" | "formula"; name: string }>;
export type BasePresenceTarget = Readonly<{ type: "item"; record_id: string; record_generation: string }> |
	Readonly<{ type: "cell"; record_id: string; record_generation: string; property: BasePresenceProperty }> |
	Readonly<{ type: "property"; property: BasePresenceProperty }> | BasePresenceGroup | BasePresenceRange;
export type BasePosition = Readonly<{ target: BasePresenceTarget; offset: ImagePoint }>;
export type BasePresenceState = Readonly<{ version: 1 | 2; pointer: BasePosition | null; viewport: BasePosition | null }>;
export type BasePeerState = Readonly<{ target: LocationTarget; state: BasePresenceState }>;
export type BaseStatesEvent = Readonly<{ scope: BaseLocation | null; status: "available" | "unavailable"; peers: readonly BasePeerState[] }>;
export type BaseRecordContext = Readonly<{ protocol_version: 1; share_id: string; entry_id: string; generation: string; type: "markdown" | "image" | "file" }>;

function requireValue(value: unknown): asserts value { if (!value) throw new Error("Invalid Bases position"); }
function property(value: unknown): BasePresenceProperty {
	requireValue(isRecord(value) && exactFields(value, ["source", "name"]) && (value.source === "note" || value.source === "file" || value.source === "formula") &&
		typeof value.name === "string" && value.name.length > 0 && value.name.length <= 256);
	const points = [...value.name];
	requireValue(points.length <= 128 && new TextEncoder().encode(value.name).length <= 256 && points.every(char => {
		const point = char.codePointAt(0)!; return point >= 32 && (point < 0xd800 || point > 0xdfff);
	}));
	return Object.freeze({ source: value.source, name: value.name });
}
function target(value: unknown): BasePresenceTarget {
	requireValue(isRecord(value));
	if (value.type === "group") return parsePresenceGroup(value, property);
	if (value.type === "timeline_range") return parsePresenceRange(value, property);
	if (value.type === "property") {
		requireValue(exactFields(value, ["type", "property"]));
		return Object.freeze({ type: "property", property: property(value.property) });
	}
	requireValue((value.type === "item" || value.type === "cell") && locationId(value.record_id) && locationId(value.record_generation) &&
		exactFields(value, value.type === "item" ? ["type", "record_id", "record_generation"] : ["type", "record_id", "record_generation", "property"]));
	return value.type === "item" ? Object.freeze({ type: "item", record_id: value.record_id, record_generation: value.record_generation }) :
		Object.freeze({ type: "cell", record_id: value.record_id, record_generation: value.record_generation, property: property(value.property) });
}
function position(value: unknown): BasePosition | null {
	if (value === null) return null;
	requireValue(isRecord(value) && exactFields(value, ["target", "offset"]) && isRecord(value.offset) && exactFields(value.offset, ["x", "y"]));
	const { x, y } = value.offset;
	requireValue(typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 && typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= 1);
	return Object.freeze({ target: target(value.target), offset: Object.freeze({ x, y }) });
}
/** Cell values, paths, selection contents and client identity are never accepted. */
export function parseBaseState(value: unknown): BasePresenceState {
	requireValue(isRecord(value) && exactFields(value, ["version", "pointer", "viewport"]) && (value.version === 1 || value.version === 2));
	const result = Object.freeze({ version: value.version, pointer: position(value.pointer), viewport: position(value.viewport) });
	requireValue((result.version === 2 || [result.pointer, result.viewport].every(item => !item || !["group", "timeline_range"].includes(item.target.type))) &&
		new TextEncoder().encode(JSON.stringify(result)).length <= 3072);
	return result;
}
/** Older receivers retain supported positions; an unknown target never becomes
 * an approximate record position or breaks their entire presence connection. */
export function baseStateForVersion(state: BasePresenceState, version: 1 | 2): BasePresenceState {
	if (version === 2) return state;
	const supported = (position: BasePosition | null) => position && !["group", "timeline_range"].includes(position.target.type) ? position : null;
	return Object.freeze({ version: 1, pointer: supported(state.pointer), viewport: supported(state.viewport) });
}
export function parseBasePeers(value: unknown): readonly BasePeerState[] {
	requireValue(Array.isArray(value) && value.length <= 127);
	const keys = new Set<string>();
	return Object.freeze(value.map((item: unknown) => {
		requireValue(isRecord(item) && exactFields(item, ["target", "state"]));
		const person = parseLocationTarget(item.target), key = JSON.stringify(person);
		requireValue(!keys.has(key)); keys.add(key);
		return Object.freeze({ target: person, state: parseBaseState(item.state) });
	}));
}
export function parseBaseRecordContext(value: unknown, shareId: string, entryId: string): BaseRecordContext {
	requireValue(isRecord(value) && exactFields(value, ["protocol_version", "share_id", "entry_id", "generation", "type"]) &&
		value.protocol_version === 1 && locationId(shareId) && value.share_id === shareId && locationId(entryId) && value.entry_id === entryId && locationId(value.generation) &&
		(value.type === "markdown" || value.type === "image" || value.type === "file"));
	return Object.freeze({ protocol_version: 1, share_id: shareId, entry_id: entryId, generation: value.generation, type: value.type });
}
