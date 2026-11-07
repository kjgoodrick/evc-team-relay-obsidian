import { v4 as uuid } from "uuid";
import { DiscussionFailure, type DiscussionTransport } from "./DiscussionTransport";
import { inboxScope, parseInboxChange, parseInboxItem, type InboxChange, type InboxItem, type InboxSubscription } from "./InboxProtocol";
import { DiscussionStore } from "./storage/DiscussionStore";
import { emptyInbox, forgetInboxScope, INBOX_CACHE_LIMIT, INBOX_QUEUE_LIMIT, overlayInbox, type InboxLocalState, type InboxOperation } from "./storage/InboxRecords";

type Mode = "online" | "offline" | "blocked";
export type InboxStatus = "starting" | "ready" | "refreshing" | "offline" | "disabled" | "authentication_required" | "error" | "closed";
type Transport = Pick<DiscussionTransport, "inbox" | "changeInbox" | "inboxSubscription">;

/** Account/share-scoped inbox. Network work and multiwindow delivery share one
 * expiring IDB lease. No content is broadcast; the other window rereads storage. */
export class DiscussionInbox {
	private state = emptyInbox();
	private listeners = new Set<() => void>();
	private statusValue: InboxStatus = "starting";
	private enabled = false;
	private foreground = true;
	private mode: Mode = "blocked";
	private closed = false;
	private generation = 0;
	private timer?: number;
	private flight?: Promise<void>;
	private saves = new Set<Promise<unknown>>();
	private rerun = false;
	private more = false;
	private loading?: Promise<void>;
	private hiddenScopes = new Set<string>();
	private subscriptionChain: Promise<unknown> = Promise.resolve();
	private subscriptionFlights = new Map<string, Promise<void>>();
	constructor(private store: DiscussionStore, private transport: Transport, private changed: (broadcast: boolean) => void = () => {}) {}
	get status(): InboxStatus { return this.statusValue; }
	get available(): boolean { return !this.closed && this.enabled && this.mode !== "blocked"; }
	get items(): InboxItem[] { return this.available ? this.state.items.filter(item => !this.hiddenScopes.has(inboxScope(item))).map(item => overlayInbox(item, this.state.operations)) : []; }
	get pending(): InboxOperation[] { return this.closed ? [] : this.state.operations.map(op => ({ ...op, change: { ...op.change } })); }
	get hasMore(): boolean { return this.available && this.state.nextCursor !== null; }
	get viewingOlder(): boolean { return this.available && this.state.startCursor !== null; }
	get checkedAt(): number { return this.state.checkedAt; }
	subscription(scopeId: string, threadId: string): InboxSubscription | undefined {
		if (!this.available || this.hiddenScopes.has(scopeId)) return;
		const stored = this.state.subscriptions.find(row => row.scopeId === scopeId && row.threadId === threadId)?.value;
		const item = this.state.items.find(item => inboxScope(item) === scopeId && item.thread_id === threadId)?.subscription;
		let result = item && (!stored || item.version >= stored.version) ? { ...item } : stored ? { ...stored } : undefined;
		for (const op of this.state.operations) if (op.scopeId === scopeId && op.threadId === threadId && op.state === "queued" && op.change.type === "subscription") {
			result = { version: op.change.expected_version + 1, following: op.change.following, muted: op.change.muted };
		}
		return result;
	}
	loadSubscription(scopeId: string, threadId: string): Promise<void> {
		if (!this.runnable()) return Promise.resolve();
		const key = scopeId + "/" + threadId, existing = this.subscriptionFlights.get(key); if (existing) return existing;
		const generation = this.generation;
		const current = () => this.runnable() && this.generation === generation && !this.hiddenScopes.has(scopeId);
		const job = this.save(this.subscriptionChain.catch(() => {}).then(async () => {
			if (!current()) return;
			const before = await this.store.inboxState(); if (!current()) return;
			const value = await this.transport.inboxSubscription(scopeId, threadId);
			if (!current()) return;
			this.adopt(await this.store.updateInbox(state => {
				if (!current() || state.epoch !== before.epoch) return;
				const previous = state.subscriptions.find(row => row.threadId === threadId);
				if (previous && previous.value.version > value.version) return;
				state.subscriptions = [...state.subscriptions.filter(row => row.threadId !== threadId), { scopeId, threadId, value }].slice(-500);
			}), true);
		}).catch(async error => {
			if (current() && error instanceof DiscussionFailure && (error.action === "authenticate" || [403, 404].includes(error.status))) {
				if (error.action === "authenticate") { this.mode = "blocked"; this.statusValue = "authentication_required"; }
				await this.forgetScope(error.action === "authenticate" ? undefined : scopeId);
			}
			throw error;
		}).finally(() => this.subscriptionFlights.delete(key)));
		this.subscriptionFlights.set(key, job); this.subscriptionChain = job; return job;
	}
	async queueSubscription(scopeId: string, threadId: string, value: InboxSubscription, following: boolean, muted: boolean): Promise<void> {
		if (!this.available) throw new Error("The inbox is unavailable for this account.");
		const change = parseInboxChange({ type: "subscription", expected_version: value.version, following, muted });
		const id = uuid();
		this.adopt(await this.save(this.store.updateInbox(state => {
			const known = state.subscriptions.some(row => row.scopeId === scopeId && row.threadId === threadId) ||
				state.items.some(row => inboxScope(row) === scopeId && row.thread_id === threadId);
			if (this.closed || !this.available || this.hiddenScopes.has(scopeId) || !known) throw new Error("Refresh this discussion’s notification preferences first.");
			if (state.operations.length >= INBOX_QUEUE_LIMIT || state.operations.some(op => op.threadId === threadId && op.state === "rejected")) throw new Error("Review pending changes in the comment inbox first.");
			state.operations.push({ id, scopeId, threadId, change, state: "queued", attempted: false });
		})), true); this.wake();
	}
	onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	private notify(broadcast = false): void {
		if (this.closed) return;
		for (const fn of this.listeners) { try { fn(); } catch { /* UI errors cannot change delivery. */ } }
		this.changed(broadcast);
	}
	private adopt(state: InboxLocalState, broadcast = false): void {
		if (!this.closed && state.revision >= this.state.revision) { this.state = state; this.notify(broadcast); }
	}
	private save<T>(promise: Promise<T>): Promise<T> {
		this.saves.add(promise); void promise.finally(() => this.saves.delete(promise)).catch(() => {}); return promise;
	}
	async reload(): Promise<void> {
		if (this.closed) return;
		try { this.adopt(await this.save(this.store.inboxState())); }
		catch { if (!this.closed) { this.statusValue = "error"; this.notify(); } }
	}
	async configure(enabled: boolean, mode: Mode, foreground: boolean): Promise<void> {
		if (this.closed) return;
		const changed = enabled !== this.enabled || mode !== this.mode || foreground !== this.foreground;
		this.enabled = enabled; this.mode = mode; this.foreground = foreground;
		if (changed) { this.generation++; this.clearTimer(); }
		const generation = this.generation;
		if (!this.loading) this.loading = this.reload();
		await this.loading;
		if (this.closed || generation !== this.generation) return;
		if (!enabled || mode === "blocked") {
			this.statusValue = !enabled ? "disabled" : "authentication_required";
			if (changed) { this.state.items = []; this.adopt(await this.save(this.store.updateInbox(state => forgetInboxScope(state))), true); }
			this.notify(); return;
		}
		this.statusValue = mode === "offline" ? "offline" : "ready";
		this.notify(); if (foreground && mode === "online") this.wake();
	}
	setForeground(foreground: boolean): void {
		if (this.closed || foreground === this.foreground) return;
		this.foreground = foreground; this.generation++; this.clearTimer();
		if (foreground) this.wake();
	}
	private clearTimer(): void { if (this.timer !== undefined) window.clearTimeout(this.timer); this.timer = undefined; }
	private runnable(): boolean { return !this.closed && this.enabled && this.foreground && this.mode === "online"; }
	wake(): void {
		if (!this.runnable()) return;
		if (this.flight) { this.rerun = true; return; }
		this.clearTimer();
		this.flight = this.run().catch(() => { if (!this.closed) { this.statusValue = "error"; this.notify(); } }).finally(() => {
			this.flight = undefined;
			if (this.runnable()) {
				const delay = Math.max(this.rerun ? 0 : 30_000, this.state.retryAt - Date.now()); this.rerun = false;
				this.timer = window.setTimeout(() => { this.timer = undefined; this.wake(); }, delay);
			}
		});
	}
	loadMore(): void { if (this.hasMore && this.runnable()) { this.more = true; this.wake(); } }
	async latest(): Promise<void> {
		if (!this.runnable()) return;
		this.generation++; this.more = false;
		this.adopt(await this.save(this.store.updateInbox(state => {
			state.epoch++; state.startCursor = null; state.nextCursor = null; state.items = []; state.checkedAt = 0;
		})), true); this.wake();
	}
	async queue(item: InboxItem, change: InboxChange): Promise<void> {
		if (!this.available) throw new Error("The inbox is unavailable for this account.");
		item = parseInboxItem(item); change = parseInboxChange(change);
		const scopeId = inboxScope(item), id = uuid();
		const state = await this.save(this.store.updateInbox(state => {
			if (this.closed || !this.available) throw new Error("The inbox account changed.");
			const known = state.items.find(row => row.thread_id === item.thread_id && inboxScope(row) === scopeId);
			if (!known || this.hiddenScopes.has(scopeId)) throw new Error("Refresh this notification before changing it.");
			if (state.operations.some(op => op.threadId === item.thread_id && op.state === "rejected")) throw new Error("Review this discussion’s rejected inbox change first.");
			if (state.operations.length >= INBOX_QUEUE_LIMIT) throw new Error("Review pending inbox changes before adding more.");
			if (change.type === "state" && change.seen_version !== item.version) throw new Error("The read version changed.");
			state.operations.push({ id, scopeId, threadId: item.thread_id, change, state: "queued", attempted: false });
		}));
		this.adopt(state, true); this.wake();
	}
	async discard(id: string): Promise<void> {
		if (this.closed) return;
		const state = await this.save(this.store.updateInbox(state => {
			const op = state.operations.find(op => op.id === id);
			if (!op || op.state !== "rejected") throw new Error("Only a confirmed rejected change can be discarded.");
			state.operations = state.operations.filter(op => op.id !== id);
		}));
		this.adopt(state, true); this.wake();
	}
	async forgetScope(scopeId?: string): Promise<void> {
		if (this.closed) return;
		if (scopeId) this.hiddenScopes.add(scopeId); else this.state.items = [];
		this.generation++; this.notify();
		try { this.adopt(await this.save(this.store.updateInbox(state => forgetInboxScope(state, scopeId))), true); }
		finally { if (scopeId) this.hiddenScopes.delete(scopeId); }
		this.wake();
	}
	private async run(): Promise<void> {
		const generation = this.generation, token = uuid(), current = () => this.runnable() && this.generation === generation;
		let epoch = -1, claimed = false;
		const owns = (state: InboxLocalState) => current() && state.epoch === epoch && state.lease?.token === token && state.lease.expiresAt > Date.now();
		try {
			const initial = await this.store.updateInbox(state => {
				if (!current() || state.retryAt > Date.now() || state.lease && state.lease.expiresAt > Date.now()) return;
				state.lease = { token, expiresAt: Date.now() + 60_000 }; epoch = state.epoch; claimed = true;
			});
			this.adopt(initial); if (!claimed || !current()) return;
			this.statusValue = "refreshing"; this.notify();
			const more = this.more && initial.nextCursor !== null;
			const cursor = more ? initial.nextCursor : initial.startCursor; this.more = false;
			let page = await this.transport.inbox(cursor);
			const pages = new Map(page.items.map(item => [item.thread_id, item]));
			// Reauthorize the loaded window instead of discarding older pages on
			// every foreground poll. Work remains bounded by the cache budget.
			for (let count = 1; !more && count < Math.ceil(initial.items.length / 50) && page.next_cursor && current(); count++) {
				const renewed = await this.store.updateInbox(state => { if (owns(state)) state.lease!.expiresAt = Date.now() + 60_000; });
				if (!owns(renewed)) return;
				page = await this.transport.inbox(page.next_cursor);
				for (const item of page.items) if (!pages.has(item.thread_id)) pages.set(item.thread_id, item);
			}
			page = { items: [...pages.values()], next_cursor: page.next_cursor };
			const refreshed = await this.store.updateInbox(state => {
				if (!owns(state)) return;
				let items = more ? [...state.items.filter(item => !page.items.some(next => next.thread_id === item.thread_id)), ...page.items] : page.items;
				// Start an explicit older window at the budget boundary. Its cursor
				// survives refresh/restart; no fetched entries disappear silently.
				if (items.length > INBOX_CACHE_LIMIT) { items = page.items; state.startCursor = cursor; }
				state.items = items.sort((a, b) => b.last_sequence - a.last_sequence);
				state.nextCursor = page.next_cursor; state.checkedAt = Date.now();
				state.retryAt = 0;
				state.lease!.expiresAt = Date.now() + 60_000;
			});
			if (!owns(refreshed)) return; this.adopt(refreshed, true);
			const deadline = Date.now() + 5000;
			for (let i = 0; i < 10 && current() && Date.now() < deadline; i++) {
				let operation: InboxOperation | undefined;
				const selected = await this.store.updateInbox(state => {
					if (!owns(state)) return;
					const blocked = new Set<string>();
					for (const op of state.operations) {
						if (op.state === "rejected") { blocked.add(op.threadId); continue; }
						if (blocked.has(op.threadId)) continue;
						op.attempted = true; operation = { ...op, change: { ...op.change } }; break;
					}
					state.lease!.expiresAt = Date.now() + 60_000;
				});
				if (!owns(selected) || !operation) break;
				const op = operation;
				try {
					const result = await this.transport.changeInbox(op.scopeId, op.threadId, op.change);
					const saved = await this.store.updateInbox(state => {
						if (!owns(state)) return;
						state.operations = state.operations.filter(item => item.id !== op.id);
						const item = state.items.find(item => item.thread_id === op.threadId && inboxScope(item) === op.scopeId);
						if ("following" in result) {
							const saved = state.subscriptions.find(row => row.threadId === op.threadId && row.scopeId === op.scopeId);
							if (saved && saved.value.version <= result.version) saved.value = result;
						}
						if (!item) return;
						if ("following" in result) { if (result.version >= item.subscription.version) item.subscription = result; }
						else if (result.version === item.version) Object.assign(item, result);
						// Never adopt a newer unseen notification version from a read
						// acknowledgment. Fetch its message reference before marking it.
					});
					this.adopt(saved, true); this.rerun = true;
				} catch (error) {
					if (!(error instanceof DiscussionFailure) || error.action !== "reject") throw error;
					this.adopt(await this.store.updateInbox(state => {
						if (!owns(state)) return;
						const row = state.operations.find(row => row.id === op.id);
						if (row) { row.state = "rejected"; row.error = error.code; }
						let after = false;
						for (const dependent of state.operations) {
							if (dependent.id === op.id) { after = true; continue; }
							if (after && dependent.threadId === op.threadId) { dependent.state = "rejected"; dependent.error = "prior_change_rejected"; }
						}
						if ([403, 404].includes(error.status)) state.items = state.items.filter(item => item.thread_id !== op.threadId);
					}), true);
				}
			}
			if (current()) { this.statusValue = "ready"; this.notify(); }
		} catch (error) {
			if (!current()) return;
			if (error instanceof DiscussionFailure && error.code === "inbox_cursor_reset") {
				this.more = false; this.rerun = true;
				this.adopt(await this.store.updateInbox(state => {
					if (owns(state)) { state.startCursor = null; state.nextCursor = null; state.items = []; state.checkedAt = 0; }
				}), true);
			}
			else if (error instanceof DiscussionFailure && error.action === "retry") {
				this.statusValue = "offline";
				this.adopt(await this.store.updateInbox(state => { if (owns(state)) state.retryAt = Date.now() + Math.max(30_000, error.retryAfterMs ?? 0); }), true);
			}
			else if (error instanceof DiscussionFailure && (error.action === "authenticate" || [403, 404].includes(error.status))) {
				this.statusValue = error.action === "authenticate" ? "authentication_required" : "disabled";
				this.mode = "blocked"; this.state.items = [];
				this.adopt(await this.store.updateInbox(state => forgetInboxScope(state)), true);
			} else { this.statusValue = "error"; this.mode = "blocked"; }
			this.notify();
		} finally {
			if (claimed) await this.store.updateInbox(state => { if (state.lease?.token === token) delete state.lease; });
		}
	}
	async settled(): Promise<void> { await Promise.allSettled([this.flight, this.loading, ...this.saves]); }
	async close(): Promise<void> {
		this.closed = true; this.generation++; this.clearTimer(); this.statusValue = "closed"; this.state.items = [];
		for (const fn of this.listeners) { try { fn(); } catch { /* Closing all views remains possible. */ } }
		this.listeners.clear(); await this.settled();
	}
}
