import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { AuthSession } from "./AuthSession";
import * as Y from "yjs";
import { ResourceAddress, RemoteCanvasAddress, RemoteDocumentAddress } from "./ResourceAddress";
import { isDocument, type Document } from "./Document";
import { isCanvasDocument } from "./CanvasDocument";
import type { Clock } from "./Clock";
import { Loggable, instanceLabels } from "./logging";
import type { Subscriber, Unsubscriber } from "./notifiers/Notifier";
import { NotifierSet } from "./notifiers/NotifierSet";
import { NotifierMap } from "./notifiers/NotifierMap";
import type { VaultShare, ShareRegistry } from "./VaultShare";
import { compareVaultPaths } from "./pathOrdering";
import type { DocumentGrant } from "./relay/TokenShapes";
import { CanvasDocument } from "./CanvasDocument";
import { deepValueEquals } from "./deepValueEquals";
import type { CanvasData } from "./HostCanvasView";
import { AttachmentFile, isAttachmentFile } from "./AttachmentFile";
import { applyDiffToYText, reconcileWithConflictCopy } from "./ytextDiff";
import { hasPreservableContent, sameTextContent } from "./textEquivalence";
import { waitForBufferFlush } from "./websocketFlush";
import { textFingerprint } from "./docActivity";
import {
	firstWriteWithoutLostSeed,
	hasHistoryGap,
	keepsAllText,
	noteCompletedSync,
	noteLostSeedTextOnDisk,
} from "./preserveBeforeTrash";
import {
	claimInitIfUnclaimed,
	wonInitClaim,
	markInitDone,
	awaitClaimSettled,
	neverHeldText,
} from "./initContentClaim";
import { claimReconcile, wonReconcileClaim, awaitReconcileSettled } from "./reconcileClaim";
import { holdBackgroundTokens } from "./auth/tokenRequestClass";

export interface TransferTask {
	entityGuid: string;
	/** FULL vault path (share prefix + the entry's own path), not the
	 * entry-relative `SyncableEntry.entryPath` — see `makeQueueItem`. */
	absolutePath: string;
	syncEntry: Document | CanvasDocument | AttachmentFile;
	taskStatus: "pending" | "running" | "completed" | "failed";
	vaultShare: VaultShare;
	/** A single note someone is waiting on now, not part of a bulk pass. */
	priority: boolean;
	/** Clock time the item was queued, for oldest-wait accounting. */
	queuedAt: number;
}

export interface EnqueueOptions {
	/**
	 * A single note a person is waiting on (a local edit or create, a peer's
	 * new note): served before bulk work and allowed one reserved slot, so
	 * it never waits behind a startup pass over hundreds of documents.
	 */
	priority?: boolean;
}

/** Per-lane queue snapshot exposed by `TransferQueue.laneStats()`. */
export interface LaneStats {
	queued: number;
	priorityQueued: number;
	active: number;
	oldestWaitMs: number;
	queuedByShare: Record<string, number>;
	/** Shares whose priority backlog is large enough to rank as bulk (an import). */
	importingShares: string[];
	/** Run time of the lane's recent items, start to settle: priority and the rest. */
	durationMs: Record<"priority" | "bulk", { count: number; p50: number; p95: number; max: number }>;
	/** Uploads left unsynced (connect failure, sync timeout) and what became of their retries. */
	retries: { failed: number; retried: number; gaveUp: number; pending: number };
	/** Items re-run because a new edit arrived while they were running. */
	reruns: number;
}

export interface TransferBatch {
	vaultShare: VaultShare;
	queuedTotal: number; // Total operations (uploads + fetches)
	finishedTotal: number; // Total completed operations
	phase: "pending" | "running" | "completed" | "failed";
	queuedFetches: number;
	queuedUploads: number;
	finishedFetches: number;
	finishedUploads: number;
}

export interface TransferProgress {
	overallPercent: number;
	uploadPercent: number;
	fetchPercent: number;
	queuedTotal: number;
	finishedTotal: number;
	queuedUploads: number;
	finishedUploads: number;
	queuedFetches: number;
	finishedFetches: number;
}

export interface BatchProgress {
	percent: number;
	uploadPercent: number;
	fetchPercent: number;
	vaultShare: VaultShare;
	phase: "pending" | "running" | "completed" | "failed";
}

/** A pending resolver/rejecter pair handed out to a caller awaiting one queued item. */
interface QueueWaiter {
	resolve: () => void;
	reject: (error: Error) => void;
}

/**
 * Internal per-queue runtime state. `syncQueue` and `downloadQueue` are two
 * instances of this same shape rather than two hand-duplicated sets of
 * fields/methods — the two queues process items identically (connect-filter,
 * lane-limit gate, run, bookkeeping); only the small bits that differ
 * (which runner to invoke, which TransferBatch counters to bump, which label to
 * log under) are carried as data on the lane itself. See `drainLane()`.
 */
interface QueueLaneState {
	queue: TransferTask[];
	readonly active: NotifierSet<TransferTask>;
	readonly inFlight: Set<string>;
	readonly waiters: Map<string, QueueWaiter>;
	processing: boolean;
	readonly run: (item: TransferTask) => Promise<unknown>;
	readonly startupFailureLabel: string;
	readonly runFailureLabel: string;
	readonly onItemCompleted: (group: TransferBatch) => void;
	/** Per share, the sequence number of the last item this lane started. */
	readonly lastServed: Map<VaultShare, number>;
	/** How long the most recent items ran, start to settle (newest last). */
	readonly durations: { ms: number; priority: boolean }[];
	/** Running items asked for again meanwhile, and whether that ask was priority. */
	readonly rerun: Map<string, boolean>;
	reruns: number;
}

/**
 * One priority upload (an edit to a closed note), for a load test to line up
 * with when the other device got it. `endedAt` is wall-clock ms.
 */
export interface PriorityUploadTrace {
	path: string;
	/** Wall-clock ms the upload was queued. */
	enqueuedAt: number;
	endedAt: number;
	waitMs: number;
	runMs: number;
	ok: boolean;
	ranAsPriority: boolean;
}

const UPLOAD_TRACE_SAMPLES = 100;

/** How many recent run durations `laneStats()` summarises per lane. */
const DURATION_SAMPLES = 200;

function summarise(samples: number[]): { count: number; p50: number; p95: number; max: number } {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
	return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.length === 0 ? 0 : sorted[sorted.length - 1] };
}

/** `Math.round((part / whole) * 100)`, treating a zero-sized whole as 0% rather than NaN. */
function percentOf(part: number, whole: number): number {
	return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Where a pullIfUnchanged() call currently is -- reported for timeout attribution. */
export type PullPhase =
	| "read-vault"
	| "first-sync"
	| "connect"
	| "await-online"
	| "grace"
	| "await-content"
	| "compare"
	| "sync-base"
	| "preserve"
	| "write";

/** Identifies one pull's ownership of a note's connection. */
type PullHold = Record<string, never>;

export interface PullControl {
	/** Once aborted, the pull writes nothing more and releases its connection. */
	signal?: AbortSignal;
	onPhase?: (phase: PullPhase) => void;
	/**
	 * The fingerprint an announcement says the text will have (read on every
	 * check, so a newer announcement mid-pull replaces it). Set together with
	 * `awaitContentMs`: the pull then stays connected until the text matches
	 * instead of comparing what happens to be there after the grace window.
	 */
	expected?: () => string | undefined;
	awaitContentMs?: number;
	/** Called each time a pull waiting for announced text reconnects to ask the relay again. */
	onReconnect?: () => void;
}

/** One relay probe: token + socket connect, then this connection's first sync. */
export interface RelayProbeSample {
	at: number;
	connectMs: number;
	syncMs: number;
	ok: boolean;
	/** Where the connect spent its time, in ms from `at`. */
	phases?: {
		tokenMs?: number;
		connectCallMs?: number;
		/** When the socket was queued for its turn; socketMs minus this is the wait. */
		queuedMs?: number;
		socketMs?: number;
		openMs?: number;
		skipped?: string;
		failedSockets: number;
	};
}

export interface PullResult {
	outcome:
		| "flushed"
		| "unchanged"
		| "kept-local"
		| "no-base"
		| "seed-local"
		| "history-gap"
		| "not-synced"
		| "connect-failed"
		| "aborted";
	/** The relay text the pull compared against, when it got that far. */
	remoteText?: string;
}

/** pullIfUnchanged(): cap on waiting for the socket to reach "connected". */
const PULL_CONNECT_TIMEOUT_MS = 15_000;
/** pullIfUnchanged(): grace window after "connected" for the Yjs sync round-trip to land. */
const PULL_SYNC_GRACE_MS = 2_000;
/** How often a pull waiting for announced text looks at it again. */
const AWAIT_CONTENT_CHECK_MS = 250;
/** How long a pull waits connected for announced text before it first reconnects to ask again; doubles after each. */
const AWAIT_CONTENT_RECONNECT_MS = 4_000;
/**
 * pullIfUnchanged(): how long a note must keep reading as never seeded, across
 * separate connections, before its file is seeded into the relay. A room the
 * relay is still loading answers the sync empty, so one connection proves nothing.
 */
const UNSEEDED_CONFIRM_MS = 60_000;
/** probeRelay(): cap on each of its two phases. */
const PROBE_PHASE_TIMEOUT_MS = 30_000;
/**
 * Outer safety bound on reconcileRelayContent()'s claim+settle fast path
 *. awaitReconcileSettled already has its own internal
 * maxWaitMs (3000ms default, initContentClaim.ts) -- this is a SECOND,
 * independent ceiling around the whole call, not a replacement for it. Set
 * comfortably above the inner contract so it never fires in the normal
 * case; its only job is to guarantee this code path can never gate whether
 * a real local edit gets preserved on an unbounded/unproven wait.
 */
const RECONCILE_SETTLE_OUTER_TIMEOUT_MS = 8_000;

/**
 * Delays before each slow re-fetch round for a doc that keeps reading empty
 * after the fast retries (#266). Short first steps pick up content that
 * lands just after the fast budget (a cold room, a late peer upload) within
 * seconds instead of a flat 5 min; the tail keeps the total wait
 * before accepting a genuinely empty note above the old 3 x 5 min.
 */
const SLOW_REFETCH_SCHEDULE_MS = [
	5_000, 10_000, 20_000, 40_000, 60_000, 120_000, 300_000, 300_000, 300_000,
];

/**
 * Slots on top of `laneLimit` that only priority items may take, and only
 * from a share with no priority item running in the lane. Bulk items can hold a slot
 * for 30s+ each (the provider-sync timeout); measured live, a new note queued
 * behind ~50 of them for minutes after a restart.
 */
const PRIORITY_RESERVED_SLOTS = 1;
/**
 * A share with more priority items than this queued or running in a lane is
 * importing (notes written while their docs were offline are all queued as
 * priority), and its items rank as bulk. Measured live on 0.1.11: an import of
 * 700 such notes shared every slot with another share's edits on equal terms,
 * and those edits queued for minutes.
 */
const PRIORITY_IMPORT_BACKLOG = 8;
const LANE_STATS_LOG_EVERY_MS = 60_000;
/**
 * Delays before re-trying an upload that came back unsynced (connect failure
 * or sync timeout, both routine while the relay is under load). Without them
 * the edit waited for the next full pass over the share, minutes later.
 */
const UPLOAD_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

export class TransferQueue extends Loggable {
	public activeUploads = new NotifierSet<TransferTask>();
	public activeFetches = new NotifierSet<TransferTask>();
	public batches = new NotifierMap<VaultShare, TransferBatch>();

	private syncLane: QueueLaneState;
	private readonly uploadTrace: PriorityUploadTrace[] = [];
	/**
	 * Documents a background pull connected and still holds, with the pull
	 * that owns the connection now: only that pull may close it.
	 */
	private readonly pullHolds = new Map<string, PullHold>();
	/** Pull connections left open for a queued upload, which then closes them. */
	private readonly handedToUpload = new Set<string>();
	private downloadLane: QueueLaneState;

	private paused = true;
	private serveSeq = 0;
	private lastStatsLogAt = 0;
	private uploadRetries = new Map<string, { attempt: number; timer?: number }>();
	/** When a pull first found a note never seeded, by guid (see UNSEEDED_CONFIRM_MS). */
	private unseededSince = new Map<string, number>();
	private uploadRetryStats = { failed: 0, retried: 0, gaveUp: 0 };

	teardowns: Unsubscriber[] = [];

	constructor(
		private auth: AuthSession,
		private clock: Clock,
		private shares: ShareRegistry,
		/**
		 * Public so callers that bypass the queue lanes entirely -- e.g.
		 * CrdtBackgroundSyncPoller's pullIfUnchanged() calls, see its own
		 * doc comment for why -- can still cap their own lane width to the
		 * same number instead of inventing a second, independently-drifting
		 * one.
		 */
		public readonly laneLimit: number = 3,
	) {
		super();
		instanceLabels.set(this, "TransferQueue");

		this.syncLane = {
			queue: [],
			active: this.activeUploads,
			inFlight: new Set<string>(),
			waiters: new Map<string, QueueWaiter>(),
			processing: false,
			run: (item) => this.runSyncItem(item),
			startupFailureLabel: "[Sync Startup Failed]",
			runFailureLabel: "[Sync Failed]",
			onItemCompleted: (group) => {
				group.finishedUploads++;
				group.finishedTotal++;
			},
			lastServed: new Map<VaultShare, number>(),
			durations: [],
			rerun: new Map<string, boolean>(),
			reruns: 0,
		};
		this.downloadLane = {
			queue: [],
			active: this.activeFetches,
			inFlight: new Set<string>(),
			waiters: new Map<string, QueueWaiter>(),
			processing: false,
			run: (item) => this.runDownloadItem(item),
			startupFailureLabel: "[Download Startup Failed]",
			runFailureLabel: "[processDownloadQueue]",
			onItemCompleted: (group) => {
				group.finishedFetches++;
				group.finishedTotal++;
			},
			lastServed: new Map<VaultShare, number>(),
			durations: [],
			rerun: new Map<string, boolean>(),
			reruns: 0,
		};

		this.clock.scheduleInterval(() => {
			void this.drainLane(this.syncLane);
			void this.drainLane(this.downloadLane);
			this.maybeLogLaneStats();
		}, 1000);
	}

	/** The most recent priority uploads, newest last. */
	priorityUploadTrace(): PriorityUploadTrace[] {
		return [...this.uploadTrace];
	}

	/** Queue sizes per share, priority backlog, active count and oldest wait, per lane. */
	laneStats(): { uploads: LaneStats; fetches: LaneStats } {
		return { uploads: this.statsFor(this.syncLane), fetches: this.statsFor(this.downloadLane) };
	}

	/** Priority fetches of `vaultShare` that are queued or running. */
	priorityFetches(vaultShare: VaultShare): number {
		const own = (item: TransferTask) => item.priority && item.vaultShare === vaultShare;
		return (
			this.downloadLane.queue.filter(own).length + this.downloadLane.active.toArray().filter(own).length
		);
	}

	private statsFor(lane: QueueLaneState): LaneStats {
		const now = this.clock.now();
		const queuedByShare: Record<string, number> = {};
		let oldest = now;
		for (const item of lane.queue) {
			queuedByShare[item.vaultShare.path] = (queuedByShare[item.vaultShare.path] ?? 0) + 1;
			oldest = Math.min(oldest, item.queuedAt);
		}
		return {
			queued: lane.queue.length,
			priorityQueued: lane.queue.filter((item) => item.priority).length,
			active: lane.active.count,
			oldestWaitMs: now - oldest,
			queuedByShare,
			importingShares: [...this.importingShares(lane)].map((share) => share.path),
			durationMs: {
				priority: summarise(lane.durations.filter((d) => d.priority).map((d) => d.ms)),
				bulk: summarise(lane.durations.filter((d) => !d.priority).map((d) => d.ms)),
			},
			retries:
				lane === this.syncLane
					? { ...this.uploadRetryStats, pending: this.uploadRetries.size }
					: { failed: 0, retried: 0, gaveUp: 0, pending: 0 },
			reruns: lane.reruns,
		};
	}

	/** Shares whose priority backlog in `lane` exceeds PRIORITY_IMPORT_BACKLOG. */
	private importingShares(lane: QueueLaneState): Set<VaultShare> {
		const counts = new Map<VaultShare, number>();
		const count = (item: TransferTask) => {
			if (item.priority) counts.set(item.vaultShare, (counts.get(item.vaultShare) ?? 0) + 1);
		};
		lane.queue.forEach(count);
		lane.active.each(count);
		const importing = new Set<VaultShare>();
		for (const [share, n] of counts) if (n > PRIORITY_IMPORT_BACKLOG) importing.add(share);
		return importing;
	}

	private maybeLogLaneStats(): void {
		if (this.syncLane.queue.length === 0 && this.downloadLane.queue.length === 0) return;
		const now = this.clock.now();
		if (now - this.lastStatsLogAt < LANE_STATS_LOG_EVERY_MS) return;
		this.lastStatsLogAt = now;
		this.log("[laneStats]", JSON.stringify(this.laneStats()));
	}

	/**
	 * Returns items currently in the sync queue
	 */
	public get pendingUploads(): readonly TransferTask[] {
		return this.syncLane.queue;
	}

	/**
	 * Returns items currently in the download queue
	 */
	public get pendingFetches(): readonly TransferTask[] {
		return this.downloadLane.queue;
	}

	overallProgress(): TransferProgress {
		const totals = {
			queuedTotal: 0,
			finishedTotal: 0,
			queuedUploads: 0,
			finishedUploads: 0,
			queuedFetches: 0,
			finishedFetches: 0,
		};

		this.batches.each((group) => {
			totals.queuedTotal += group.queuedTotal;
			totals.finishedTotal += group.finishedTotal;
			totals.queuedUploads += group.queuedUploads;
			totals.finishedUploads += group.finishedUploads;
			totals.queuedFetches += group.queuedFetches;
			totals.finishedFetches += group.finishedFetches;
		});

		return {
			overallPercent: percentOf(totals.finishedTotal, totals.queuedTotal),
			uploadPercent: percentOf(totals.finishedUploads, totals.queuedUploads),
			fetchPercent: percentOf(totals.finishedFetches, totals.queuedFetches),
			queuedTotal: totals.queuedTotal,
			finishedTotal: totals.finishedTotal,
			queuedUploads: totals.queuedUploads,
			finishedUploads: totals.finishedUploads,
			queuedFetches: totals.queuedFetches,
			finishedFetches: totals.finishedFetches,
		};
	}

	batchProgress(vaultShare: VaultShare): BatchProgress | null {
		const group = this.batches.lookup(vaultShare);
		if (!group) return null;

		return {
			percent: percentOf(group.finishedTotal, group.queuedTotal),
			uploadPercent: percentOf(group.finishedUploads, group.queuedUploads),
			fetchPercent: percentOf(group.finishedFetches, group.queuedFetches),
			vaultShare,
			phase: group.phase,
		};
	}

	allBatchProgress(): BatchProgress[] {
		const progress: BatchProgress[] = [];
		this.batches.each((_group, vaultShare) => {
			const groupProgress = this.batchProgress(vaultShare);
			if (groupProgress) {
				progress.push(groupProgress);
			}
		});
		return progress;
	}

	/**
	 * Drains one lane (sync or download) up to `laneLimit` concurrently-running
	 * items: filters the lane's queue down to items whose VaultShare is
	 * connected, pulls items off (respecting the lane cap), hands each to
	 * `lane.run()`, and wires up completion/failure bookkeeping + a re-drain once
	 * the item finishes. Both `processSyncQueue`/`processDownloadQueue` from the
	 * pre-rewrite version of this file are calls into this one method with a
	 * different `lane`.
	 */
	private drainLane(lane: QueueLaneState): void {
		if (this.paused || lane.processing) return;
		lane.processing = true;

		const runnable = lane.queue.filter((item) => item.vaultShare.isOnline);

		while (runnable.length > 0) {
			const importing = this.importingShares(lane);
			const urgent = (queued: TransferTask) => queued.priority && !importing.has(queued.vaultShare);
			let candidates = runnable;
			if (lane.active.count >= this.laneLimit) {
				// Reserved slots: priority work from a share with no priority item
				// running in this lane yet. A share whose whole backlog is priority
				// (an import written while its docs were offline) would otherwise
				// hold them too, and an edit in another share would wait for one of
				// its uploads to finish.
				if (lane.active.count >= this.laneLimit + PRIORITY_RESERVED_SLOTS) break;
				candidates = runnable.filter((queued) => urgent(queued) && !this.hasActivePriority(lane, queued.vaultShare));
				if (candidates.length === 0) break;
			}
			// While an edit is queued or running, an import (or any other
			// background work) keeps at most one slot: measured on 0.1.15, the
			// relay slowed to 16-19s per document under our own bulk traffic
			// and the edits waited on the same relay.
			if (this.hasUrgentWork(lane, runnable, urgent) && this.activeBackground(lane, urgent) >= 1) {
				candidates = candidates.filter(urgent);
				if (candidates.length === 0) break;
			}
			const item = this.nextRunnable(lane, candidates, urgent);

			runnable.splice(runnable.indexOf(item), 1);
			lane.queue = lane.queue.filter((queued) => queued.entityGuid !== item.entityGuid);

			item.taskStatus = "running";
			const startedAt = this.clock.now();
			const ranAsPriority = urgent(item);
			// Background work lets edits and open documents get their relay
			// tokens first (see tokenRequestClass.ts).
			const releaseTokens = ranAsPriority ? undefined : holdBackgroundTokens(item.entityGuid);
			lane.active.include(item);
			lane.lastServed.set(item.vaultShare, ++this.serveSeq);

			try {
				let ok = false;
				lane
					.run(item)
					.then(() => {
						this.completeQueueItem(lane, item);
						ok = true;
					})
					.catch((error: unknown) => {
						this.failQueueItem(lane, item, error);
					})
					.finally(() => {
						releaseTokens?.();
						if (lane === this.syncLane) this.closeHandedConnection(item.syncEntry);
						if (lane === this.syncLane && item.priority) {
							const endedAt = Date.now();
							this.uploadTrace.push({
								path: item.absolutePath,
								enqueuedAt: endedAt - (this.clock.now() - item.queuedAt),
								endedAt,
								waitMs: startedAt - item.queuedAt,
								runMs: this.clock.now() - startedAt,
								ok,
								ranAsPriority,
							});
							if (this.uploadTrace.length > UPLOAD_TRACE_SAMPLES) this.uploadTrace.shift();
						}
						lane.durations.push({ ms: this.clock.now() - startedAt, priority: ranAsPriority });
						if (lane.durations.length > DURATION_SAMPLES) lane.durations.shift();
						lane.active.delete(item);
						lane.inFlight.delete(item.entityGuid);
						this.rerunIfAskedAgain(lane, item);

						// Unwind the call stack before checking for more work
						this.clock.scheduleTimeout(() => {
							void this.drainLane(lane);
						}, 0);
					});
			} catch (error: unknown) {
				releaseTokens?.();
				item.taskStatus = "failed";
				this.rejectWaiter(lane, item.entityGuid, error);
				this.markGroupFailed(item.vaultShare, lane.startupFailureLabel, error);
				lane.active.delete(item);
				lane.inFlight.delete(item.entityGuid);
			}
		}

		lane.processing = false;
	}

	/**
	 * An item asked for again while it ran may have missed what prompted the
	 * ask (an edit saved after the upload read the file), so it runs once more.
	 */
	private rerunIfAskedAgain(lane: QueueLaneState, item: TransferTask): void {
		const priority = lane.rerun.get(item.entityGuid);
		if (priority === undefined) return;
		lane.rerun.delete(item.entityGuid);
		if (!this.clock) return;
		lane.reruns++;
		const again =
			lane === this.syncLane
				? this.enqueueUpload(item.syncEntry, { priority })
				: this.enqueueFetch(item.syncEntry, { priority });
		void again.catch((error: unknown) => this.warn("[rerun] failed for", item.entityGuid, error));
	}

	private isRunning(lane: QueueLaneState, entityGuid: string): boolean {
		let running = false;
		lane.active.each((item) => {
			if (item.entityGuid === entityGuid) running = true;
		});
		return running;
	}

	private hasUrgentWork(
		lane: QueueLaneState,
		runnable: TransferTask[],
		urgent: (item: TransferTask) => boolean,
	): boolean {
		if (runnable.some(urgent)) return true;
		let found = false;
		lane.active.each((item) => {
			if (urgent(item)) found = true;
		});
		return found;
	}

	private activeBackground(lane: QueueLaneState, urgent: (item: TransferTask) => boolean): number {
		let count = 0;
		lane.active.each((item) => {
			if (!urgent(item)) count++;
		});
		return count;
	}

	private hasActivePriority(lane: QueueLaneState, vaultShare: VaultShare): boolean {
		let found = false;
		lane.active.each((item) => {
			if (item.priority && item.vaultShare === vaultShare) found = true;
		});
		return found;
	}

	/**
	 * Picks the next item to start: urgent items (priority, outside an import)
	 * before the rest; within
	 * that class the share with the fewest running items in this lane, then
	 * the one served longest ago; within the share, the oldest item. A plain
	 * path-sorted FIFO let one large share hold every slot while a small
	 * share's single note waited for the whole backlog.
	 */
	private nextRunnable(
		lane: QueueLaneState,
		runnable: TransferTask[],
		isUrgent: (item: TransferTask) => boolean,
	): TransferTask {
		const urgent = runnable.some(isUrgent);
		const activeByShare = new Map<VaultShare, number>();
		lane.active.each((item) => {
			activeByShare.set(item.vaultShare, (activeByShare.get(item.vaultShare) ?? 0) + 1);
		});
		let best: TransferTask | undefined;
		for (const item of runnable) {
			if (urgent && !isUrgent(item)) continue;
			if (!best) {
				best = item;
				continue;
			}
			const running = activeByShare.get(item.vaultShare) ?? 0;
			const bestRunning = activeByShare.get(best.vaultShare) ?? 0;
			if (running !== bestRunning) {
				if (running < bestRunning) best = item;
				continue;
			}
			const served = lane.lastServed.get(item.vaultShare) ?? 0;
			const bestServed = lane.lastServed.get(best.vaultShare) ?? 0;
			if (served !== bestServed) {
				if (served < bestServed) best = item;
				continue;
			}
			if (item.queuedAt < best.queuedAt) best = item;
		}
		// `runnable` is non-empty, so the loop always picked something.
		return best ?? runnable[0];
	}

	private runSyncItem(item: TransferTask): Promise<unknown> {
		if (item.syncEntry instanceof AttachmentFile) {
			return this.uploadAttachment(item.syncEntry);
		}
		return this.uploadDocument(item.syncEntry, item.priority);
	}

	private runDownloadItem(item: TransferTask): Promise<unknown> {
		if (item.syncEntry instanceof CanvasDocument) {
			return this.fetchCanvas(item.syncEntry);
		}
		if (item.syncEntry instanceof AttachmentFile) {
			return this.fetchAttachment(item.syncEntry);
		}
		return this.fetchDocument(item.syncEntry);
	}

	private rejectWaiter(lane: QueueLaneState, guid: string, error: unknown): void {
		const waiter = lane.waiters.get(guid);
		if (waiter) {
			waiter.reject(error instanceof Error ? error : new Error(String(error)));
			lane.waiters.delete(guid);
		}
	}

	private completeQueueItem(lane: QueueLaneState, item: TransferTask): void {
		item.taskStatus = "completed";
		const waiter = lane.waiters.get(item.entityGuid);
		if (waiter) {
			waiter.resolve();
			lane.waiters.delete(item.entityGuid);
		}

		const group = this.batches.lookup(item.vaultShare);
		if (!group) return;

		lane.onItemCompleted(group);
		if (group.finishedTotal === group.queuedTotal) {
			group.phase = "completed";
		}
		this.batches.put(item.vaultShare, group);
	}

	private failQueueItem(lane: QueueLaneState, item: TransferTask, error: unknown): void {
		item.taskStatus = "failed";
		this.rejectWaiter(lane, item.entityGuid, error);
		this.markGroupFailed(item.vaultShare, lane.runFailureLabel, error);
	}

	private markGroupFailed(
		vaultShare: VaultShare,
		label: string,
		error: unknown,
	): void {
		// NB (disclosed deviation): the pre-rewrite sync lane only logged this
		// error when a TransferBatch still existed for the folder, while the
		// download lane logged unconditionally. Unified to "always log" here
		// — strictly more visibility, never less, and the two paths agreeing
		// removes an inconsistency that had no apparent intent behind it.
		this.error(label, error);
		const group = this.batches.lookup(vaultShare);
		if (group) {
			group.phase = "failed";
			this.batches.put(vaultShare, group);
		}
	}

	/**
	 * Enqueues a document for synchronization
	 *
	 * This method adds a document to the sync queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to synchronize
	 * @returns A promise that resolves when the sync completes
	 */
	async enqueueUpload(
		item: AttachmentFile | Document | CanvasDocument,
		options: EnqueueOptions = {},
	): Promise<void> {
		if (this.syncLane.inFlight.has(item.entityGuid)) {
			this.debug(`[enqueueUpload] Item ${item.entityGuid} already in progress, skipping`);
			if (this.isRunning(this.syncLane, item.entityGuid)) {
				const priority = (this.syncLane.rerun.get(item.entityGuid) ?? false) || !!options.priority;
				this.syncLane.rerun.set(item.entityGuid, priority);
			}
			if (options.priority) this.promote(this.syncLane, item.entityGuid);
			const existing = this.syncLane.waiters.get(item.entityGuid);
			if (existing) {
				return new Promise<void>((resolve, reject) => {
					existing.resolve = resolve;
					existing.reject = reject;
				});
			}
			void this.drainLane(this.syncLane);
			return Promise.resolve();
		}

		const group = this.groupFor(item.vaultShare);
		group.queuedTotal++;
		group.queuedUploads++;
		this.batches.put(item.vaultShare, group);

		return this.pushToLane(this.syncLane, item, options.priority ?? false);
	}

	/**
	 * Enqueues a document for download
	 *
	 * This method adds a document to the download queue and creates/updates
	 * the associated sync group to track progress.
	 *
	 * @param item The document to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueFetch(
		item: AttachmentFile | Document | CanvasDocument,
		options: EnqueueOptions = {},
	): Promise<void> {
		if (this.downloadLane.inFlight.has(item.entityGuid)) {
			this.debug(
				`[enqueueFetch] Item ${item.entityGuid} already in progress, skipping`,
			);
			if (options.priority) this.promote(this.downloadLane, item.entityGuid);
			const existing = this.downloadLane.waiters.get(item.entityGuid);
			if (existing) {
				void this.drainLane(this.downloadLane);
				return new Promise<void>((resolve, reject) => {
					existing.resolve = resolve;
					existing.reject = reject;
				});
			}
			void this.drainLane(this.downloadLane);
			return Promise.resolve();
		}

		const group = this.groupFor(item.vaultShare);
		group.queuedFetches++;
		group.queuedTotal++;
		this.batches.put(item.vaultShare, group);

		return this.pushToLane(this.downloadLane, item, options.priority ?? false);
	}

	/**
	 * Enqueues all documents and canvases in a shared folder for synchronization
	 *
	 * This method creates a sync group to track the progress of synchronizing
	 * all documents and canvases in a shared folder, then enqueues each item for sync.
	 * It handles counter initialization correctly to avoid double-counting.
	 *
	 * @param vaultShare The shared folder to synchronize
	 */
	enqueueShareUpload(vaultShare: VaultShare): void {
		const files = [...vaultShare.trackedEntries.values()];
		// Ordered docs-then-canvases-then-syncFiles, then sorted for a
		// consistent, deterministic sync order across a whole folder.
		const items = [
			...files.filter(isDocument),
			...files.filter(isCanvasDocument),
			...files.filter(isAttachmentFile),
		].sort(compareVaultPaths);

		// Register the group (with its final counts) before enqueueing a
		// single item, so progress observers never see a partially-sized group.
		const group = this.newSyncGroup(vaultShare);
		group.queuedTotal = items.length;
		group.queuedUploads = items.length;
		this.batches.put(vaultShare, group);

		for (const item of items) {
			void this.enqueueInBatch(item);
		}

		group.phase = "running";
		this.batches.put(vaultShare, group);
	}

	/**
	 * Enqueues an item for synchronization as part of a group sync operation
	 *
	 * This method is similar to enqueueUpload() but doesn't increment any counters
	 * since they're already properly initialized in enqueueShareUpload().
	 * This prevents double-counting of operations in progress tracking.
	 *
	 * @param item The item to synchronize (Document, CanvasDocument, or AttachmentFile)
	 * @returns A promise that resolves when the sync completes
	 * @private Used internally by enqueueShareUpload
	 */
	private async enqueueInBatch(
		item: Document | CanvasDocument | AttachmentFile,
	): Promise<void> {
		if (this.syncLane.inFlight.has(item.entityGuid)) {
			this.debug(
				`[enqueueInBatch] Item ${item.entityGuid} already in progress, skipping`,
			);
			const existing = this.syncLane.waiters.get(item.entityGuid);
			if (existing) {
				void this.drainLane(this.syncLane);
				return new Promise<void>((resolve, reject) => {
					existing.resolve = resolve;
					existing.reject = reject;
				});
			}
			return Promise.resolve();
		}

		return this.pushToLane(this.syncLane, item, false);
	}

	// NB (disclosed deviation, preserved not "fixed"): the three enqueue*
	// methods above each nudge drainLane() on a DIFFERENT combination of the
	// "already in progress, found an existing waiter to reuse" vs. "already
	// in progress, no waiter to reuse" branches:
	//   enqueueUpload       -> nudges only when there's NO existing waiter
	//   enqueueFetch        -> nudges in BOTH cases
	//   enqueueInBatch      -> nudges only when there IS an existing waiter
	// This looks like an accidental inconsistency in the pre-rewrite code
	// rather than a deliberate design, but this batch's mandate is to
	// preserve behavior, not correct it — each method's own branching is
	// carried over exactly rather than unified onto one shape.

	private newSyncGroup(vaultShare: VaultShare): TransferBatch {
		return {
			vaultShare,
			queuedTotal: 0,
			finishedTotal: 0,
			phase: "pending",
			queuedFetches: 0,
			queuedUploads: 0,
			finishedFetches: 0,
			finishedUploads: 0,
		};
	}

	private groupFor(vaultShare: VaultShare): TransferBatch {
		return this.batches.lookup(vaultShare) ?? this.newSyncGroup(vaultShare);
	}

	private makeQueueItem(
		item: AttachmentFile | Document | CanvasDocument,
		priority: boolean,
	): TransferTask {
		const vaultShare = item.vaultShare;
		return {
			entityGuid: item.entityGuid,
			absolutePath: vaultShare.absolutePath(item.entryPath),
			syncEntry: item,
			taskStatus: "pending",
			vaultShare,
			priority,
			queuedAt: this.clock.now(),
		};
	}

	/** Moves an already-queued item into the priority class; a running one is left alone. */
	private promote(lane: QueueLaneState, entityGuid: string): void {
		const queued = lane.queue.find((item) => item.entityGuid === entityGuid);
		if (queued && !queued.priority) {
			queued.priority = true;
			void this.drainLane(lane);
		}
	}

	/** Registers `item` on `lane`'s queue and returns a promise that resolves/rejects on completion. */
	private pushToLane(
		lane: QueueLaneState,
		item: AttachmentFile | Document | CanvasDocument,
		priority: boolean,
	): Promise<void> {
		lane.inFlight.add(item.entityGuid);
		const completion = new Promise<void>((resolve, reject) => {
			lane.waiters.set(item.entityGuid, { resolve, reject });
		});

		// Arrival order, not path order: nextRunnable() picks across shares,
		// and enqueueShareUpload() already enqueues each pass path-sorted.
		lane.queue.push(this.makeQueueItem(item, priority));
		void this.drainLane(lane);

		return completion;
	}

	private authHeader(clientToken: DocumentGrant) {
		return {
			Authorization: `Bearer ${clientToken.token}`,
		};
	}

	private endpointBase(
		clientToken: DocumentGrant,
		entity: RemoteDocumentAddress | RemoteCanvasAddress,
	): string {
		const urlObj = new URL(clientToken.url);
		urlObj.protocol = "https:";
		const parts = urlObj.pathname.split("/");
		parts.pop();
		// Control-plane relay tokens carry `wss://<host>/d/<docId>/ws`: the doc
		// id is already in the path, so dropping `ws` leaves the doc base.
		// Appending the id again produced `/d/<docId>/<docId>/as-update`, which
		// the relay 404s.
		if (parts[parts.length - 1] !== clientToken.docId) {
			parts.push(clientToken.docId);
		}
		urlObj.pathname = parts.join("/");

		return clientToken.baseUrl?.replace(/\/$/, "") || urlObj.toString();
	}

	async fetchItem(item: Document | CanvasDocument): Promise<RequestUrlResponse> {
		const entity = item.resourceAddress;
		this.log("[fetchItem]", item.entryPath, `${ResourceAddress.serialize(entity)}`);

		if (
			!(entity instanceof RemoteDocumentAddress || entity instanceof RemoteCanvasAddress)
		) {
			throw new Error(`Unable to decode ResourceAddress: ${ResourceAddress.serialize(entity)}`);
		}

		const remoteId =
			entity instanceof RemoteCanvasAddress ? entity.canvasGuid : entity.documentGuid;

		const clientToken = await item.requestProviderToken();
		const headers = this.authHeader(clientToken);
		const baseUrl = this.endpointBase(clientToken, entity);
		const url = `${baseUrl}/as-update`;

		const response = await requestUrl({
			url,
			method: "GET",
			headers,
			throw: false,
		});

		if (response.status === 200) {
			this.debug("[fetchItem]", remoteId, response.status);
			return response;
		}

		if (response.status === 401) {
			// CWT tokens are not accepted for HTTP endpoints on y-sweet relay-server.
			// This is expected — WebSocket sync handles document synchronization.
			this.warn(
				"[fetchItem] HTTP auth failed (expected with CWT tokens):",
				remoteId,
				response.status,
			);
		} else {
			this.error(
				"[fetchItem]",
				remoteId,
				url,
				response.status,
				response.text,
			);
		}
		throw new Error(`Unable to download item: ${ResourceAddress.serialize(entity)}`);
	}

	/**
	 * Reconciles a single Document/CanvasDocument's Y.Doc against the on-disk vault
	 * file, then connects to the relay (or connects just long enough to sync
	 * once and disconnects again, if `doc.intent` is `"disconnected"`).
	 *
	 * Returns `false` when reconciliation could not proceed safely — a real
	 * content conflict outside a relay-linked folder, a failed `bringOnline()`,
	 * or a provider-sync timeout. Callers treat `false` as "left as-is, will
	 * be retried later", not as an error.
	 */
	async uploadDocumentViaSocket(doc: Document | CanvasDocument): Promise<boolean> {
		// Wait for this item's OWN local persistence (IndexedDB) to finish
		// loading before trusting anything read off its Y.Doc below. Without
		// this, `doc.content`/exported canvas data can read as empty for a doc
		// that already has real persisted history — fetchUpdates() just
		// hasn't applied it yet, which is routine on a cold Obsidian restart
		// reconnecting many shared folders at once. Downstream code below
		// treats "empty" as "brand new, seed it from disk" (the relay-empty
		// branch at ~line 820, guarded by initContentClaim.ts against a
		// SECOND CLIENT racing the same insert — but not against THIS
		// client's own not-yet-applied history landing moments later and
		// merging with a seed insert that was made under a false premise).
		// Once both land in the same Y.Doc, Yjs concatenates them: the file
		// ends up with its own content duplicated back-to-back .
		if (isDocument(doc)) {
			await doc.awaitFirstSync();
		} else {
			await doc.awaitFirstSync();
		}

		const synced = this.readSyncedContent(doc);
		const vaultContents = await this.readVaultContents(doc);
		const contentsMatch = this.contentsAreInSync(doc, synced, vaultContents);

		// NB: despite the name, this is true for ANY doc in a Team-Relay-linked
		// VaultShare (hosted tr.entire.vc relays included, not just self-hosted
		// on-prem ones) — `workspaceId` is set whenever a folder belongs to a Relay,
		// full stop. Non-relay Local Sync folders are the `false` case below.
		const isRelayOnPrem = this.isRelayLinked(doc);

		if (!contentsMatch && vaultContents) {
			if (!isRelayOnPrem) {
				this.log(
					"file is not tracking local disk. resolve merge conflicts before syncing.",
				);
				return false;
			}
			// For relay-linked folders: Y.Text is likely empty (new Document) while
			// the file has content. We need to connect to the relay to get the
			// authoritative server state first, then reconcile. Skipping would leave
			// Documents permanently unsynced.
		}

		// A connection a background pull opened is not someone else's to keep:
		// wait for this upload's own sync, then close it once the pull is done.
		const borrowed = this.pullHolds.has(doc.entityGuid) || this.handedToUpload.has(doc.entityGuid);
		const intent = borrowed ? "disconnected" : doc.connectionIntent;
		const connected = await doc.bringOnline();
		if (!connected) {
			this.warn("[uploadDocumentViaSocket] connect failed for", doc.entryPath);
			return false;
		}

		if (intent === "disconnected") {
			// This connection's own sync, not doc.onceEverSynced(): that flag
			// is sticky, so for a note synced before it resolved at once while
			// bringOnline() had only started a socket that could still be
			// queued for its turn. The edit below then went into a socket that
			// was not open yet, its frame was dropped, and the goOffline() at
			// the end closed the socket before it opened -- the upload reported
			// success and the edit reached the relay only on this note's next
			// connect (0.1.25 under an 800-note bulk load: 34-38s).
			// Add timeout to prevent infinite hang if provider never syncs
			// (e.g., document disconnected by parent during connection)
			const ok = await this.awaitProviderSyncWithTimeout(doc, doc.onceFreshlySynced());
			if (!ok) {
				return false;
			}

			// `synced` firing only means the relay ACCEPTED the connection and
			// answered sync-step-2 -- not that the answer already carried the
			// document's real, persisted content. A room the relay-server
			// hasn't touched yet in this process's lifetime "Loading doc"s it
			// from storage asynchronously and can answer sync-step-2 off a
			// still-loading, effectively empty placeholder first; live-measured
			// against the self-hosted stand at anywhere from under
			// a second to several seconds depending on load, with NO further
			// update ever delivered to a connection that already moved on --
			// a fixed grace window here just relocates which doc's cold load
			// loses the race, it can't close it (same reasoning as
			// pullIfUnchanged()'s PULL_SYNC_GRACE_MS, sized for its own,
			// narrower "already-connected-doc" case). The real fix is
			// `fetchDocument()`'s retry loop, below: this short wait only
			// gives the common already-warm case (the vast majority of
			// connects) a moment to land before that pays for a whole extra
			// reconnect round-trip.
			await this.delay(PULL_SYNC_GRACE_MS);
		}

		// For relay-linked folders (hosted or on-prem, see note above): after
		// syncing with the relay, reconcile content. The vault file is treated as
		// the source of truth for edits that weren't committed to Y.Doc (e.g. the
		// file was modified without an active editor binding) — but see
		// reconcileRelayContent()/reconcileWithConflictCopy: it never discards
		// divergent Y.Doc content without preserving it first.
		// A doc with a history gap shows empty or partial text: reconciling
		// would seed the file into it (duplicated once the gap closes) and
		// record that text as the agreed base.
		// Not retried: a retry that runs after a peer's edit or clear would
		// reconcile the stale file over it. The pull whose sync closes the gap
		// delivers the relay's text instead (see pullIfUnchanged()).
		const usable = !(isRelayOnPrem && isDocument(doc)) || !hasHistoryGap(doc.crdtDoc);
		if (!usable) {
			this.log(`[uploadDocumentViaSocket] history gap in ${doc.entryPath}; not reconciling yet`);
		}
		let baseSettled = false;
		if (usable && isRelayOnPrem && isDocument(doc) && !doc.editLock) {
			// Typing can continue while the provider connects. Compare the
			// current disk and CRDT contents, not the pre-connection snapshots.
			const beforeRead = doc.content;
			const currentVaultContents = await this.readVaultContents(doc);
			if (!doc.editLock && doc.content !== beforeRead) {
				this.log(`[uploadDocumentViaSocket] ${doc.entryPath}: text changed during disk read; deferring stale snapshot`);
				return false;
			}
			if (!doc.editLock && currentVaultContents && !sameTextContent(doc.content, currentVaultContents)) {
				const localText = await this.deliverIfNoLocalEdit(doc, currentVaultContents);
				baseSettled = localText === undefined;
				if (!doc.editLock && localText !== undefined && !sameTextContent(doc.content, localText)) {
					if (!await this.reconcileRelayContent(doc, localText)) return false;
				}
			}
		}

		// Record what this client now believes it agrees with the relay on --
		// whether that's because nothing needed reconciling, or because
		// reconcileRelayContent() just settled it. reconcileRelayContent()
		// reads this same value to tell "only I moved since we last agreed"
		// (safe to apply without a conflict copy) apart from "the relay moved
		// too" -- so it must be current before the NEXT sync, not
		// just after this one happens to succeed cleanly.
		// deliverIfNoLocalEdit() already recorded the text it wrote, or left
		// the base alone when it could not write: the CRDT may have moved on
		// since, and a base ahead of the disk would read the stale file as a
		// local edit on the next sync and push it over the peer's text.
		if (usable && isRelayOnPrem && isDocument(doc) && !doc.editLock && !baseSettled) {
			await doc.setSyncBase(doc.content);
		}

		// promise can take some time
		this.handedToUpload.delete(doc.entityGuid);
		if (
			intent === "disconnected" &&
			!(isDocument(doc) ? doc.editLock : doc.editLock) &&
			!this.pullHolds.has(doc.entityGuid)
		) {
			doc.goOffline();
			doc.vaultShare.credentialCache.dropFromQueue(ResourceAddress.serialize(doc.resourceAddress));
		}
		return true;
	}

	/**
	 * The relay moved but this client did not: the file still holds the text
	 * last agreed with the relay, so it carries no local edit. Write the
	 * relay's text to disk instead of reconciling the file into the CRDT.
	 *
	 * Without this, an upload that only echoes this client's own delivered
	 * write (the fetch's disk write fires "modify", which queues an upload)
	 * and connects while a peer's edit lands read the stale file as a local
	 * edit: reconcileRelayContent() saw the relay off the base, kept the
	 * peer's edit only as a "relay conflict" copy and wrote the stale text
	 * back into the CRDT, reverting the peer's edit for every participant,
	 * its author's disk included. Live: 5 of 10 co-edit rounds with no pause
	 * after the first sync.
	 *
	 * Returns undefined when the base is settled here: the text was
	 * delivered, or the file could not be written (a failed read, a pending
	 * delete) and the base stays where the disk is, for the next sync.
	 * Otherwise there may be a local edit (no base, the file is off the base,
	 * or it changed while this ran) and the latest file text is returned for
	 * the caller to reconcile.
	 *
	 * An empty relay text is not delivered: it is also what a room that has
	 * not loaded yet reads as, so it keeps the reconcile path it had before.
	 * The re-read and the write leave the same small window as
	 * pullIfUnchanged()'s flush; the adapter offers no compare-and-write.
	 */
	private async deliverIfNoLocalEdit(doc: Document, vaultContents: string): Promise<string | undefined> {
		const base = await doc.getSyncBase();
		if (doc.editLock) return undefined;
		if (base === undefined || !sameTextContent(vaultContents, base)) return vaultContents;
		const remoteText = doc.content;
		if (!hasPreservableContent(remoteText)) return vaultContents;
		// The read above can be stale by now: never overwrite an edit made meanwhile.
		const current = await this.readVaultContents(doc);
		if (doc.editLock) return undefined;
		// "" is also a failed read: nothing safe to write or to record.
		if (current === "") return undefined;
		if (!sameTextContent(current, base)) return current;
		// writeContents() skips a note being deleted but still resolves.
		if (doc.vaultShare.isDeletePending(doc.entryPath)) return undefined;
		await doc.vaultShare.writeContents(doc, remoteText);
		await doc.setSyncBase(remoteText);
		this.log(
			`[uploadDocumentViaSocket] relay moved, no local edit in ${doc.entryPath}; delivered its text`,
		);
		return undefined;
	}

	/**
	 * Safe, read-only-on-mismatch background pull for a Document nobody is
	 * actively editing right now: connect long enough to receive whatever
	 * the relay currently has, and flush it to disk ONLY if (a) the relay's
	 * content actually differs from what's on disk, AND (b) the vault file
	 * did not change while this was connecting -- re-read immediately before
	 * writing, not the value captured at the start, so a local edit racing
	 * THIS CALL's own connect+grace window is never clobbered.
	 *
	 * That guard alone is not enough: it only proves the file was stable
	 * DURING the few seconds this call watched it, not that the content is
	 * actually synced. An edit written straight to disk (app.vault.modify()
	 * with no live editor binding) that lands and then simply sits there --
	 * because the client that owns pushing it is busy, offline, or mid
	 * restart -- looks indistinguishable from "genuinely nothing to
	 * preserve" from this call's point of view, and would previously be
	 * silently overwritten with the relay's stale content: no conflict copy,
	 * no trace (live-reproduced 6/6 with a two-client restart probe). Same invariant as
	 * uploadDocumentViaSocket()/reconcileRelayContent(): before discarding
	 * vault content, check it against `Document.getSyncBase()` -- what this
	 * client last CONFIRMED it and the relay agreed on -- rather than only
	 * against a same-call snapshot.
	 *
	 * Deliberately still never writes to the Y.Doc, unlike
	 * uploadDocumentViaSocket()/reconcileRelayContent() (what
	 * enqueueUpload()/enqueueFetch() ultimately run): this stays a
	 * disk-only pull, it never pushes anything. And when there is no
	 * recorded sync base yet for this doc, this still skips the write
	 * entirely rather than guess -- an undefined base can't distinguish a
	 * genuine unsynced edit from this client's own in-flight seed/upload
	 * racing our read (VaultShare.publishDoc()'s raw
	 * `ydoc.getText("contents").insert()`, which bypasses both TransferQueue
	 * lanes entirely and so is invisible to hasInFlight()) -- confirmed live
	 * against the self-hosted stand: reusing enqueueFetch() for a periodic
	 * poll produced spurious conflict-copy files on a freshly-created,
	 * never-locally-edited file. uploadDocumentViaSocket
	 * will reconcile such a doc correctly once it runs and has a base to
	 * check against.
	 */
	async pullIfUnchanged(doc: Document, control: PullControl = {}): Promise<PullResult> {
		// Any pull that does not find the note unseeded again restarts its wait.
		const unseededSince = this.unseededSince.get(doc.entityGuid);
		this.unseededSince.delete(doc.entityGuid);
		const hold: PullHold = {};
		try {
			return await this.pullIfUnchangedOnce(doc, control, unseededSince, hold);
		} finally {
			// Every return releases the hold; this covers a throw.
			this.dropPullHold(doc, hold);
		}
	}

	private async pullIfUnchangedOnce(
		doc: Document,
		control: PullControl,
		unseededSince: number | undefined,
		ownHold: PullHold,
	): Promise<PullResult> {
		const { signal, onPhase } = control;
		// Every await below may outlive the caller's deadline:
		// once `signal` is aborted the caller has already freed this pull's
		// slot, so the continuation must not write anything and must drop
		// whatever connection it opened, then stop.
		const aborted = () => signal?.aborted === true;
		onPhase?.("read-vault");
		const vaultContentsBefore = await this.readVaultContents(doc);
		if (aborted()) return { outcome: "aborted" };
		onPhase?.("first-sync");
		await doc.awaitFirstSync();
		if (aborted()) return { outcome: "aborted" };
		// What the local store shows, before this pull's sync adds the relay's changes.
		const shownBeforeSync = doc.content;
		// A pull aborted at its deadline may still hold the connection it
		// opened: take it over, so that pull's late release leaves it alone.
		const hold =
			doc.connectionIntent === "disconnected" || this.pullHolds.has(doc.entityGuid) ? ownHold : undefined;
		onPhase?.("connect");
		if (hold) this.pullHolds.set(doc.entityGuid, hold);
		// Bounded like every other connect wait: the poller's deadline frees the
		// slot but cannot end this await. A connect that lands after the
		// timeout is cancelled by the release below (goOffline()).
		const connected = await this.raceTimeout(doc.bringOnline(), PULL_CONNECT_TIMEOUT_MS);
		if (!connected || aborted()) {
			// bringOnline() can leave a retry scheduled (or, if it resolved
			// late, an open socket); a background pull must not keep either.
			this.releasePulledDoc(doc, hold);
			if (!connected) this.warn("[pullIfUnchanged] connect failed for", doc.entryPath);
			return { outcome: connected ? "aborted" : "connect-failed" };
		}

		// Deliberately NOT doc.onceEverSynced(): its "synced" featureKey is
		// sticky (ProviderBacked._providerSynced, set once and never reset on
		// disconnect, by design -- see its own doc comment) so on any connect
		// AFTER the very first one it resolves immediately without waiting
		// for THIS connection's own sync round-trip. onceOnline() doesn't
		// have that problem (ProviderBacked.isOnline tracks the live
		// connection-state getter, observed to correctly go false again on
		// disconnect) -- but reaching "connected" only means the socket is
		// open, not that the Yjs sync handshake has landed a remote diff yet,
		// so a short fixed grace window follows it before reading doc.content.
		onPhase?.("await-online");
		await this.raceTimeout(doc.onceOnline(), PULL_CONNECT_TIMEOUT_MS);
		if (aborted()) {
			this.releasePulledDoc(doc, hold);
			return { outcome: "aborted" };
		}
		onPhase?.("grace");
		await this.delay(PULL_SYNC_GRACE_MS);
		if (control.expected && control.awaitContentMs) {
			// An announced change: its marker can beat the content to us. Stay
			// connected and let the relay push it, instead of disconnecting and
			// paying for another connect on each re-check.
			onPhase?.("await-content");
			const reconnect =
				hold !== undefined
					? async () => {
							// An editor, an upload or a newer pull took the connection over meanwhile: not ours to drop.
							if (
								doc.editLock ||
								this.syncLane.inFlight.has(doc.entityGuid) ||
								this.pullHolds.get(doc.entityGuid) !== hold
							)
								return;
							control.onReconnect?.();
							doc.goOffline();
							// A connect that never settles must not park this pull: the wait
							// goes on with what it has, and the next interval asks again.
							if (!(await this.raceTimeout(doc.bringOnline(), PULL_CONNECT_TIMEOUT_MS)) || aborted()) return;
							await this.raceTimeout(doc.onceOnline(), PULL_CONNECT_TIMEOUT_MS);
						}
					: undefined;
			await this.awaitText(doc, control.expected, control.awaitContentMs, aborted, reconnect);
			if (aborted()) {
				this.releasePulledDoc(doc, hold);
				return { outcome: "aborted" };
			}
		}

		onPhase?.("compare");
		// "Connected" plus the grace window is no proof the relay's state has
		// arrived: without this connection's own completed sync the text is
		// only what the local store held, possibly empty.
		const synced =
			(await this.raceTimeout(doc.onceFreshlySynced().then(() => true), PULL_CONNECT_TIMEOUT_MS)) === true;
		if (aborted()) {
			this.releasePulledDoc(doc, hold);
			return { outcome: "aborted" };
		}
		if (!synced) {
			this.log(`[pullIfUnchanged] no completed sync for ${doc.entryPath}; leaving the file as is`);
			this.releasePulledDoc(doc, hold);
			return { outcome: "not-synced" };
		}
		if (hasHistoryGap(doc.crdtDoc)) {
			// A seed hole the relay lacks too counts as lost after syncs on two
			// connections, if it hides nothing the file or the last agreed text holds.
			let shownOnDisk = sameTextContent(shownBeforeSync, vaultContentsBefore);
			if (!shownOnDisk) {
				const syncBase = await doc.getSyncBase();
				if (aborted()) {
					this.releasePulledDoc(doc, hold);
					return { outcome: "aborted" };
				}
				// A file still at the last agreed text, all of it in the doc,
				// holds nothing the hole could hide: a peer's edit only added
				// to it (live socket before this first pull: doc 78 chars, file 65).
				shownOnDisk =
					syncBase !== undefined &&
					(sameTextContent(shownBeforeSync, syncBase) ||
						(sameTextContent(vaultContentsBefore, syncBase) &&
							keepsAllText(vaultContentsBefore, shownBeforeSync)));
			}
			noteCompletedSync(doc.crdtDoc, doc._liveProvider?.ws ?? null, shownOnDisk);
		}
		if (hasHistoryGap(doc.crdtDoc, "contents", true)) {
			// Updates are pending on changes this client never stored (the
			// note's author after a restart): the text reads empty or partial
			// until the relay sends the missing part. Not what was last synced,
			// however long it lasts: writing it would blank a full file for good.
			this.log(`[pullIfUnchanged] history gap in ${doc.entryPath}; leaving the file as is`);
			this.releasePulledDoc(doc, hold);
			return { outcome: "history-gap" };
		}
		const remoteText = doc.content;
		const lostSeedFirstWrite = firstWriteWithoutLostSeed(doc.crdtDoc);
		const vaultContentsAfter = await this.readVaultContents(doc);
		if (aborted()) {
			this.releasePulledDoc(doc, hold);
			return { outcome: "aborted" };
		}
		if (lostSeedFirstWrite && sameTextContent(remoteText, vaultContentsAfter)) {
			noteLostSeedTextOnDisk(doc.crdtDoc);
		}
		if (
			vaultContentsAfter === vaultContentsBefore &&
			!sameTextContent(remoteText, vaultContentsAfter) &&
			doc.vaultShare.folderIndex.tracks(doc.entryPath)
		) {
			onPhase?.("sync-base");
			const syncBase = await doc.getSyncBase();
			// A peer's new note whose text reached the relay after this
			// client's initial fetch gave up on it (fetchDocument() only
			// retries an empty relay doc for a bounded time) has no base and
			// no file: nothing local can be lost, so write it instead of
			// waiting for a restart to fetch it again. Live: 54 chars sat in
			// the receiver's CRDT with no file on disk.
			const missingOnDisk =
				syncBase === undefined &&
				vaultContentsAfter === "" &&
				remoteText !== "" &&
				!(await doc.vaultShare.hasFile(doc));
			if (missingOnDisk) {
				// Never recreate a folder the user is deleting; otherwise a
				// removed or renamed parent must exist before the write.
				if (doc.vaultShare.isDeletePending(doc.entryPath)) {
					this.releasePulledDoc(doc, hold);
					return { outcome: "unchanged", remoteText };
				}
				await doc.vaultShare.ensureParentDir(doc.entryPath);
			}
			if (aborted()) {
				this.releasePulledDoc(doc, hold);
				return { outcome: "aborted" };
			}
			const unseeded =
				syncBase === undefined &&
				remoteText === "" &&
				hasPreservableContent(vaultContentsAfter) &&
				neverHeldText(doc.crdtDoc, doc.crdtDoc.getText("contents"));
			const confirmed =
				unseeded &&
				unseededSince !== undefined &&
				this.clock.now() - unseededSince >= UNSEEDED_CONFIRM_MS;
			if (unseeded && !confirmed) {
				this.unseededSince.set(doc.entityGuid, unseededSince ?? this.clock.now());
			}
			if (confirmed) {
				// The note reached the relay as an entry, its text never did:
				// not one item, so no peer wrote or cleared it, and the file is
				// the only copy of the text. A restart re-queues an upload only
				// for a note the relay never acknowledged, so without this the
				// text stayed on its author's disk and every other client kept
				// the note empty (0.1.7 author, 58 chars, still missing on
				// 0.1.30). Only once a later pull, on its own connection, still
				// finds it so: see UNSEEDED_CONFIRM_MS. Seeded here, on this
				// pull's connection, not by a queued upload: an upload would
				// reconcile whatever a peer wrote meanwhile.
				// Released however the seed ends: a rejected base write must
				// not leave this pull's connection open.
				try {
					const outcome = await this.seedUnseededText(doc, aborted, onPhase);
					return { outcome, remoteText: doc.content };
				} finally {
					this.releasePulledDoc(doc, hold);
				}
			}
			if (syncBase === undefined && !missingOnDisk) {
				// Never round-tripped through a successful upload cycle for
				// this doc -- can't tell a genuine unsynced edit apart from
				// our own in-flight seed racing this read. Leave
				// it for uploadDocumentViaSocket() to reconcile properly.
				this.releasePulledDoc(doc, hold);
				return { outcome: "no-base", remoteText };
			}
			if (aborted()) {
				this.releasePulledDoc(doc, hold);
				return { outcome: "aborted" };
			}
			if (syncBase !== undefined && sameTextContent(remoteText, syncBase) && vaultContentsAfter !== "") {
				// The relay has NOT moved since this client last confirmed
				// agreeing with it: the only divergence is this client's OWN
				// edit, still on its way to the relay. Nothing is waiting to be
				// pulled, and overwriting the file here would revert the
				// author's edit on disk right after they made it (the pending
				// upload then re-reads the reverted file and pushes nothing --
				//). Leave the file alone and make sure the edit is
				// actually pushed: the upload lane is the one designated
				// pusher, this method never writes the Y.Doc.
				//
				// An EMPTY file is excluded: readVaultContents() returns "" for a
				// genuinely empty file and on a read error, and the upload path
				// skips reconcile for empty vault content, so handing it over
				// would neither restore nor push anything and just re-enqueue
				// every tick. That case keeps the previous behaviour below.
				this.log(
					`[pullIfUnchanged] relay unchanged since last sync for ${doc.entryPath}; ` +
						`keeping local edit and queueing its upload`,
				);
				this.releasePulledDoc(doc, hold);
				void this.enqueueUpload(doc, { priority: true }).catch((err: unknown) => {
					this.warn("[pullIfUnchanged] queueing upload of local edit failed", doc.entryPath, err);
				});
				return { outcome: "kept-local", remoteText };
			}
			onPhase?.("preserve");
			// An empty read means a file that is not on disk yet (or an empty
			// one): there is nothing to preserve, only the relay text to write.
			// A seed hole that counts as lost may have held text this file
			// still has: the first write without it keeps whatever it drops.
			const dropsLostSeedText =
				lostSeedFirstWrite &&
				hasPreservableContent(vaultContentsAfter) &&
				!keepsAllText(vaultContentsAfter, remoteText);
			if (
				(syncBase !== undefined &&
					hasPreservableContent(vaultContentsAfter) &&
					!sameTextContent(vaultContentsAfter, syncBase)) ||
				dropsLostSeedText
			) {
				// The vault file doesn't just differ from the relay's CURRENT
				// content -- it differs from what THIS client last confirmed
				// agreeing with the relay on. That's a genuine unsynced local
				// edit (e.g. app.vault.modify() with no live editor binding),
				// not staleness from our own in-flight push. Preserve it
				// before overwriting -- never silently discard, same
				// invariant as reconcileRelayContent()/
				// reconcileWithConflictCopy.
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				await doc.vaultShare.writeConflictCopy(
					doc,
					vaultContentsAfter,
					`relay conflict ${timestamp}`,
				);
				this.log(
					`[pullIfUnchanged] preserved unsynced local edit as conflict copy before ` +
						`overwrite for ${doc.entryPath}`,
				);
			}
			// The conflict-copy write above can outlast the caller's deadline.
			// Stop before overwriting: the vault file still holds the local
			// text (and now a copy of it), so leaving it is always safe.
			if (aborted()) {
				this.releasePulledDoc(doc, hold);
				return { outcome: "aborted" };
			}
			// Point of no return: the overwrite and the sync-base update below
			// run as one unit. Callers must not abort past this phase; a
			// deadline here only stops waiting for it (see the poller).
			onPhase?.("write");
			// MUST be awaited, not fire-and-forgotten: CrdtBackgroundSyncPoller
			// (this method's only caller) tracks in-flight calls to this method
			// in its own `pulling` set precisely so the SAME doc's guid can't be
			// re-queued for another pullIfUnchanged() pass while one is still
			// running (see that file's own doc comment) -- but it only clears
			// `pulling` in a `.finally()` on the promise THIS method returns.
			// Returning before the disk write actually lands would release that
			// guid early, opening a window for a concurrent write to the same
			// vault file (e.g. the next 10s poll tick, or this doc going back
			// online and picking up a live-editor flush) to race this one --
			// exactly the shape of bug already fixed once in this file for a
			// conflict-copy write and again for reconcile
			// fast-paths. The log line below also asserts the flush
			// already happened, which would be a lie without the await.
			await doc.vaultShare.writeContents(doc, remoteText);
			// Deliberately NO abort check from here on: once the overwrite has
			// landed the base must follow the disk, or the next pull reads our
			// own delivered text as a local edit and writes a spurious conflict
			// copy. A write already handed to the vault can't be
			// taken back; what cancellation guarantees is that no write STARTS
			// after it.
			// The file now holds exactly what the relay holds, so THIS is the
			// new last-agreed content. Without recording it the base stays at
			// whatever the last upload cycle left, and the next pull of the
			// same file reads our own just-delivered text as "differs from the
			// base" -- a genuine unsynced local edit -- and writes it out as a
			// "relay conflict" copy (which then syncs to every participant).
			// Measured live: one spurious copy per delivered edit on
			// the receiver, from the second edit on.
			await doc.setSyncBase(remoteText);
			if (lostSeedFirstWrite) noteLostSeedTextOnDisk(doc.crdtDoc);
			this.log(`[pullIfUnchanged] flushed remote update to disk for ${doc.entryPath}`);
			this.releasePulledDoc(doc, hold);
			return { outcome: "flushed", remoteText };
		}

		this.releasePulledDoc(doc, hold);
		return { outcome: "unchanged", remoteText };
	}

	/**
	 * Drops the connection pullIfUnchanged() opened, unless the doc was
	 * already online, is being edited, or a newer pull took it over.
	 */
	private releasePulledDoc(doc: Document, hold: PullHold | undefined): void {
		if (!hold) return;
		const owner = this.pullHolds.get(doc.entityGuid);
		if (owner && owner !== hold) return;
		this.pullHolds.delete(doc.entityGuid);
		if (doc.editLock) return;
		if (this.syncLane.inFlight.has(doc.entityGuid)) {
			// An upload of a local edit is queued or running on this
			// connection: it closes it when done.
			this.handedToUpload.add(doc.entityGuid);
			return;
		}
		doc.goOffline();
		doc.vaultShare.credentialCache.dropFromQueue(ResourceAddress.serialize(doc.resourceAddress));
	}

	/** Ends `hold`, unless another pull owns the connection now. */
	private dropPullHold(doc: Document, hold: PullHold): void {
		if (this.pullHolds.get(doc.entityGuid) === hold) this.pullHolds.delete(doc.entityGuid);
	}

	/** Closes a pull connection handed to an upload that ended without closing it. */
	private closeHandedConnection(entry: TransferTask["syncEntry"]): void {
		if (!this.handedToUpload.delete(entry.entityGuid)) return;
		if (!isDocument(entry) || entry.editLock || this.pullHolds.has(entry.entityGuid)) return;
		entry.goOffline();
		entry.vaultShare.credentialCache.dropFromQueue(ResourceAddress.serialize(entry.resourceAddress));
	}

	/** Resolves `promise` or `undefined` on timeout, whichever comes first -- never rejects. */
	private raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
		return Promise.race([
			promise,
			new Promise<undefined>((resolve) =>
				this.clock.scheduleTimeout(() => resolve(undefined), ms),
			),
		]);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => this.clock.scheduleTimeout(resolve, ms));
	}

	/**
	 * Resolves once `doc`'s text fingerprints to `expected()`, after `maxMs`, or on abort.
	 *
	 * Under load the relay can answer a connect from a room it is still
	 * loading and then push nothing more to that connection (see
	 * uploadDocumentViaSocket()). Measured on 0.1.24 under an 800-note bulk
	 * load: three edits waited 20-38s connected for text the relay already
	 * had, while a fresh connect synced in under half a second. So a pull
	 * that owns its connection (`reconnect` set) asks again on a new one
	 * when the text is still missing after AWAIT_CONTENT_RECONNECT_MS, then
	 * after twice that, and so on: many stuck pulls must not pile connects
	 * onto a relay that is already slow. No reconnect starts once the wait
	 * has less than one interval left.
	 */
	private async awaitText(
		doc: Document,
		expected: () => string | undefined,
		maxMs: number,
		aborted: () => boolean,
		reconnect?: () => Promise<void>,
	): Promise<void> {
		const until = this.clock.now() + maxMs;
		let askedAt = this.clock.now();
		let interval = AWAIT_CONTENT_RECONNECT_MS;
		while (!aborted() && this.clock.now() < until) {
			const want = expected();
			if (want === undefined || textFingerprint(doc.content) === want) return;
			const now = this.clock.now();
			if (reconnect && now - askedAt >= interval && until - now >= interval) {
				await reconnect();
				askedAt = this.clock.now();
				interval *= 2;
				continue;
			}
			await this.delay(AWAIT_CONTENT_CHECK_MS);
		}
	}

	/**
	 * Measures the relay alone: token + socket connect of `doc`, then the
	 * first sync of that connection. Lets a load test tell a slow relay apart
	 * from a client queueing problem. `undefined` when `doc` is already
	 * connected (an open editor), since that would measure nothing.
	 */
	async probeRelay(doc: Document): Promise<RelayProbeSample | undefined> {
		if (doc.connectionIntent !== "disconnected") return undefined;
		const hold: PullHold = {};
		this.pullHolds.set(doc.entityGuid, hold);
		const at = this.clock.now();
		// Socket timings are wall-clock (YSweetProvider.connectTrace).
		const wallAt = Date.now();
		const online = doc.bringOnline().then((ok) => (ok ? doc.onceOnline().then(() => true) : false));
		let connected = false;
		try {
			connected = (await this.raceTimeout(online, PROBE_PHASE_TIMEOUT_MS)) ?? false;
			const connectedAt = this.clock.now();
			const synced =
				connected &&
				(await this.raceTimeout(doc.onceFreshlySynced().then(() => true), PROBE_PHASE_TIMEOUT_MS)) === true;
			return {
				at,
				connectMs: connectedAt - at,
				syncMs: this.clock.now() - connectedAt,
				ok: synced,
				phases: this.connectPhases(doc, wallAt),
			};
		} finally {
			// releasePulledDoc() leaves a document opened in the editor meanwhile (editLock) connected.
			const release = () => this.releasePulledDoc(doc, hold);
			release();
			// A connect that lands after the timeout must not stay open.
			if (!connected) void online.then(release, () => undefined);
		}
	}

	private connectPhases(doc: Document, startedAt: number): RelayProbeSample["phases"] {
		const trace = doc._liveProvider?.connectTrace;
		if (!trace) return undefined;
		const since = (t?: number) => (t === undefined || t < startedAt ? undefined : t - startedAt);
		// connect() was not called in this probe (the token request failed): the rest is an older attempt's.
		if (trace.calledAt < startedAt) return { tokenMs: doc.lastTokenMs, failedSockets: 0 };
		return {
			tokenMs: doc.lastTokenMs,
			connectCallMs: since(trace.calledAt),
			queuedMs: since(trace.queuedAt),
			socketMs: since(trace.socketAt),
			openMs: since(trace.openAt),
			skipped: trace.skipped,
			failedSockets: trace.failedSockets,
		};
	}

	/**
	 * Synchronously reads the document/canvas's CURRENT Y.Doc content, in the
	 * exact same shape `uploadDocumentViaSocket` used to read it inline. Must
	 * only ever be called after `await doc.awaitFirstSync()` (Document) /
	 * `await doc.awaitFirstSync()` (CanvasDocument) has resolved — see the
	 * comment on that await above.
	 */
	private readSyncedContent(doc: Document | CanvasDocument): {
		text: string;
		canvasData: CanvasData | null;
	} {
		if (isCanvasDocument(doc)) {
			// Store the exported canvas data rather than a stringified version
			const canvasData = CanvasDocument.exportData(doc.crdtDoc);
			return { text: JSON.stringify(canvasData), canvasData };
		}
		if (isDocument(doc)) {
			return { text: doc.content, canvasData: null };
		}
		return { text: "", canvasData: null };
	}

	private async readVaultContents(doc: Document | CanvasDocument): Promise<string> {
		try {
			return await doc.vaultShare.readContents(doc);
		} catch {
			// File does not exist
			return "";
		}
	}

	private contentsAreInSync(
		doc: Document | CanvasDocument,
		synced: { text: string; canvasData: CanvasData | null },
		vaultContents: string,
	): boolean {
		if (isCanvasDocument(doc) && synced.canvasData) {
			// For canvas, use deep object comparison instead of string equality
			const vaultJson = vaultContents
				? (JSON.parse(vaultContents) as unknown)
				: { nodes: [], edges: [] };
			return deepValueEquals(synced.canvasData, vaultJson);
		}
		return sameTextContent(synced.text, vaultContents);
	}

	private isRelayLinked(doc: Document | CanvasDocument): boolean {
		return !!doc.vaultShare.workspaceId;
	}

	private async awaitProviderSyncWithTimeout(
		doc: Document | CanvasDocument,
		providerSynced: Promise<void>,
	): Promise<boolean> {
		const timeout = new Promise<void>((_, reject) =>
			window.setTimeout(() => reject(new Error("WS sync timeout")), 30000),
		);
		try {
			await Promise.race([providerSynced, timeout]);
			return true;
		} catch {
			this.warn("[uploadDocumentViaSocket] timed out for", doc.entryPath);
			if (!(isDocument(doc) ? doc.editLock : doc.editLock)) {
				doc.goOffline();
			}
			return false;
		}
	}

	/**
	 * Seeds the file into a note whose relay text never held an item, on the
	 * connection of the pull that confirmed it (see pullIfUnchanged()). Only
	 * seeds: under the init claim, and only if the text still never held an
	 * item once the claim settled and the file was read. A peer's text or
	 * clear that arrived meanwhile is left as it is, file included. Like the
	 * rest of the pull it writes nothing once `aborted()`; the insert is its
	 * point of no return ("write" phase), so the caller's deadline cannot
	 * free the slot for another pull while it still holds the connection.
	 */
	private async seedUnseededText(
		doc: Document,
		aborted: () => boolean,
		onPhase: PullControl["onPhase"],
	): Promise<"seed-local" | "no-base" | "aborted"> {
		const text = doc.crdtDoc.getText("contents");
		claimInitIfUnclaimed(doc.crdtDoc, doc._liveProvider.awareness);
		await awaitClaimSettled(doc.crdtDoc, { socket: doc._liveProvider.ws });
		if (aborted()) return "aborted";
		const fileContents = await this.readVaultContents(doc);
		if (aborted()) return "aborted";
		if (
			!hasPreservableContent(fileContents) ||
			!neverHeldText(doc.crdtDoc, text) ||
			hasHistoryGap(doc.crdtDoc) ||
			!wonInitClaim(doc.crdtDoc, text)
		) {
			this.log(`[pullIfUnchanged] ${doc.entryPath} is no longer unseeded; not seeding it`);
			return "no-base";
		}
		onPhase?.("write");
		this.log(`[pullIfUnchanged] relay never held text for ${doc.entryPath}; seeding the file`);
		text.insert(0, fileContents);
		markInitDone(doc.crdtDoc);
		await waitForBufferFlush(doc._liveProvider.ws);
		// The seeded text is what the file and the relay agreed on, even if a
		// peer has edited it since: the next pull applies that edit as a diff
		// against it. Without a base every later pull stops at "no-base" and
		// the file never gets the peer's edit. A file changed meanwhile is a
		// local edit, not that agreement: no base then.
		const diskContents = await this.readVaultContents(doc);
		if (sameTextContent(fileContents, diskContents)) await doc.setSyncBase(fileContents);
		return "seed-local";
	}

	/**
	 * The relay-linked reconcile branch of `uploadDocumentViaSocket`: either
	 * seeds a genuinely-empty relay document from the vault file (guarded by
	 * initContentClaim.ts against a second client racing the same insert —
	 * see that module's doc comment, ), or reconciles a
	 * relay document whose synced text differs from the vault file by
	 * preserving the relay's prior content as a conflict copy before
	 * overwriting. Always waits for the resulting update
	 * to actually leave the local send buffer before the caller may
	 * disconnect — a fixed timer isn't long enough for a
	 * large diff on a slow link.
	 */
	private async reconcileRelayContent(
		doc: Document,
		vaultContents: string,
	): Promise<boolean> {
		if (doc.editLock) return true;
		const syncedText = doc.content;
		if (!syncedText) {
			// Two clients opening the same brand-new shared folder at once
			// would otherwise BOTH insert here and Yjs would merge both
			// blocks (duplicated text, ) — claim a slot first, give a
			// concurrent claim from another client a settle window to
			// arrive over the relay, then only the deterministic winner
			// inserts. See initContentClaim.ts for the mechanism.
			claimInitIfUnclaimed(doc.crdtDoc, doc._liveProvider.awareness);
			await awaitClaimSettled(doc.crdtDoc, { socket: doc._liveProvider.ws });
			// The claim also yields to concurrent edits. Seed the latest file,
			// and check ownership after the read in case a peer inserted meanwhile.
			const currentVaultContents = await this.readVaultContents(doc);
			if (doc.editLock) return true;
			const text = doc.crdtDoc.getText("contents");
			if (currentVaultContents && wonInitClaim(doc.crdtDoc, text)) {
				this.log(
					`[uploadDocumentViaSocket] Uploading new content for ${doc.entryPath} (${currentVaultContents.length} chars)`,
				);
				text.insert(0, currentVaultContents);
				markInitDone(doc.crdtDoc);
			} else if (text.length === 0) {
				this.warn(
					`[uploadDocumentViaSocket] Skipped initial-content insert for ${doc.entryPath} — lost the init claim to a concurrently-connecting client`,
				);
			}
		} else if (!sameTextContent(syncedText, vaultContents)) {
			// `syncedText` diverges from the vault file. That alone doesn't
			// tell us whether the RELAY moved (another client's edit just
			// merged in via the bringOnline()/onceProviderSynced() call above --
			// a genuine conflict) or only WE did (this client wrote the vault
			// file directly, e.g. via `app.vault.modify()` with no live editor
			// binding -- see main.ts's `!file.connected` branch -- and this is
			// simply that edit not having reached the Y.Doc yet). A plain text
			// diff between `syncedText` and `vaultContents` can't distinguish
			// those two cases either.
			//
			// The sync base can: it's `doc.content` as of the last time THIS
			// client confirmed agreement with the relay (set at the bottom of
			// uploadDocumentViaSocket). If the relay's text hasn't moved since
			// then, `syncedText` still equals the base, and today's divergence
			// can only be our own not-yet-applied edit -- safe to apply
			// directly. If the relay HAS moved (or we've never recorded a base
			// for this doc), a real divergence is possible, and we fall back to
			// preserving as before -- noisy-but-safe over silently discarding
			// someone else's edit.
			const base = await doc.getSyncBase();
			if (doc.editLock) return true;
			if (doc.content !== syncedText) return false;
			if (base !== undefined && base === syncedText) {
				// This snapshot alone can't tell "only I moved" apart from "a
				// GENUINELY CONCURRENT client is about to reach the exact same
				// conclusion against the exact same stale base" --
				// two clients editing at the same moment can both observe
				// `base === syncedText` before either has received the other's
				// broadcast, both take this fast path, and Yjs concatenates
				// their two unrelated bulk inserts with no conflict-copy on
				// either side. Same fix shape as initContentClaim.ts's // claim for the sibling "two clients seed the same brand-new
				// doc" race -- see reconcileClaim.ts's doc comment.
				// awaitReconcileSettled() is documented to resolve within its
				// own maxWaitMs (3000ms default).: live CDP
				// console capture during the two-client restart race never
				// caught a thrown/swallowed rejection on this path, but it
				// also never captured this settle call outliving its own
				// contract in isolation -- the original 13+s-silent runs were
				// racing pullIfUnchanged()'s pre-fix silent overwrite
				//, which this call has no visibility into (it
				// only watches doc.crdtDoc's own META_MAP, never the vault
				// file). Whether awaitReconcileSettled() itself can still
				// outlive 3000ms under some untested interleaving was not
				// proven either way. An OUTER bound here costs nothing in the
				// normal case (it only ever fires after the inner contract
				// should already have resolved) and removes the risk
				// regardless of which explanation is right -- same invariant
				// as pullIfUnchanged's fix: never let an unbounded/unproven
				// wait silently gate whether a real local edit gets preserved.
				claimReconcile(doc.crdtDoc);
				// raceTimeout()'s "timed out" sentinel is `undefined` -- but
				// awaitReconcileSettled() returns Promise<void>, whose OWN
				// resolved value is also `undefined`. Without the `.then(()
				// => true)`, a genuine successful settle would be
				// indistinguishable from a timeout and get treated as one.
				const settled = await this.raceTimeout(
					awaitReconcileSettled(doc.crdtDoc, { socket: doc._liveProvider.ws }).then(
						() => true,
					),
					RECONCILE_SETTLE_OUTER_TIMEOUT_MS,
				);
				if (doc.editLock) return true;
				if (settled === undefined) {
					this.warn(
						`[uploadDocumentViaSocket] reconcile claim settle exceeded its own ` +
							`${RECONCILE_SETTLE_OUTER_TIMEOUT_MS}ms outer bound for ${doc.entryPath} -- ` +
							`treating as lost, preserving vault content rather than risk applying ` +
							`against a claim state that never confirmed settled`,
					);
					if (!await this.reconcileWithVaultFileSafely(doc, vaultContents, syncedText)) return false;
				} else if (wonReconcileClaim(doc.crdtDoc) && doc.content === base) {
					// Won the claim AND the settled text still matches what we
					// started with -- re-checked, not assumed, in case some
					// THIRD update landed during the settle window itself.
					applyDiffToYText(doc.crdtDoc, vaultContents, undefined);
					this.log(
						`[uploadDocumentViaSocket] Reconciled ${doc.entryPath} with vault file, ` +
							`no conflict copy needed — relay text unchanged since our last sync, ` +
							`won reconcile claim (relay=${syncedText.length}, vault=${vaultContents.length})`,
					);
				} else {
					// Lost the claim to a concurrently-reconciling client (its
					// own fast-path apply, if any, may already be sitting in
					// the Y.Doc), or a third update landed mid-settle. Either
					// way this client's edit is still real and unsynced --
					// fall back to the safe, conflict-preserving path below
					// rather than risk the concatenation this claim exists to
					// prevent.
					if (!await this.reconcileWithVaultFileSafely(doc, vaultContents, syncedText)) return false;
				}
			} else {
				if (!await this.reconcileWithVaultFileSafely(doc, vaultContents, syncedText)) return false;
			}
		}

		// Wait for the reconcile update to actually leave the local send
		// buffer before disconnecting, instead of hoping a fixed 1000ms
		// window was long enough — a large diff on a slow link can still
		// be sitting in bufferedAmount well past a fixed timer, and
		// disconnecting at that point drops it silently.
		await waitForBufferFlush(doc._liveProvider.ws);
		return true;
	}

	/**
	 * The conflict-preserving reconcile path: whatever the Y.Doc CURRENTLY
	 * holds (read fresh inside reconcileWithConflictCopy() itself, not from
	 * `priorSyncedText` — that parameter is only for the log line) may
	 * include edits from OTHER clients that just merged in, or from the
	 * winner of a reconcileClaim race; a plain text diff can't
	 * tell those apart from this device's own unsynced edits, so before
	 * rewriting the Y.Doc to match the vault file we preserve whatever it
	 * currently holds as a conflict-copy file — nothing is silently
	 * discarded, and if the preserve step itself fails we skip reconciling
	 * rather than risk it.
	 */
	private async reconcileWithVaultFileSafely(
		doc: Document,
		vaultContents: string,
		priorSyncedText: string,
	): Promise<boolean> {
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const result = await reconcileWithConflictCopy(
			doc.crdtDoc,
			vaultContents,
			(relayContent) =>
				doc.vaultShare.writeConflictCopy(doc, relayContent, `relay conflict ${timestamp}`),
			undefined,
			(...args) => this.log("[uploadDocumentViaSocket]", ...args),
			() => !doc.editLock,
		);
		if (result.reconciled) {
			this.log(
				`[uploadDocumentViaSocket] Reconciled ${doc.entryPath} with vault file ` +
					`(relay=${priorSyncedText.length}, vault=${vaultContents.length}); ` +
					`prior relay content preserved at ${result.conflictPath}`,
			);
		} else {
			this.warn(
				`[uploadDocumentViaSocket] Skipped reconciliation for ${doc.entryPath} — ` +
					`could not safely preserve relay content before overwriting`,
			);
		}
		return result.reconciled || sameTextContent(doc.content, vaultContents);
	}

	/**
	 * Enqueues a document to be downloaded from the server
	 * @param canvas The canvas to download
	 * @returns A promise that resolves when the download completes
	 */
	enqueueCanvasFetch(canvas: CanvasDocument): Promise<void> {
		return this.enqueueFetch(canvas);
	}

	async fetchCanvas(canvas: CanvasDocument, retry = 3, wait = 3000) {
		// Relay-linked canvases sync over the WebSocket; see fetchDocument().
		if (this.isRelayLinked(canvas)) {
			await this.fallbackToWebsocketSync(canvas, "fetchCanvas", () =>
				canvas.vaultShare.writeContents(canvas, canvas.canvasJson),
			);
			return;
		}

		try {
			// Get the current contents before applying the update
			const currentJson = CanvasDocument.exportData(canvas.crdtDoc);
			let currentFileContents: CanvasData = { edges: [], nodes: [] };
			try {
				const stringContents = await canvas.vaultShare.readContents(canvas);
				currentFileContents = JSON.parse(stringContents) as CanvasData;
			} catch {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch =
				deepValueEquals(currentJson.edges, currentFileContents.edges) &&
				deepValueEquals(currentJson.nodes, currentFileContents.nodes);
			const hasContents = currentFileContents.nodes.length > 0;

			const response = await this.fetchItem(canvas);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			this.log("[fetchCanvas] applying content from server");
			Y.applyUpdate(canvas.crdtDoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (canvas.vaultShare.folderIndex.tracks(canvas.entryPath)) {
				void canvas.vaultShare.writeContents(canvas, canvas.canvasJson);
				this.log("[fetchCanvas] flushed");
			}
		} catch (e: unknown) {
			// HTTP download failed (e.g., CWT tokens not accepted for HTTP endpoints).
			// Fall back to WebSocket sync for the canvas content.
			this.warn(
				"[fetchCanvas] HTTP download failed, falling back to WS sync:",
				(e as Error).message,
			);
			await this.fallbackToWebsocketSync(canvas, "fetchCanvas", () =>
				canvas.vaultShare.writeContents(canvas, canvas.canvasJson),
			);
		}
	}

	/**
	 * `slowRounds`: once the fast retry budget is spent while a known-remote doc
	 * still reads empty, re-fetch this many more times, one attempt per round on
	 * the SLOW_REFETCH_SCHEDULE_MS delays, before accepting it as a genuinely
	 * empty note. Writing a 0-byte file earlier is permanent -- it looks
	 * "present" to every later pass (#266).
	 */
	private async fetchDocument(
		doc: Document,
		retry = 3,
		wait = 3000,
		slowRounds = SLOW_REFETCH_SCHEDULE_MS.length,
	) {
		// Relay-linked docs sync over the WebSocket: skip the HTTP
		// `as-update` round trip that would only fall back to it anyway.
		// Under bulk syncs it used to fire once per fetched doc and log an
		// error each time.
		if (this.isRelayLinked(doc)) {
			await this.fetchDocumentViaWebsocket(doc, retry, wait, slowRounds);
			return;
		}

		try {
			// Get the current contents before applying the update
			const currentText = doc.content;
			let currentFileContents = "";
			try {
				currentFileContents = await doc.vaultShare.readContents(doc);
			} catch {
				// File doesn't exist
			}

			// Only proceed with update if file matches current ydoc state
			const contentsMatch = currentText === currentFileContents;
			const hasContents = currentFileContents !== "";

			const response = await this.fetchItem(doc);
			const rawUpdate = response.arrayBuffer;
			const updateBytes = new Uint8Array(rawUpdate);

			// Check for newly created documents without content, and reject them
			const newDoc = new Y.Doc();
			Y.applyUpdate(newDoc, updateBytes);
			const users = newDoc.getMap("users");
			const contents = newDoc.getText("contents").toJSON();

			if (contents === "") {
				if (users.size === 0) {
					// Hack for better compat with < 0.4.2.
					this.log(
						"[getDocument] Server contains uninitialized doc — waiting for peer to upload.",
						users.size,
						retry,
						wait,
					);
					if (retry > 0) {
						this.clock.scheduleTimeout(() => {
							void this.fetchDocument(doc, retry - 1, wait * 2, slowRounds);
						}, wait);
					}
					return;
				}
				if (doc.content) {
					this.log(
						"[getDocument] local crdt has contents, but remote is empty",
					);
					void this.enqueueUpload(doc);
					return;
				}
			}

			this.log("[getDocument] applying content from server");
			Y.applyUpdate(doc.crdtDoc, updateBytes);

			if (hasContents && !contentsMatch) {
				this.log("Skipping flush - file requires merge conflict resolution.");
				return;
			}
			if (doc.vaultShare.folderIndex.tracks(doc.entryPath)) {
				void doc.vaultShare.writeContents(doc, doc.content);
				this.log("[getDocument] flushed");
			}
		} catch (e: unknown) {
			// HTTP download failed (e.g., CWT tokens not accepted for HTTP endpoints).
			// Fall back to WebSocket sync for the document content.
			this.warn(
				"[getDocument] HTTP download failed, falling back to WS sync:",
				(e as Error).message,
			);
			await this.fetchDocumentViaWebsocket(doc, retry, wait, slowRounds);
		}
	}

	/**
	 * WebSocket leg of `fetchDocument()`: the only path for relay-linked docs,
	 * and the fallback when the HTTP download fails for any other doc.
	 */
	private async fetchDocumentViaWebsocket(
		doc: Document,
		retry: number,
		wait: number,
		slowRounds: number,
	): Promise<void> {
		// Hold back the flush when the WS sync reports success but leaves
		// doc.content empty and retries remain: this call only ever runs
		// for a path the folder index's OWN metadata says exists on the
		// relay (see _onServerCreate/applyServerRecord's "create" op) --
		// there is no such thing as a legitimately-empty result here on
		// the very first attempt. A relay room the server hasn't loaded
		// into memory yet in this process's lifetime can answer
		// sync-step-2 (and flip `synced`) off a still-loading, effectively
		// empty placeholder before the persisted snapshot has actually
		// landed, and by the time it does this client has already
		// disconnected and lost it for good -- live-confirmed against the
		// self-hosted stand's own "Loading doc" timing racing the
		// connect/disconnect round trip. Same shape as the
		// "uninitialized doc" HTTP-path retry above, applied to the WS
		// path that's actually load-bearing for relay-linked docs (they
		// never take the HTTP path, see fetchDocument()).
		// A history gap reads as empty or partial text: wait for it like for empty text.
		const notReady = () => doc.content === "" || hasHistoryGap(doc.crdtDoc);
		const flushed = await this.fallbackToWebsocketSync(
			doc,
			"getDocument",
			() => doc.vaultShare.writeContents(doc, doc.content),
			// Never while a gap remains, even with no retry left: that text may blank a local edit for good.
			() => !hasHistoryGap(doc.crdtDoc) && !(notReady() && (retry > 0 || slowRounds > 0)),
		);
		if (!flushed && notReady() && retry === 0 && slowRounds > 0) {
			this.warn(
				"[getDocument] still empty after fast retries -- deferring re-fetch instead of writing a 0-byte file",
				doc.entryPath,
				slowRounds,
			);
			if (!doc.editLock) {
				doc.goOffline();
			}
			const step = Math.max(0, SLOW_REFETCH_SCHEDULE_MS.length - slowRounds);
			const delay =
				SLOW_REFETCH_SCHEDULE_MS[Math.min(step, SLOW_REFETCH_SCHEDULE_MS.length - 1)];
			this.clock.scheduleTimeout(() => {
				void this.fetchDocument(doc, 0, wait, slowRounds - 1);
			}, delay);
		} else if (!flushed && notReady() && retry > 0) {
			this.log(
				"[getDocument] WS sync reported success but content is still empty for a known-remote doc — retrying",
				retry,
				wait,
			);
			// Force the connection down before scheduling the retry --
			// live-confirmed that leaving this out makes
			// the retry a no-op: uploadDocumentViaSocket() already calls
			// doc.goOffline() at its own end for an `intent === "disconnected"`
			// doc, which SHOULD leave the provider ready for a fresh connect
			// next time -- but relying on that path alone was insufficient in
			// practice (reproduced live: content still empty after all 3
			// retries, ~25s). Calling it again here, unconditionally, before
			// the retry is scheduled, removes any dependency on exactly which
			// internal branch of that prior call actually ran, and guarantees
			// ProviderBacked.bringOnline()'s own `if (this.isOnline) return
			// true` guard can't short-circuit the next attempt into re-reading
			// whatever the stalled first connection settled on.
			if (!doc.editLock) {
				doc.goOffline();
			}
			this.clock.scheduleTimeout(() => {
				void this.fetchDocument(doc, retry - 1, wait * 2, slowRounds);
			}, wait);
		}
	}

	/**
	 * Shared tail of `fetchCanvas`'/`fetchDocument`'s catch blocks: an HTTP
	 * download failure falls back to a single WebSocket sync pass, flushing
	 * to disk on success. Never throws — a failure here is logged and
	 * swallowed, matching the pre-rewrite per-method catch blocks this
	 * replaces. Returns whether it flushed, so a caller that wants to gate
	 * the write can tell
	 * "synced but held back" apart from "synced and wrote".
	 *
	 * `flush` MUST be awaited here, not fired-and-forgotten: this method's
	 * caller (fetchCanvas()/fetchDocument()) is itself what `drainLane()`
	 * awaits via `lane.run(item)` before it clears `lane.inFlight` and
	 * resolves any `enqueueFetch()` waiter (TransferQueue.ts's queue-lane
	 * bookkeeping, above) -- a caller of `enqueueFetch()` is entitled to
	 * assume the file is actually on disk once its await returns. Letting
	 * `flush()` race past that would repeat the exact class of bug this file
	 * has already shipped fixes for (relay-linked doc reconciliation
	 * silently overwriting/dropping edits, #51/#52; buffered-write-vs-
	 * disconnect races, #74) -- just moved from the happy path into this
	 * shared HTTP-download-failed fallback tail.
	 */
	private async fallbackToWebsocketSync(
		doc: Document | CanvasDocument,
		label: string,
		flush: () => Promise<void>,
		shouldFlush: () => boolean = () => true,
	): Promise<boolean> {
		try {
			const synced = await this.uploadDocumentViaSocket(doc);
			if (synced && !(isDocument(doc) && doc.editLock) && doc.vaultShare.folderIndex.tracks(doc.entryPath) && shouldFlush()) {
				await flush();
				this.log(`[${label}] WS sync fallback successful, flushed to disk`);
				return true;
			}
			return false;
		} catch (wsError: unknown) {
			this.error(`[${label}] WS sync fallback also failed:`, wsError);
			return false;
		}
	}

	private async uploadAttachment(file: AttachmentFile) {
		await file.runSync();
	}

	private async fetchAttachment(file: AttachmentFile) {
		await file.pullFromRemote();
	}

	private async uploadDocument(doc: Document | CanvasDocument, priority: boolean) {
		try {
			if (isDocument(doc) || isCanvasDocument(doc)) {
				const synced = await this.uploadDocumentViaSocket(doc);
				if (synced) this.clearUploadRetry(doc.entityGuid);
				else if (this.isRelayLinked(doc)) this.scheduleUploadRetry(doc, priority);
			}
		} catch (e: unknown) {
			console.error(e);
			this.clearUploadRetry(doc.entityGuid);
			return;
		}
	}

	/**
	 * Re-queues an upload that came back unsynced, with backoff. After the
	 * last delay the share's periodic pass is what picks it up again.
	 */
	private scheduleUploadRetry(doc: Document | CanvasDocument, priority: boolean): void {
		if (!this.clock) return;
		const retry = this.uploadRetries.get(doc.entityGuid) ?? { attempt: 0 };
		if (retry.timer !== undefined) return;
		this.uploadRetryStats.failed++;
		const delay = UPLOAD_RETRY_DELAYS_MS[retry.attempt];
		if (delay === undefined) {
			this.uploadRetries.delete(doc.entityGuid);
			this.uploadRetryStats.gaveUp++;
			this.warn("[uploadRetry] giving up for now on", doc.entryPath);
			return;
		}
		retry.attempt++;
		retry.timer = this.clock.scheduleTimeout(() => {
			retry.timer = undefined;
			if (!this.clock) return;
			// Deleted, renamed away or its share went offline meanwhile: the
			// share's own reconnect or next pass covers what is still there.
			const share = doc.vaultShare;
			if (share.trackedEntries?.get(doc.entityGuid) !== doc || !share.isOnline) {
				this.uploadRetries.delete(doc.entityGuid);
				return;
			}
			this.uploadRetryStats.retried++;
			void this.enqueueUpload(doc, { priority }).catch((error: unknown) =>
				this.warn("[uploadRetry] failed for", doc.entryPath, error),
			);
		}, delay);
		this.uploadRetries.set(doc.entityGuid, retry);
	}

	private clearUploadRetry(entityGuid: string): void {
		const retry = this.uploadRetries.get(entityGuid);
		if (!retry) return;
		if (retry.timer !== undefined) this.clock?.cancelTimeout(retry.timer);
		this.uploadRetries.delete(entityGuid);
	}

	onUploadChange(
		callback: Subscriber<NotifierSet<TransferTask>>,
	): Unsubscriber {
		return this.activeUploads.subscribe(callback);
	}

	onFetchChange(
		callback: Subscriber<NotifierSet<TransferTask>>,
	): Unsubscriber {
		return this.activeFetches.subscribe(callback);
	}

	onBatches(
		callback: Subscriber<NotifierMap<VaultShare, TransferBatch>>,
	): Unsubscriber {
		return this.batches.subscribe(callback);
	}

	onProgress(callback: Subscriber<TransferProgress>): Unsubscriber {
		const handler = () => callback(this.overallProgress());

		const unsubscribers = [
			this.activeUploads.subscribe(() => handler()),
			this.activeFetches.subscribe(() => handler()),
			this.batches.subscribe(() => handler()),
		];

		return () => unsubscribers.forEach((off) => off());
	}

	/**
	 * Subscribes to progress updates for a specific shared folder
	 *
	 * @param vaultShare The shared folder to monitor
	 * @param callback The function to call when progress changes
	 * @returns A function to unsubscribe
	 */
	onBatchProgress(
		vaultShare: VaultShare,
		callback: Subscriber<BatchProgress | null>,
	): Unsubscriber {
		return this.batches.subscribe(() => {
			callback(this.batchProgress(vaultShare));
		});
	}

	/**
	 * Pauses all sync and download queue processing
	 *
	 * This method temporarily halts processing of sync and download queues.
	 * The queues can be resumed by calling resume().
	 */
	suspend(): void {
		this.paused = true;
	}

	/**
	 * Resumes sync and download queue processing
	 *
	 * This method resumes processing of sync and download queues after
	 * they have been paused.
	 */
	wake(): void {
		this.debug("starting");
		this.paused = false;
		void this.drainLane(this.syncLane);
		void this.drainLane(this.downloadLane);
	}
	begin = () => this.wake();

	/**
	 * Gets the current status of sync and download queues
	 *
	 * @returns An object with queue statistics
	 */
	queueSnapshot(): {
		syncsQueued: number;
		syncsActive: number;
		downloadsQueued: number;
		downloadsActive: number;
		paused: boolean;
	} {
		return {
			syncsQueued: this.syncLane.queue.length,
			syncsActive: this.activeUploads.count,
			downloadsQueued: this.downloadLane.queue.length,
			downloadsActive: this.activeFetches.count,
			paused: this.paused,
		};
	}

	/**
	 * Destroys this instance and cleans up all resources
	 *
	 * This method cleans up all resources used by this instance,
	 * including rejecting pending promises, destroying observable
	 * collections, and clearing queues.
	 */
	shutdown(): void {
		// Reject all pending sync/download promises
		for (const [guid, waiter] of this.syncLane.waiters) {
			waiter.reject(new Error("TransferQueue destroyed"));
			this.syncLane.waiters.delete(guid);
		}
		for (const [guid, waiter] of this.downloadLane.waiters) {
			waiter.reject(new Error("TransferQueue destroyed"));
			this.downloadLane.waiters.delete(guid);
		}

		for (const retry of this.uploadRetries.values()) {
			if (retry.timer !== undefined) this.clock?.cancelTimeout(retry.timer);
		}
		this.uploadRetries.clear();
		this.syncLane.rerun.clear();
		this.downloadLane.rerun.clear();

		// Destroy observable collections
		this.activeUploads.destroy();
		this.activeFetches.destroy();
		this.batches.destroy();

		// Clear queues and tracking
		this.syncLane.queue = [];
		this.downloadLane.queue = [];
		this.syncLane.inFlight.clear();
		this.downloadLane.inFlight.clear();

		// Clean up references
		this.auth = null as unknown as AuthSession;
		this.clock = null as unknown as Clock;

		// Unsubscribe from all subscriptions
		this.teardowns.forEach((off) => off());
	}
}
