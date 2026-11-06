import type { Awareness } from "y-protocols/awareness";
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

export type PresenceAvailability = "ready" | "recovering" | "capacity" | "unavailable";
const INTERVAL = 100;
const MAX_COLLISIONS = 3;

/** Owns transient publication only. Recovery never changes Y.Doc.clientID or
 * document contents. One replaceable timer holds the latest local state. */
export class AwarenessPublisher {
	availability: PresenceAvailability = "ready";
	private published = false;
	private lastSent = -Infinity;
	private pending?: number;
	private retryTimer?: number;
	private collisions = 0;
	private capacityAttempts = 0;
	private stopped = false;
	private rotating = false;
	private lastCursor: unknown;
	private onUpdate = (changed: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
		if (this.rotating || origin === this || !changed.added.concat(changed.updated, changed.removed).includes(this.awareness.clientID)) return;
		const state = this.awareness.getLocalState(), cursor = state?.cursor;
		const leaving = state === null || this.lastCursor != null && cursor == null;
		this.lastCursor = cursor;
		this.publish(leaving);
	};
	constructor(readonly awareness: Awareness, private canSend: () => boolean,
		private send: (frame: Uint8Array) => void, private changed: (value: PresenceAvailability) => void,
		private randomId = () => {
			const words = crypto.getRandomValues(new Uint32Array(2));
			return (words[0] & 0x1fffff) * 0x100000000 + words[1];
		}) { awareness.on("update", this.onUpdate); }

	get allowed(): boolean { return !this.stopped && (this.availability === "ready" || this.availability === "recovering"); }
	private status(value: PresenceAvailability) {
		if (this.availability === value) return;
		this.availability = value; this.changed(value);
	}
	private cancelPending() { if (this.pending !== undefined) window.clearTimeout(this.pending); this.pending = undefined; }
	private cancelRetry() { if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer); this.retryTimer = undefined; }

	connected(): void {
		this.published = false; this.lastSent = -Infinity; this.cancelPending();
		if (this.allowed && this.awareness.getLocalState() !== null) {
			// A fresh clock supersedes the previous connection's tombstone.
			this.awareness.setLocalState(this.awareness.getLocalState());
		}
		if (this.availability === "capacity") this.scheduleCapacityRetry();
	}

	disconnected(code?: number): void {
		this.cancelPending(); this.cancelRetry(); this.published = false;
		if (code === 4409) {
			if (++this.collisions <= MAX_COLLISIONS && this.rotate()) this.status("recovering");
			else this.status("unavailable");
		} else if (code === 4429) {
			this.capacityAttempts++; this.status("capacity");
		} else if (code === 4400) this.status("unavailable");
	}

	private rotate(): boolean {
		const previous = this.awareness.clientID, state = this.awareness.getLocalState();
		let next: number | undefined;
		for (let attempt = 0; attempt < 8; attempt++) {
			const candidate = this.randomId();
			if (Number.isSafeInteger(candidate) && candidate >= 0 && candidate !== previous && !this.awareness.meta.has(candidate)) { next = candidate; break; }
		}
		if (next === undefined) return false;
		this.rotating = true;
		try {
			removeAwarenessStates(this.awareness, [previous], this);
			this.awareness.meta.delete(previous);
			this.awareness.clientID = next;
			// Restoring state must not publish through a still-open local channel.
			if (state !== null) this.awareness.setLocalState(state);
		} finally { this.rotating = false; }
		return true;
	}

	private scheduleCapacityRetry(): void {
		if (this.retryTimer !== undefined || this.stopped) return;
		const delay = Math.min(120000, 30000 * 2 ** Math.min(this.capacityAttempts - 1, 2));
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = undefined;
			if (!this.canSend() || this.stopped) return;
			this.status("recovering");
			if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(this.awareness.getLocalState());
		}, delay);
	}

	/** Explicit user/controller retry after inspecting an unavailable state. */
	retry(): void {
		if (this.stopped) return;
		this.collisions = 0; this.capacityAttempts = 0; this.cancelRetry(); this.status("ready");
		if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(this.awareness.getLocalState());
	}

	/** Lifecycle transitions can flush immediately; ordinary cursor changes are
	 * leading/trailing coalesced without dropping the final selection. */
	publish(immediate = false): void {
		if (!this.allowed || !this.canSend()) { this.cancelPending(); return; }
		if (this.awareness.getLocalState() === null && !this.published) { this.cancelPending(); return; }
		const remaining = INTERVAL - (Date.now() - this.lastSent);
		if (!immediate && remaining > 0) {
			if (this.pending === undefined) this.pending = window.setTimeout(() => { this.pending = undefined; this.publish(true); }, remaining);
			return;
		}
		this.cancelPending(); this.lastSent = Date.now();
		const frame = encoding.createEncoder(); encoding.writeVarUint(frame, 1);
		encoding.writeVarUint8Array(frame, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
		this.send(encoding.toUint8Array(frame)); this.published = true;
	}

	/** Initial room state can contain a colliding ID. It must never replace this
	 * client's local identity/selection before recovery chooses a new ID. */
	receive(data: Uint8Array): void {
		if (data.byteLength > 1024 * 1024) throw new Error("Invalid awareness response");
		const input = decoding.createDecoder(data), count = decoding.readVarUint(input);
		if (count > 256) throw new Error("Invalid awareness response");
		const peers: { id: number; clock: number; state: string }[] = [];
		for (let i = 0; i < count; i++) {
			const id = decoding.readVarUint(input), clock = decoding.readVarUint(input), state = decoding.readVarString(input);
			if (id !== this.awareness.clientID) peers.push({ id, clock, state });
			else if (this.published && this.awareness.meta.get(id)?.clock === clock && state !== "null") {
				this.capacityAttempts = 0;
				this.status("ready");
			}
		}
		if (decoding.hasContent(input)) throw new Error("Trailing awareness response data");
		const output = encoding.createEncoder(); encoding.writeVarUint(output, peers.length);
		for (const peer of peers) { encoding.writeVarUint(output, peer.id); encoding.writeVarUint(output, peer.clock); encoding.writeVarString(output, peer.state); }
		applyAwarenessUpdate(this.awareness, encoding.toUint8Array(output), this);
	}

	destroy(): void { this.stopped = true; this.cancelPending(); this.cancelRetry(); this.awareness.off("update", this.onUpdate); }
}
