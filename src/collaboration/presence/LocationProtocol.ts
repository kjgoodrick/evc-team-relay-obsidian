import { isRecord } from "../DiscussionProtocol";

export const locationId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const publicSessionId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
export type NoteLocation = Readonly<{ kind: "note"; share_id: string; entry_id: string; surface: "editor" | "reading" }>;
export type ImageLocation = Readonly<{ kind: "image"; share_id: string; entry_id: string; generation: string; content_sha256: string }>;
export type BaseLocation = Readonly<{ kind: "base"; share_id: string; entry_id: string; generation: string; definition_id: string; view_id: string; registry_revision: number }>;
export type NonNoteLocation = ImageLocation | BaseLocation;
export type SurfaceLocation = NoteLocation | NonNoteLocation;
export type LocationTarget = Readonly<{ user_id: string; session_id: string; instance_id: string }>;
export type LocationEvent = { subscriptionId: string; location: SurfaceLocation | null };
export type NoteLocationEvent = { subscriptionId: string; location: NoteLocation | null };
export type SurfacePeer = Readonly<{ target: LocationTarget; name: string }>;
export type SurfaceRosterEvent = Readonly<{ scope: NonNoteLocation | null; status: "available" | "unavailable"; peers: readonly SurfacePeer[] }>;
export type ImagePoint = Readonly<{ x: number; y: number }>;
export type ImageViewport = ImagePoint & Readonly<{ width: number; height: number }>;
export type ImagePresenceState = Readonly<{ pointer: ImagePoint | null; viewport: ImageViewport | null }>;
export type ImagePeerState = Readonly<{ target: LocationTarget; state: ImagePresenceState }>;
export type ImageStatesEvent = Readonly<{ scope: ImageLocation | null; status: "available" | "unavailable"; peers: readonly ImagePeerState[] }>;

const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
export function parseImageState(value: unknown): ImagePresenceState {
	if (!isRecord(value) || !exactFields(value, ["pointer", "viewport"])) throw new Error("Invalid image state");
	const point = (item: unknown, viewport: boolean): ImagePoint | ImageViewport | null => {
		if (item === null) return null;
		if (!isRecord(item) || !exactFields(item, viewport ? ["x", "y", "width", "height"] : ["x", "y"]) || !unit(item.x) || !unit(item.y)) throw new Error("Invalid image point");
		if (!viewport) return Object.freeze({ x: item.x, y: item.y });
		if (!unit(item.width) || !unit(item.height) || item.width === 0 || item.height === 0 || item.x + item.width > 1 || item.y + item.height > 1) throw new Error("Invalid image viewport");
		return Object.freeze({ x: item.x, y: item.y, width: item.width, height: item.height });
	};
	return Object.freeze({ pointer: point(value.pointer, false), viewport: point(value.viewport, true) as ImageViewport | null });
}
export function parseImagePeers(value: unknown): readonly ImagePeerState[] {
	if (!Array.isArray(value) || value.length > 127) throw new Error("Invalid image participants");
	const keys = new Set<string>();
	return Object.freeze(value.map((item: unknown) => {
		if (!isRecord(item) || !exactFields(item, ["target", "state"])) throw new Error("Invalid image participant");
		const target = parseLocationTarget(item.target), key = JSON.stringify(target);
		if (keys.has(key)) throw new Error("Duplicate image participant"); keys.add(key);
		return Object.freeze({ target, state: parseImageState(item.state) });
	}));
}

export function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
export function parseNoteLocation(value: unknown): NoteLocation {
	if (!isRecord(value) || !exactFields(value, ["kind", "share_id", "entry_id", "surface"]) || value.kind !== "note" ||
		!locationId(value.share_id) || !locationId(value.entry_id) || !["editor", "reading"].includes(String(value.surface))) throw new Error("Invalid location");
	return Object.freeze({ kind: "note", share_id: value.share_id, entry_id: value.entry_id, surface: value.surface as NoteLocation["surface"] });
}
export function parseSurfaceLocation(value: unknown): SurfaceLocation {
	if (isRecord(value) && value.kind === "note") return parseNoteLocation(value);
	if (!isRecord(value) || !locationId(value.share_id) || !locationId(value.entry_id) || !locationId(value.generation)) throw new Error("Invalid location");
	if (value.kind === "image" && exactFields(value, ["kind", "share_id", "entry_id", "generation", "content_sha256"]) &&
		typeof value.content_sha256 === "string" && /^[0-9a-f]{64}$/.test(value.content_sha256)) return Object.freeze({
		kind: "image", share_id: value.share_id, entry_id: value.entry_id, generation: value.generation, content_sha256: value.content_sha256,
	});
	if (value.kind === "base" && exactFields(value, ["kind", "share_id", "entry_id", "generation", "definition_id", "view_id", "registry_revision"]) &&
		locationId(value.definition_id) && locationId(value.view_id) && typeof value.registry_revision === "number" && Number.isSafeInteger(value.registry_revision) && value.registry_revision > 0) return Object.freeze({
		kind: "base", share_id: value.share_id, entry_id: value.entry_id, generation: value.generation, definition_id: value.definition_id,
		view_id: value.view_id, registry_revision: value.registry_revision,
	});
	throw new Error("Invalid location");
}
export function parseLocationTarget(value: unknown): LocationTarget {
	if (!isRecord(value) || !exactFields(value, ["user_id", "session_id", "instance_id"]) ||
		!locationId(value.user_id) || !locationId(value.instance_id) || !publicSessionId(value.session_id)) throw new Error("Invalid participant");
	return Object.freeze({ user_id: value.user_id, session_id: value.session_id, instance_id: value.instance_id });
}
export function parseSurfacePeers(value: unknown): readonly SurfacePeer[] {
	if (!Array.isArray(value) || value.length > 127) throw new Error("Invalid participants");
	const keys = new Set<string>();
	return Object.freeze(value.map((item: unknown) => {
		if (!isRecord(item) || !exactFields(item, ["target", "name"]) || typeof item.name !== "string" || !item.name.trim() || [...item.name].length > 255 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(item.name)) throw new Error("Invalid participant"); // eslint-disable-line no-control-regex
		const target = parseLocationTarget(item.target), key = JSON.stringify(target);
		if (keys.has(key)) throw new Error("Duplicate participant"); keys.add(key);
		return Object.freeze({ target, name: item.name });
	}));
}
export const sameNote = (a?: NoteLocation | null, b?: NoteLocation | null): boolean => !!a && !!b && a.share_id === b.share_id && a.entry_id === b.entry_id;
