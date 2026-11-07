import type { DiscussionSession } from "./DiscussionSession";
import { DiscussionFailure } from "./DiscussionTransport";
import { isRecord, protocolJson } from "./DiscussionProtocol";
import { parseDiscussionScope } from "./DiscussionScope";
import { parseTimelineMarkerCommand, parseTimelineMarkerReceipt, type TimelineMarkerCommand, type TimelineMarkerReceipt } from "./TimelineMarkerManagementProtocol";

// These conflicts cannot become valid later in the same generation: the
// compared revisions only advance, and an operation ID cannot change intent.
// View/axis failures are checked after the receipt and fixed registry revision.
// Repair/reactivation advances that revision, so the old intent cannot later
// become valid after acknowledgement in the same generation.
const finalConflicts = new Set(["stale_base_revision", "timeline_marker_catalog_changed", "timeline_marker_changed", "base_generation_changed", "operation_id_conflict",
	"timeline_axis_changed", "timeline_axis_unavailable", "base_view_unavailable"]);
export type TimelineMarkerManagementState = { version: 1; scope_id: string; request: TimelineMarkerCommand } & (
	{ status: "pending"; error?: string } | { status: "accepted"; receipt: TimelineMarkerReceipt } | { status: "rejected"; error: string }
);
const keyFor = (scopeId: string) => {
	const scope = parseDiscussionScope(scopeId); if (!scope?.viewId) throw new Error("Open a saved view before managing markers.");
	return { key: "timelineMarkerCommand:" + scope.entryId, entryId: scope.entryId };
};
function parseState(value: unknown, entryId: string): TimelineMarkerManagementState | undefined {
	if (value == null) return;
	if (!isRecord(value) || value.version !== 1 || typeof value.scope_id !== "string" || keyFor(value.scope_id).entryId !== entryId ||
		!Object.keys(value).every(key => ["version", "scope_id", "request", "status", "error", "receipt"].includes(key))) throw new Error("Marker save recovery data needs repair.");
	const common = { version: 1 as const, scope_id: value.scope_id, request: parseTimelineMarkerCommand(value.request) };
	if (value.status === "accepted" && value.error === undefined) return { ...common, status: "accepted", receipt: parseTimelineMarkerReceipt(value.receipt, entryId, common.request) };
	if ((value.status === "pending" || value.status === "rejected") && value.receipt === undefined &&
		(value.error === undefined || typeof value.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.error))) {
		if (value.status === "pending") return { ...common, status: "pending", ...(value.error === undefined ? {} : { error: value.error as string }) };
		if (typeof value.error === "string" && finalConflicts.has(value.error)) return { ...common, status: "rejected", error: value.error };
	}
	throw new Error("Marker save recovery data needs repair.");
}

/** Explicit online commands, not background outbox work. One retained intent per
 * base prevents a lost create response from becoming a second promotion. */
export class TimelineMarkerManagement {
	private flights = new Map<string, Promise<TimelineMarkerReceipt>>();
	constructor(private session: DiscussionSession, private changed: (scopeId: string, status: TimelineMarkerManagementState["status"] | "acknowledged") => void) {}
	state(scopeId: string): Promise<TimelineMarkerManagementState | undefined> {
		if (this.session.status === "closed") return Promise.reject(new Error("This discussion account is closed."));
		const { key, entryId } = keyFor(scopeId);
		return this.session.trackLocal(this.session.store.preference(key).then(value => parseState(value, entryId)));
	}
	private authorized(scopeId: string, creating = false): void {
		if (!this.session.online || !this.session.permission(scopeId)?.read || !this.session.permission(scopeId)?.edit) throw new Error("Reconnect with edit permission on this saved view before managing markers.");
		if (creating && !this.session.canAnchorBase("timeline_marker")) throw new Error("Shared marker creation is not enabled.");
	}
	save(scopeId: string, input: TimelineMarkerCommand): Promise<TimelineMarkerReceipt> {
		this.authorized(scopeId, true);
		const request = parseTimelineMarkerCommand(input), { key, entryId } = keyFor(scopeId);
		if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 65536) throw new Error("This marker save exceeds the command limit.");
		return this.session.trackLocal((async () => {
			const raw = await this.session.store.preference(key), previous = parseState(raw, entryId);
			if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error("Review the previous marker save before starting another. Its original intent is retained.");
			if (!previous) {
				const pending: TimelineMarkerManagementState = { version: 1, scope_id: scopeId, request, status: "pending" };
				if (!await this.session.store.comparePreference(key, raw, protocolJson(pending))) throw new Error("Another window started a marker save. Review that save before continuing.");
				this.changed(scopeId, "pending");
			}
			return this.retry(scopeId);
		})());
	}
	retry(scopeId: string): Promise<TimelineMarkerReceipt> {
		this.authorized(scopeId);
		const { key, entryId } = keyFor(scopeId), previous = this.flights.get(key); if (previous) return previous;
		const flight = this.session.trackLocal((async () => {
			const state = parseState(await this.session.store.preference(key), entryId);
			if (!state) throw new Error("There is no saved marker operation to recover.");
			if (state.status === "accepted") return state.receipt;
			if (state.status === "rejected") throw new DiscussionFailure("reject", state.error, 409);
			this.authorized(scopeId);
			try {
				const receipt = parseTimelineMarkerReceipt(await this.session.transport.manageTimelineMarker(scopeId, state.request), entryId, state.request);
				const final = await this.finish(key, entryId, state, { version: 1, scope_id: state.scope_id, request: state.request, status: "accepted", receipt });
				if (final?.status !== "accepted") throw new Error("The save completed, but its local receipt needs recovery. Retry the same operation.");
				return final.receipt;
			} catch (error) {
				const code = error instanceof DiscussionFailure && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : "marker_save_unconfirmed";
				const final = await this.finish(key, entryId, state, { version: 1, scope_id: state.scope_id, request: state.request,
					status: error instanceof DiscussionFailure && error.status === 409 && finalConflicts.has(code) ? "rejected" : "pending", error: code });
				if (final?.status === "accepted") return final.receipt;
				throw error;
			}
		})()).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
		this.flights.set(key, flight); return flight;
	}
	private async finish(key: string, entryId: string, original: TimelineMarkerManagementState, next: TimelineMarkerManagementState): Promise<TimelineMarkerManagementState | undefined> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const raw = await this.session.store.preference(key), current = parseState(raw, entryId);
			if (!current || JSON.stringify(current.request) !== JSON.stringify(original.request)) return;
			if (current.status === "accepted" || current.status === "rejected" && next.status !== "accepted") return current;
			if (await this.session.store.comparePreference(key, raw, protocolJson(next))) { this.changed(next.scope_id, next.status); return next; }
		}
		throw new Error("Another window updated marker recovery. Refresh its status.");
	}
	acknowledge(scopeId: string, operationId: string): Promise<boolean> {
		if (this.session.status === "closed") return Promise.reject(new Error("This discussion account is closed."));
		const { key, entryId } = keyFor(scopeId);
		return this.session.trackLocal((async () => {
			const raw = await this.session.store.preference(key), state = parseState(raw, entryId);
			if (!state || state.request.operation_id !== operationId || state.status === "pending") return false;
			const cleared = await this.session.store.comparePreference(key, raw, null); if (cleared) this.changed(scopeId, "acknowledged"); return cleared;
		})());
	}
}
