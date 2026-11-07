import { DiscussionFailure, type DiscussionSender } from "./DiscussionTransport";
import type { DiscussionStore } from "./storage/DiscussionStore";

export type OutboxStatus = "running" | "idle" | "stopped" | "authentication_required" | "protocol_error" | "storage_error";

/** One active request per worker; IndexedDB leases coordinate additional windows.
 * Host calls wake after enqueue/connectivity and resume after credential repair.
 * Suspend/stop before logout, account changes, database closure, or cache removal.
 */
export class DiscussionOutbox {
	private active = false;
	private generation = 0;
	private flight?: Promise<void>;
	private timer?: number;
	private requested = false;
	private notBefore = 0;
	private picturesNotBefore = 0;
	private currentStatus: OutboxStatus = "stopped";

	constructor(private store: DiscussionStore, private sender: DiscussionSender, private owner: string,
		private onStatus: (status: OutboxStatus) => void = () => {},
		private now: () => number = Date.now, private random: () => number = Math.random) {
		if (!owner || owner.length > 512 || ["serverId", "accountId", "shareId"].some(key =>
			store.identity[key as keyof typeof sender.identity] !== sender.identity[key as keyof typeof sender.identity])) {
			throw new Error("Discussion worker identity does not match its local store");
		}
	}

	get status(): OutboxStatus { return this.currentStatus; }
	private statusChanged(status: OutboxStatus): void {
		if (status === this.currentStatus) return;
		this.currentStatus = status;
		try { this.onStatus(status); } catch { /* UI observers cannot alter delivery. */ }
	}

	resume(): void {
		if (!this.active) { this.active = true; this.generation++; }
		this.wake();
	}

	wake(): void {
		if (!this.active) return;
		this.clearTimer(); this.requested = true;
		if (this.flight) return;
		const generation = this.generation;
		this.flight = this.pump(generation).catch(() => {
			if (generation === this.generation) this.pause("storage_error");
		}).finally(() => {
			this.flight = undefined;
			if (this.active && this.requested) this.wake();
		});
	}

	/** Native requestUrl cannot cancel an in-flight POST. Ignore its late result;
	 * a later worker recovers the same immutable operation after the lease expires.
	 */
	stop(): void { this.pause("stopped"); }
	async settled(): Promise<void> {
		// A wake received during the last asynchronous store read starts another
		// pump in finally. Include that pump before allowing a caller to close IDB.
		while (this.flight) await this.flight;
	}
	private pause(status: OutboxStatus): void {
		this.active = false; this.generation++; this.requested = false; this.clearTimer(); this.statusChanged(status);
	}
	private clearTimer(): void { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; }
	private valid(generation: number): boolean { return this.active && generation === this.generation; }

	private async pump(generation: number): Promise<void> {
		this.requested = false;
		this.statusChanged("running");
		for (let count = 0; count < 25 && this.valid(generation) && this.now() >= this.notBefore; count++) {
			const op = await this.store.claimNext(this.owner, this.now(), 30_000, this.picturesNotBefore);
			if (!this.valid(generation)) return;
			if (!op) break;
			try {
				const result = await this.sender.send(op, () => this.valid(generation));
				if (!this.valid(generation)) return;
				await this.store.accept(op.operationId, result);
			} catch (error) {
				if (!this.valid(generation)) return;
				// A local database failure must not be turned into a rejected send.
				if (!(error instanceof DiscussionFailure)) throw error;
				if (error.status === 403 || error.status === 404) await this.store.clearRemoteScope(op.scopeId);
				if (!this.valid(generation)) return;
				const delay = Math.min(60_000, 1000 * 2 ** Math.min(op.attempt - 1, 6)) * (0.8 + this.random() * 0.4);
				const serverDelay = Number.isFinite(error.retryAfterMs) ? Math.min(86400_000, Math.max(0, error.retryAfterMs!)) : 0;
				const retryAt = error.action === "reject" ? undefined : this.now() +
					(error.action === "retry" ? Math.max(delay, serverDelay) : 0);
				await this.store.fail(op.operationId, op.lease!, error.code, retryAt);
				if (!this.valid(generation)) return;
				if (error.action === "authenticate" || error.action === "pause") {
					this.pause(error.action === "authenticate" ? "authentication_required" : "protocol_error"); return;
				}
				if (error.action === "retry") {
					if (op.type === "picture.upload") {
						// Image processing/storage can be busy while ordinary
						// comments remain healthy. Back off all uploads only.
						this.picturesNotBefore = retryAt!; continue;
					}
					// Connectivity, rate limits and server health affect the whole
					// worker. Do not flood it with the rest of an offline backlog.
					this.notBefore = retryAt!; break;
				}
			}
		}
		if (!this.valid(generation)) return;
		const next = await this.store.nextWakeAt(this.picturesNotBefore);
		if (!this.valid(generation)) return;
		this.statusChanged("idle");
		if (next !== undefined) this.timer = window.setTimeout(() => {
			this.timer = undefined; this.wake();
		}, Math.max(0, Math.min(86400_000, Math.max(next, this.notBefore) - this.now())));
	}
}
