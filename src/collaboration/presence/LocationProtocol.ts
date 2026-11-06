import { isRecord } from "../DiscussionProtocol";

export const locationId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const publicSessionId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
export type NoteLocation = Readonly<{ kind: "note"; share_id: string; entry_id: string; surface: "editor" | "reading" }>;
export type LocationTarget = Readonly<{ user_id: string; session_id: string; instance_id: string }>;
export type LocationEvent = { subscriptionId: string; location: NoteLocation | null };

export function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
	return Object.keys(value).length === fields.length && fields.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
export function parseNoteLocation(value: unknown): NoteLocation {
	if (!isRecord(value) || !exactFields(value, ["kind", "share_id", "entry_id", "surface"]) || value.kind !== "note" ||
		!locationId(value.share_id) || !locationId(value.entry_id) || !["editor", "reading"].includes(String(value.surface))) throw new Error("Invalid location");
	return Object.freeze({ kind: "note", share_id: value.share_id, entry_id: value.entry_id, surface: value.surface as NoteLocation["surface"] });
}
export function parseLocationTarget(value: unknown): LocationTarget {
	if (!isRecord(value) || !exactFields(value, ["user_id", "session_id", "instance_id"]) ||
		!locationId(value.user_id) || !locationId(value.instance_id) || !publicSessionId(value.session_id)) throw new Error("Invalid participant");
	return Object.freeze({ user_id: value.user_id, session_id: value.session_id, instance_id: value.instance_id });
}
export const sameNote = (a?: NoteLocation | null, b?: NoteLocation | null): boolean => !!a && !!b && a.share_id === b.share_id && a.entry_id === b.entry_id;
