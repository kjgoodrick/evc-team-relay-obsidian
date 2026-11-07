import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { safeAvatarUrl } from "../../presenceAvatar";
import type { NotePresenceSurface } from "./PresenceSettings";
import type { NonNoteLocation, ImagePresenceState } from "./LocationProtocol";
import type { BasePresenceState } from "./BasePositionProtocol";

export type PresenceRange = { anchor: Y.RelativePosition; head: Y.RelativePosition };
export type PresenceLocation = { viewport?: Y.RelativePosition | null; selection?: PresenceRange | null };
export type PresencePeer = PresenceLocation & {
	key: string; clientId: number; userId: string; sessionId: string; name: string;
	avatarUrl?: string; surface: NotePresenceSurface; cursor?: PresenceRange | null;
	instanceId?: string;
};
export type SurfacePresencePeer = { key: string; userId: string; sessionId: string; instanceId: string; name: string; surface: "image" | "base"; location: NonNoteLocation; imageState?: ImagePresenceState; baseState?: BasePresenceState };
export type ActivePresencePeer = PresencePeer | SurfacePresencePeer;
export const isNotePeer = (peer: ActivePresencePeer): peer is PresencePeer => peer.surface === "editor" || peer.surface === "reading";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function presencePosition(value: unknown): value is Y.RelativePosition {
	if (!object(value) || Object.keys(value).some(key => !["type", "tname", "item", "assoc"].includes(key)) ||
		value.tname !== "contents" || value.type != null || value.assoc !== undefined && ![-1, 0, 1].includes(value.assoc as number)) return false;
	return value.item == null || object(value.item) && Object.keys(value.item).length === 2 && integer(value.item.client) && integer(value.item.clock);
}
export function presenceRange(value: unknown): value is PresenceRange {
	return object(value) && Object.keys(value).length === 2 && presencePosition(value.anchor) && presencePosition(value.head);
}

/** These fields are stamped by the managed gateway. Unknown/legacy identity
 * cannot become a follow target. No path, email or opaque session ID is shown. */
export function presencePeers(awareness: Awareness): PresencePeer[] {
	const peers: PresencePeer[] = [];
	for (const [clientId, raw] of awareness.getStates()) {
		if (peers.length === 128) break;
		if (clientId === awareness.clientID || !integer(clientId) || !object(raw) || !object(raw.user)) continue;
		const { id, name } = raw.user, sessionId = raw.sessionId;
		if (typeof id !== "string" || !id.length || id.length > 128 || typeof name !== "string" || !name.trim() || [...name].length > 255 ||
			typeof sessionId !== "string" || !/^[0-9a-f]{32}$/.test(sessionId) || ![undefined, "editor", "reading"].includes(raw.surface as NotePresenceSurface)) continue;
		peers.push({ key: JSON.stringify([id, sessionId, clientId]), userId: id, sessionId, clientId, name,
			instanceId: typeof raw.instanceId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(raw.instanceId) ? raw.instanceId : undefined,
			avatarUrl: safeAvatarUrl(raw.user.avatarUrl), surface: raw.surface === "reading" ? "reading" : "editor",
			cursor: raw.surface !== "reading" && presenceRange(raw.cursor) ? raw.cursor : null,
			selection: raw.surface === "reading" && presenceRange(raw.selection) ? raw.selection : null,
			viewport: presencePosition(raw.viewport) ? raw.viewport : null });
	}
	return peers.sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId) || a.sessionId.localeCompare(b.sessionId) || a.clientId - b.clientId);
}

export function resolvePresenceRange(target: PresenceRange, text: Y.Text): { anchor: number; head: number } | undefined {
	if (!text.doc) return;
	try {
		const anchor = Y.createAbsolutePositionFromRelativePosition(target.anchor, text.doc), head = Y.createAbsolutePositionFromRelativePosition(target.head, text.doc);
		if (!anchor || !head || anchor.type !== text || head.type !== text || anchor.index < 0 || head.index < 0 || anchor.index > text.length || head.index > text.length) return;
		return { anchor: anchor.index, head: head.index };
	} catch { return; }
}

export function peerLocation(peer: PresencePeer, text: Y.Text, follow: boolean): { from: number; to: number } | undefined {
	const selection = peer.surface === "reading" ? peer.selection : peer.cursor;
	const target = follow && peer.viewport ? { anchor: peer.viewport, head: peer.viewport } : selection ??
		(peer.viewport ? { anchor: peer.viewport, head: peer.viewport } : undefined);
	const resolved = target && resolvePresenceRange(target, text);
	return resolved ? { from: Math.min(resolved.anchor, resolved.head), to: Math.max(resolved.anchor, resolved.head) } : undefined;
}
