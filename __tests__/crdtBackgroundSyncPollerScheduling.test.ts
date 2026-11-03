/**
 * Unit tests: CrdtBackgroundSyncPoller scheduling
 *
 * Covers:
 *   (a) a pull stuck in a phase with no timeout of its own (first-sync,
 *       connect) frees its slot at PULL_DEADLINE_MS, is aborted, and the
 *       timeout is attributed to that phase; other work keeps going. A pull
 *       already in its final write phase is released but not aborted
 *   (b) free slots are handed out round-robin across shares, so a small
 *       share isn't stuck behind a large share's backlog
 *   (c) a document another client announced as changed starts before the
 *       sweep backlog
 *   (d) an announcement whose pulled text doesn't match yet is re-checked;
 *       a matching one records a delivery latency
 *   (e) a share's sweep is refilled only after its pass was handed out
 *   (f) destroy() aborts in-flight pulls and drops announcement listeners
 * Every case except (e) MUST fail on the global-FIFO, no-deadline poller
 * (origin/main@09f889d).
 *
 * Express slot:
 *   (g) an edit announced in one share starts at once while another share's
 *       bulk sync holds every regular slot
 *   (h) a share whose announced pull is already running can't take the
 *       express slot, so a bulk share's announced backlog doesn't hold it
 *   (i) one express pull at a time; regular slots stay at laneLimit
 * (g) and (h) MUST fail on the poller without the express slot
 * (origin/main@d7f58c8).
 *
 * Sweep pass interval (alert 27.10, tokens/relay storm):
 *   (j) a share's next sweep pass starts no sooner than
 *       SWEEP_PASS_INTERVAL_MS after the previous one, while announced
 *       changes are still pulled at once. MUST fail on origin/main@de982fb,
 *       which refilled the sweep on the first tick after a pass drained.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";

const mockIsDocument = jest.fn<(file?: { __isDocument?: boolean }) => boolean>();
jest.mock("src/Document", () => ({
	isDocument: (file?: { __isDocument?: boolean }) => mockIsDocument(file),
}));
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import { MockClock } from "./mocks/MockClock";
import { CrdtBackgroundSyncPoller, PULL_DEADLINE_MS, SWEEP_PASS_INTERVAL_MS } from "src/CrdtBackgroundSyncPoller";
import { textFingerprint, type RemoteActivityListener } from "src/docActivity";
import type { Document } from "src/Document";
import type { PullControl, PullResult } from "src/TransferQueue";
import type { VaultShare } from "src/VaultShare";
import { resetTokenRequestClasses, tokenRequestClass } from "src/auth/tokenRequestClass";

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface FakeFile extends Pick<Document, "isOnline" | "entityGuid" | "entryPath"> {
	isOnline: Document["isOnline"]; // Mutable test connection state.
	__isDocument?: boolean;
}

type PullFn = (file: FakeFile, control: PullControl) => Promise<PullResult>;

interface FakeFolder extends Pick<VaultShare, "workspaceId" | "isOnline" | "path"> {
	isOnline: VaultShare["isOnline"]; // Mutable test connection state.
	trackedEntries: Map<string, FakeFile>;
	transfers: { pullIfUnchanged: jest.Mock<PullFn>; laneLimit: number };
	docActivity: { subscribeRemote: (listener: RemoteActivityListener) => () => void };
	announce: (guid: string, fingerprint: string) => void;
	listenerCount: () => number;
}

/** A pull that only settles when the test says so. */
interface Held {
	file: FakeFile;
	control: PullControl;
	resolve: (result: PullResult) => void;
}

function makeFolder(name: string, docCount: number, pull: jest.Mock<PullFn>, laneLimit = 3): FakeFolder {
	const listeners = new Set<RemoteActivityListener>();
	const trackedEntries = new Map<string, FakeFile>();
	for (let i = 0; i < docCount; i++) {
		const guid = `${name}-${i}`;
		trackedEntries.set(guid, {
			__isDocument: true,
			isOnline: false,
			entityGuid: guid,
			entryPath: `${name}/${i}.md`,
		});
	}
	return {
		workspaceId: "relay-1",
		isOnline: true,
		path: name,
		trackedEntries,
		transfers: { pullIfUnchanged: pull, laneLimit },
		docActivity: {
			subscribeRemote: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		announce: (guid, fingerprint) => listeners.forEach((l) => l(guid, fingerprint)),
		listenerCount: () => listeners.size,
	};
}

function holdingPull(held: Held[]): jest.Mock<PullFn> {
	return jest.fn<PullFn>().mockImplementation(
		(file, control) =>
			new Promise<PullResult>((resolve) => {
				held.push({ file, control, resolve });
			}),
	);
}

function makeRegistry(folders: FakeFolder[]) {
	return { each: (cb: (f: FakeFolder) => void) => folders.forEach(cb) };
}

function startedGuids(pull: jest.Mock<PullFn>): string[] {
	return pull.mock.calls.map(([file]) => file.entityGuid);
}

describe("CrdtBackgroundSyncPoller scheduling", () => {
	let clock: MockClock;
	let t0: number;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		mockIsDocument.mockImplementation((file) => !!file?.__isDocument);
		clock = new MockClock();
		t0 = clock.now();
	});

	test("a pull hung before the connect timeout frees its slot at the deadline, aborted, attributed to its phase", async () => {
		const held: Held[] = [];
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			if (file.entityGuid === "a-0") {
				// Hangs forever inside awaitFirstSync()/IndexedDB.
				control.onPhase?.("first-sync");
				return new Promise<PullResult>(() => undefined);
			}
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const folder = makeFolder("a", 3, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();

		expect(startedGuids(pull)).toEqual(["a-0"]);
		const hungSignal = pull.mock.calls[0][1].signal;
		expect(hungSignal?.aborted).toBe(false);

		clock.setTime(t0 + PULL_DEADLINE_MS - 1);
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0"]);

		clock.setTime(t0 + PULL_DEADLINE_MS);
		await flushPromises();
		expect(hungSignal?.aborted).toBe(true);
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);
		expect(poller.stats().timeouts).toEqual({ "first-sync": 1 });
		expect(poller.stats().inflight).toBe(1);

		// The healthy work behind it completes normally.
		held[0].resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1", "a-2"]);
		poller.destroy();
	});

	test("a deadline in the preserve phase aborts; in the write phase it frees the slot WITHOUT aborting and holds the doc until the write settles", async () => {
		const held: Held[] = [];
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			control.onPhase?.(file.entityGuid === "a-0" ? "write" : "preserve");
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const folder = makeFolder("a", 2, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000, PULL_DEADLINE_MS, 0);
		poller.start();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);

		clock.setTime(t0 + PULL_DEADLINE_MS);
		// MockClock's checkTimers() iterates while callbacks cancel timers, so
		// two deadlines due at the same instant need a second pass.
		clock.setTime(t0 + PULL_DEADLINE_MS + 1);
		await flushPromises();
		const [writing, preserving] = held;
		expect(writing.control.signal?.aborted).toBe(false);
		expect(preserving.control.signal?.aborted).toBe(true);
		expect(poller.stats().inflight).toBe(0);
		expect(poller.stats().timeouts).toEqual({ write: 1, preserve: 1 });

		// Next tick: a-1 is pulled again, a-0 is held back while its write is pending.
		clock.setTime(t0 + 60_000);
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1", "a-1"]);

		// Once the write settles, a-0 is eligible again on the next pass.
		writing.resolve({ outcome: "flushed", remoteText: "x" });
		held[2].resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		clock.setTime(t0 + 120_000);
		await flushPromises();
		expect(startedGuids(pull).filter((g) => g === "a-0")).toHaveLength(2);
		poller.destroy();
	});

	test("slots go round-robin across shares: a small share is not stuck behind a large one", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const big = makeFolder("big", 50, pull, 1);
		const small = makeFolder("small", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([big, small]) as never, 60_000);
		poller.start();

		expect(startedGuids(pull)).toEqual(["big-0"]);
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		// Global FIFO would start big-1 here and reach small-0 only after all 50.
		expect(startedGuids(pull)).toEqual(["big-0", "small-0"]);
		poller.destroy();
	});

	test("an announced change starts before the sweep backlog", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 100, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		expect(pull).toHaveBeenCalledTimes(3);

		folder.announce("s-90", textFingerprint("new text"));
		await flushPromises();
		expect(startedGuids(pull)[3]).toBe("s-90"); // express slot

		// The share's announced pull now runs, so the next one waits for a
		// regular slot -- and still goes ahead of the sweep backlog.
		folder.announce("s-91", textFingerprint("more text"));
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(4);

		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)[4]).toBe("s-91");
		poller.destroy();
	});

	test("a share's next sweep pass waits SWEEP_PASS_INTERVAL_MS; announced changes don't", async () => {
		const pull = jest.fn<PullFn>().mockResolvedValue({ outcome: "unchanged", remoteText: "" });
		const folder = makeFolder("s", 2, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["s-0", "s-1"]);

		// Every tick inside the interval finds the pass drained but too recent.
		for (let t = 60_000; t < SWEEP_PASS_INTERVAL_MS; t += 60_000) {
			clock.setTime(t0 + t);
			await flushPromises();
		}
		expect(pull).toHaveBeenCalledTimes(2);

		folder.announce("s-1", textFingerprint(""));
		await flushPromises();
		expect(startedGuids(pull)[2]).toBe("s-1");

		clock.setTime(t0 + SWEEP_PASS_INTERVAL_MS);
		await flushPromises();
		expect(startedGuids(pull).slice(3)).toEqual(["s-0", "s-1"]);
		poller.destroy();
	});

	test("announced text not there yet is re-checked; once it matches, a delivery latency is recorded", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();

		folder.announce("s-0", textFingerprint("new"));
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(2);

		// Marker beat the content: the relay still says "old".
		clock.setTime(t0 + 500);
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		expect(poller.stats().delivery.count).toBe(0);

		clock.setTime(t0 + 2_500);
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(3);

		clock.setTime(t0 + 3_000);
		held.shift()?.resolve({ outcome: "flushed", remoteText: "new" });
		await flushPromises();
		expect(poller.stats().delivery).toEqual({ count: 1, p50Ms: 3_000, p95Ms: 3_000, maxMs: 3_000 });
		poller.destroy();
	});

	test("announced text that reaches the relay a minute late is still delivered, not left to the sweep", async () => {
		// Live under an 800+ document import: the sender's own upload took up
		// to ~60s, the receiver gave up after three re-checks (~40-57s) and the
		// edit waited for a sweep 650 documents long -- 18 of 80 edits never
		// arrived within 120s.
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 600_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();

		folder.announce("s-0", textFingerprint("new"));
		for (let t = 0; t <= 90_000; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			while (held.length > 0) {
				held.shift()?.resolve({ outcome: "unchanged", remoteText: t >= 60_000 ? "new" : "old" });
				await flushPromises();
			}
		}
		const { delivery } = poller.stats();
		expect(delivery.count).toBe(1);
		expect(delivery.maxMs).toBeGreaterThanOrEqual(60_000);
		expect(delivery.maxMs).toBeLessThanOrEqual(75_000);
		poller.destroy();
	});

	test("an announced change that never shows up keeps being re-checked past the window, then is given up", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();

		folder.announce("s-0", textFingerprint("new"));
		let callsAt200s = 0;
		for (let t = 0; t <= 800_000; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			while (held.length > 0) {
				held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
				await flushPromises();
			}
			if (t === 200_000) {
				callsAt200s = pull.mock.calls.length;
				expect(poller.stats().recheck.givenUp).toBe(0);
			}
		}
		const calls = pull.mock.calls.length;
		const stats = poller.stats();
		// Once a minute from the front of the sweep between 180s and 600s.
		expect(calls - callsAt200s).toBeGreaterThanOrEqual(5);
		expect(stats.recheck.swept).toBeGreaterThanOrEqual(5);
		expect(stats.recheck.givenUp).toBe(1);
		expect(stats.givenUp).toEqual([{ path: "s/0.md", outcome: "unchanged", attempts: expect.any(Number) }]);
		expect(stats.outcomes.unchanged).toBe(calls);
		clock.setTime(t0 + 900_000);
		await flushPromises();
		expect(pull.mock.calls.length).toBe(calls);
		poller.destroy();
	});

	test("repeat re-checks of an import's lagging documents back off: a few pulls each, not one every 15s", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("imp", 300, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		const settleAll = async () => {
			while (held.length > 0) {
				held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
				await flushPromises();
			}
		};
		await settleAll();

		for (let i = 0; i < 300; i++) folder.announce(`imp-${i}`, textFingerprint(`created ${i}`));
		let callsAt40s = 0;
		let callsAt175s = 0;
		for (let t = 0; t <= 175_000; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			await settleAll();
			if (t === 40_000) callsAt40s = pull.mock.calls.length;
			if (t === 175_000) callsAt175s = pull.mock.calls.length;
		}
		// Past the three quick re-checks each document is pulled at most
		// twice more (~62s, ~122s) within the window, instead of every 15s.
		expect(callsAt175s - callsAt40s).toBeLessThanOrEqual(2 * 300);
		poller.destroy();
	});

	test("late re-checks leave the sweep a slot, and a fresh edit isn't held behind them", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const imp = makeFolder("imp", 301, pull, 3);
		const other = makeFolder("other", 30, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([imp, other]) as never, 31_000, PULL_DEADLINE_MS, 0);
		poller.start();
		const settleAll = async () => {
			while (held.length > 0) {
				held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
				await flushPromises();
			}
		};
		await settleAll();

		for (let i = 0; i < 300; i++) imp.announce(`imp-${i}`, textFingerprint(`created ${i}`));
		for (let t = 0; t <= 30_000; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			await settleAll();
		}
		// 31s: the sweep refills and takes every regular slot (held).
		clock.setTime(t0 + 31_000);
		await flushPromises();
		// 32s: all 300 documents are due for their first late re-check.
		clock.setTime(t0 + 32_000);
		await flushPromises();
		for (const h of held.splice(0)) {
			h.resolve({ outcome: "unchanged", remoteText: "old" });
			await flushPromises();
		}
		const announcedImport = (guid: string) => /^imp-\d+$/.test(guid) && guid !== "imp-300";
		const running = held.map((h) => h.file.entityGuid);
		expect(running).toHaveLength(3);
		expect(running.filter(announcedImport)).toHaveLength(2);
		expect(running.filter((guid) => !announcedImport(guid))).toHaveLength(1);

		imp.announce("imp-300", textFingerprint("edited"));
		await flushPromises();
		expect(held.map((h) => h.file.entityGuid)).toContain("imp-300");
		poller.destroy();
	});

	test("a share receiving an import can't hold every slot: another share's late re-check still runs", async () => {
		// Live on 0.1.13: the receiving share announced a new document every
		// few seconds while each pull took ~20s, so its announcements always
		// filled the regular slots and the probe share's late re-checks and
		// sweep never ran -- 10 edits were still missing 25 minutes later.
		const started: { guid: string; at: number; resolve: (result: PullResult) => void }[] = [];
		const pull = jest.fn<PullFn>().mockImplementation(
			(file) =>
				new Promise<PullResult>((resolve) => {
					started.push({ guid: file.entityGuid, at: clock.now() - t0, resolve });
				}),
		);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const probe = makeFolder("probe", 1, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([bulk, probe]) as never, 3_600_000);
		poller.start();
		started.splice(0).forEach((s) => s.resolve({ outcome: "unchanged", remoteText: "old" }));
		await flushPromises();

		probe.announce("probe-0", textFingerprint("edited"));
		const settled = new Set<number>();
		for (let t = 0; t <= 120_000; t += 1_000) {
			clock.setTime(t0 + t);
			if (t % 2_000 === 0) {
				const guid = `bulk-${t / 2_000}`;
				bulk.trackedEntries.set(guid, { __isDocument: true, isOnline: false, entityGuid: guid, entryPath: `bulk/${guid}.md` });
				bulk.announce(guid, textFingerprint(guid));
			}
			await flushPromises();
			for (let i = 0; i < started.length; i++) {
				const s = started[i];
				if (settled.has(i)) continue;
				// Probe pulls answer in 1s; the edit reaches the relay at 40s.
				// Bulk pulls take 20s each.
				if (s.guid === "probe-0" && t - s.at >= 1_000) {
					settled.add(i);
					s.resolve({ outcome: "unchanged", remoteText: t >= 40_000 ? "edited" : "old" });
				} else if (s.guid !== "probe-0" && t - s.at >= 20_000) {
					settled.add(i);
					s.resolve({ outcome: "unchanged", remoteText: s.guid });
				}
				await flushPromises();
			}
		}
		const lateProbePulls = started.filter((s) => s.guid === "probe-0" && s.at >= 40_000);
		expect(lateProbePulls.length).toBeGreaterThanOrEqual(1);
		expect(lateProbePulls[0].at).toBeLessThanOrEqual(90_000);
		poller.destroy();
	});

	test("a newer announcement replaces the pending re-check instead of starting a second chain", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();

		folder.announce("s-0", textFingerprint("v1"));
		await flushPromises();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		// v1's re-check is due at 2s; v2 arrives at 1s.
		clock.setTime(t0 + 1_000);
		folder.announce("s-0", textFingerprint("v2"));
		await flushPromises();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		const calls = pull.mock.calls.length;

		clock.setTime(t0 + 2_000);
		await flushPromises();
		expect(pull.mock.calls.length).toBe(calls);

		clock.setTime(t0 + 3_000);
		await flushPromises();
		expect(pull.mock.calls.length).toBe(calls + 1);
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "v2" });
		await flushPromises();
		const { delivery } = poller.stats();
		expect(delivery.count).toBe(1);
		// Measured from v2's own announcement.
		expect(delivery.maxMs).toBe(2_000);
		poller.destroy();
	});

	test("destroy() cancels pending re-checks", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		folder.announce("s-0", textFingerprint("new"));
		await flushPromises();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		const calls = pull.mock.calls.length;
		expect(poller.stats().recheck.scheduled).toBe(1);

		poller.destroy();
		clock.setTime(t0 + 60_000);
		await flushPromises();
		expect(pull.mock.calls.length).toBe(calls);
	});

	test("an announcement for a document already being pulled is checked against that pull's result", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 1, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();

		folder.announce("s-0", textFingerprint("new"));
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		clock.setTime(t0 + 2_000);
		await flushPromises();
		expect(pull).toHaveBeenCalledTimes(2);
		poller.destroy();
	});

	test("a share's sweep is refilled only once its previous pass has been handed out", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 5, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 10_000);
		poller.start();
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" }); // s-0 done
		await flushPromises();

		clock.setTime(t0 + 10_000); // tick while s-2..s-4 are still queued
		await flushPromises();
		expect(poller.stats().queued.s.sweep).toBe(2);
		expect(startedGuids(pull)).toEqual(["s-0", "s-1", "s-2"]);
		poller.destroy();
	});

	test("an edit announced in a small share starts at once while a bulk share holds every regular slot", async () => {
		const held: Held[] = [];
		// Bulk pulls hang in connect, as measured live under an 800+ document sync.
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			control.onPhase?.("connect");
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const bulk = makeFolder("bulk", 800, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		notes.trackedEntries.set("note", {
			__isDocument: true,
			isOnline: false,
			entityGuid: "note",
			entryPath: "notes/note.md",
		});
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, notes]) as never,
			60_000,
		);
		poller.start();
		// The regular slots go round-robin; drain the small share's sweep first.
		const notesSweep = held.findIndex((h) => h.file.entityGuid === "note");
		held.splice(notesSweep, 1)[0].resolve({ outcome: "unchanged", remoteText: "old" });
		await flushPromises();
		expect(startedGuids(pull).filter((g) => g.startsWith("bulk-"))).toHaveLength(3);

		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		// Without the express slot it waits up to PULL_DEADLINE_MS for a bulk pull.
		expect(startedGuids(pull).at(-1)).toBe("note");
		expect(poller.stats().express).toBe(1);
		expect(poller.stats().inflight).toBe(4);

		clock.setTime(t0 + 4_000);
		held.find((h) => h.file.entityGuid === "note")?.resolve({ outcome: "flushed", remoteText: "edited" });
		await flushPromises();
		expect(poller.stats().delivery).toEqual({ count: 1, p50Ms: 4_000, p95Ms: 4_000, maxMs: 4_000 });
		expect(poller.stats().express).toBe(0);
		poller.destroy();
	});

	test("a bulk share's announced backlog can't take the express slot; another share's edit can", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, notes]) as never,
			60_000,
		);
		poller.start();
		for (let i = 0; i < 100; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		notes.trackedEntries.set("note", {
			__isDocument: true,
			isOnline: false,
			entityGuid: "note",
			entryPath: "notes/note.md",
		});
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "bulk-1", "bulk-2"]);
		expect(poller.stats().express).toBe(0);

		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "bulk-1", "bulk-2", "note"]);
		expect(poller.stats().express).toBe(1);
		poller.destroy();
	});

	test("a late re-check of another share takes the express slot while a bulk share holds every regular slot", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([bulk, notes]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 100; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		notes.trackedEntries.set("note", { __isDocument: true, isOnline: false, entityGuid: "note", entryPath: "notes/note.md" });
		notes.announce("note", textFingerprint("edited"));
		await flushPromises();

		// The bulk pulls never settle; the note's content lags behind its
		// announcement through the three quick re-checks and into the late lane.
		const notePulls = () => startedGuids(pull).filter((guid) => guid === "note").length;
		for (let t = 0; t <= 40_000; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			for (let i = held.length - 1; i >= 0; i--) {
				if (held[i].file.entityGuid !== "note") continue;
				const [note] = held.splice(i, 1);
				note.resolve({ outcome: "unchanged", remoteText: t < 30_000 ? "old" : "edited" });
				await flushPromises();
			}
		}
		// Quick re-checks at ~2/7/17s, then the late one ~15s later.
		expect(notePulls()).toBe(5);
		expect(poller.stats().delivery.count).toBe(1);
		poller.destroy();
	});

	test("a fresh edit takes the express slot back from a late re-check", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const other = makeFolder("other", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([bulk, notes, other]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 100; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		notes.trackedEntries.set("note", { __isDocument: true, isOnline: false, entityGuid: "note", entryPath: "notes/note.md" });
		other.trackedEntries.set("edit", { __isDocument: true, isOnline: false, entityGuid: "edit", entryPath: "other/edit.md" });
		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		const notePulls = () => startedGuids(pull).filter((guid) => guid === "note").length;
		// Settle the note's quick re-checks; its late one (the 5th pull) stays held.
		for (let t = 0; t <= 40_000 && notePulls() < 5; t += 1_000) {
			clock.setTime(t0 + t);
			await flushPromises();
			for (let i = held.length - 1; i >= 0; i--) {
				if (held[i].file.entityGuid !== "note" || notePulls() >= 5) continue;
				const [note] = held.splice(i, 1);
				note.resolve({ outcome: "unchanged", remoteText: "old" });
				await flushPromises();
			}
		}
		expect(notePulls()).toBe(5);
		const lateNote = held.find((h) => h.file.entityGuid === "note");
		expect(poller.stats().express).toBe(1);

		other.announce("edit", textFingerprint("typed"));
		await flushPromises();
		expect(startedGuids(pull)).toContain("edit");
		expect(lateNote?.control.signal?.aborted).toBe(true);
		expect(poller.stats().preempted).toBe(1);
		expect(poller.stats().inflight).toBe(4);
		poller.destroy();
	});

	test("while another share has an edit waiting, an import keeps at most one regular slot", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([bulk, notes]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 20; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		await flushPromises();
		const bulkRunning = () => held.filter((h) => h.file.entityGuid.startsWith("bulk-")).length;
		expect(bulkRunning()).toBe(3);

		notes.trackedEntries.set("note", { __isDocument: true, isOnline: false, entityGuid: "note", entryPath: "notes/note.md" });
		notes.announce("note", textFingerprint("edited"));
		await flushPromises();
		expect(startedGuids(pull)).toContain("note");

		// Bulk pulls finishing don't hand their slots to more bulk while the
		// note is in flight: they drain down to one.
		for (let i = 0; i < 3; i++) {
			const index = held.findIndex((h) => h.file.entityGuid.startsWith("bulk-"));
			held.splice(index, 1)[0].resolve({ outcome: "unchanged", remoteText: "x" });
			await flushPromises();
		}
		expect(bulkRunning()).toBe(1);
		expect(poller.stats().importing).toEqual(["bulk"]);

		// The note arrives: the import gets the lane back.
		held.splice(held.findIndex((h) => h.file.entityGuid === "note"), 1)[0].resolve({
			outcome: "unchanged",
			remoteText: "edited",
		});
		await flushPromises();
		expect(bulkRunning()).toBe(3);
		poller.destroy();
	});

	test("edits waiting connected for their text don't rank their share as importing", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 0, pull, 3);
		const notes = makeFolder("notes", 0, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([bulk, notes]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 20; i++) {
			bulk.trackedEntries.set(`bulk-${i}`, {
				__isDocument: true,
				isOnline: false,
				entityGuid: `bulk-${i}`,
				entryPath: `bulk/${i}.md`,
			});
			bulk.announce(`bulk-${i}`, textFingerprint(`created ${i}`));
		}
		await flushPromises();
		for (let i = 0; i < 7; i++) {
			const guid = `note-${i}`;
			notes.trackedEntries.set(guid, { __isDocument: true, isOnline: false, entityGuid: guid, entryPath: `notes/${i}.md` });
			notes.announce(guid, textFingerprint(`edited ${i}`));
			await flushPromises();
			held.find((h) => h.file.entityGuid === guid)?.control.onPhase?.("await-content");
			await flushPromises();
			// Bulk pulls finishing hand their slots to the queued notes.
			const index = held.findIndex((h) => h.file.entityGuid.startsWith("bulk-"));
			if (index !== -1) held.splice(index, 1)[0].resolve({ outcome: "unchanged", remoteText: "x" });
			await flushPromises();
			for (const h of held) if (h.file.entityGuid.startsWith("note-")) h.control.onPhase?.("await-content");
			await flushPromises();
		}
		expect(poller.stats().awaiting).toBeGreaterThanOrEqual(6);
		expect(poller.stats().importing).toEqual(["bulk"]);
		poller.destroy();
	});

	test("an announced pull outside an import is traced with its phases and whether its text matched", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("a", 0, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		folder.trackedEntries.set("a-0", { __isDocument: true, isOnline: false, entityGuid: "a-0", entryPath: "a/0.md" });
		folder.announce("a-0", textFingerprint("typed"));
		await flushPromises();
		const [first] = held;
		clock.setTime(t0 + 300);
		first.control.onPhase?.("await-content");
		clock.setTime(t0 + 1_200);
		first.control.onPhase?.("compare");
		first.resolve({ outcome: "flushed", remoteText: "typed" });
		await flushPromises();
		const [edit] = poller.stats().edits;
		expect(edit).toMatchObject({
			path: "a/0.md",
			awaits: true,
			phases: { "await-content": 300, compare: 1_200 },
			totalMs: 1_200,
			outcome: "flushed",
			matched: true,
		});
		poller.destroy();
	});

	test("an announced pull waits connected for the text, without holding a slot or hitting the deadline", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("a", 0, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 2; i++) {
			folder.trackedEntries.set(`a-${i}`, { __isDocument: true, isOnline: false, entityGuid: `a-${i}`, entryPath: `a/${i}.md` });
		}
		folder.announce("a-0", textFingerprint("first"));
		await flushPromises();
		const [first] = held;
		expect(first.file.entityGuid).toBe("a-0");
		expect(first.control.expected?.()).toBe(textFingerprint("first"));
		expect(first.control.awaitContentMs).toBeGreaterThan(0);

		// A newer announcement while it waits is what it waits for.
		folder.announce("a-0", textFingerprint("second"));
		expect(first.control.expected?.()).toBe(textFingerprint("second"));

		first.control.onPhase?.("await-content");
		folder.announce("a-1", textFingerprint("other"));
		await flushPromises();
		// The one slot went to a-1 while a-0 waits.
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);
		expect(poller.stats().awaiting).toBe(1);

		clock.setTime(t0 + PULL_DEADLINE_MS + 1_000);
		await flushPromises();
		expect(first.control.signal?.aborted).toBe(false);
		poller.destroy();
	});

	test("an announced pull aborted at its deadline is re-checked: the re-check starts, waits for the text and reaches compare", async () => {
		const held: Held[] = [];
		let first = true;
		const pull = jest.fn<PullFn>().mockImplementation((file, control) => {
			if (first) {
				first = false;
				// Stuck on a connect that never settles.
				control.onPhase?.("connect");
				return new Promise<PullResult>(() => undefined);
			}
			return new Promise<PullResult>((resolve) => held.push({ file, control, resolve }));
		});
		const folder = makeFolder("a", 0, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		folder.trackedEntries.set("a-0", { __isDocument: true, isOnline: false, entityGuid: "a-0", entryPath: "a/0.md" });
		folder.announce("a-0", textFingerprint("edited"));
		await flushPromises();
		const stuck = pull.mock.calls[0][1];

		clock.setTime(t0 + PULL_DEADLINE_MS);
		await flushPromises();
		expect(stuck.signal?.aborted).toBe(true);
		expect(poller.stats().timeouts).toEqual({ connect: 1 });

		// The re-check comes by itself, for the same text, with leave to wait for it.
		clock.setTime(t0 + PULL_DEADLINE_MS + 60_000);
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-0"]);
		const recheck = held[0];
		expect(recheck.control.signal?.aborted).toBe(false);
		expect(recheck.control.expected?.()).toBe(textFingerprint("edited"));
		expect(recheck.control.awaitContentMs).toBeGreaterThan(0);

		// It gets as far as compare and delivers the announced text.
		recheck.control.onPhase?.("compare");
		recheck.resolve({ outcome: "flushed", remoteText: "edited" });
		await flushPromises();
		expect(poller.stats().inflight).toBe(0);
		expect(poller.stats().outcomes).toMatchObject({ deadline: 1, flushed: 1 });
		poller.destroy();
	});

	test("once the announced text lands, the pull is back on the usual deadline and over the cap nothing new starts", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("a", 0, pull, 1);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.start();
		for (let i = 0; i < 3; i++) {
			folder.trackedEntries.set(`a-${i}`, { __isDocument: true, isOnline: false, entityGuid: `a-${i}`, entryPath: `a/${i}.md` });
		}
		folder.announce("a-0", textFingerprint("first"));
		await flushPromises();
		held[0].control.onPhase?.("await-content");
		folder.announce("a-1", textFingerprint("other"));
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);

		// a-0's text lands: it resumes on top of the one slot.
		clock.setTime(t0 + 1_000);
		held[0].control.onPhase?.("compare");
		folder.announce("a-2", textFingerprint("third"));
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);
		// a-1 finishing doesn't free a slot: a-0 still holds one.
		held[1].resolve({ outcome: "unchanged", remoteText: "other" });
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0", "a-1"]);

		clock.setTime(t0 + 1_000 + PULL_DEADLINE_MS + 1);
		await flushPromises();
		expect(held[0].control.signal?.aborted).toBe(true);
		expect(startedGuids(pull)).toEqual(["a-0", "a-1", "a-2"]);
		poller.destroy();
	});

	test("an announcement for the probed document is pulled once the probe is done", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("a", 1, pull, 3);
		let releaseProbe: () => void = () => undefined;
		const probeRelay = jest.fn(
			() =>
				new Promise<{ at: number; connectMs: number; syncMs: number; ok: boolean }>((resolve) => {
					releaseProbe = () => resolve({ at: 0, connectMs: 1, syncMs: 1, ok: true });
				}),
		);
		(folder.transfers as unknown as { probeRelay: typeof probeRelay }).probeRelay = probeRelay;
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.startRelayProbe("a/0.md", 10_000);
		poller.start();
		// The probe has connected it.
		const probed = folder.trackedEntries.get("a-0") as FakeFile;
		probed.isOnline = true;
		folder.announce("a-0", textFingerprint("edited"));
		await flushPromises();
		expect(startedGuids(pull)).toEqual([]);

		probed.isOnline = false;
		releaseProbe();
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-0"]);
		expect(held[0].control.expected?.()).toBe(textFingerprint("edited"));
		poller.destroy();
	});

	test("the relay probe times one control document every interval and keeps it out of the sweep", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("a", 2, pull, 3);
		let probes = 0;
		let releaseFirst: () => void = () => undefined;
		const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
		const probeRelay = jest.fn(async () => {
			probes++;
			const n = probes;
			if (n === 1) await firstHeld;
			return { at: clock.now(), connectMs: 100 * n, syncMs: 50, ok: n !== 2 };
		});
		(folder.transfers as unknown as { probeRelay: typeof probeRelay }).probeRelay = probeRelay;
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 3_600_000);
		poller.startRelayProbe("a/0.md", 10_000);
		// The sweep doesn't pull the document while it is being probed.
		poller.start();
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["a-1"]);
		releaseFirst();
		await flushPromises();
		for (const t of [10_000, 20_000]) {
			clock.setTime(t0 + t);
			await flushPromises();
		}
		expect(probeRelay).toHaveBeenCalledTimes(3);
		expect(probeRelay.mock.calls[0]).toEqual([folder.trackedEntries.get("a-0")]);
		const stats = poller.stats().relayProbe;
		expect(stats.samples).toHaveLength(3);
		expect(stats.failed).toBe(1);
		expect(stats.connectMs.max).toBe(300);

		poller.stopRelayProbe();
		clock.setTime(t0 + 40_000);
		await flushPromises();
		expect(probeRelay).toHaveBeenCalledTimes(3);
		poller.destroy();
	});

	test("one express pull at a time; regular slots stay at laneLimit", async () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const bulk = makeFolder("bulk", 50, pull, 2);
		const a = makeFolder("a", 1, pull, 2);
		const b = makeFolder("b", 1, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			makeRegistry([bulk, a, b]) as never,
			60_000,
		);
		poller.start();
		// Two regular slots: bulk-0 and a-0. b-0 waits for the sweep.
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0"]);

		b.announce("b-0", textFingerprint("edit b"));
		bulk.announce("bulk-40", textFingerprint("edit bulk"));
		await flushPromises();
		// b-0 takes the express slot; bulk-40 waits for a regular one.
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0", "b-0"]);
		expect(poller.stats().inflight).toBe(3);

		held.find((h) => h.file.entityGuid === "a-0")?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(startedGuids(pull)).toEqual(["bulk-0", "a-0", "b-0", "bulk-40"]);
		expect(poller.stats().inflight).toBe(3);
		poller.destroy();
	});

	test("a change announced while a share was offline is pulled as soon as it reconnects, not at the next sweep", async () => {
		const pull = jest.fn<PullFn>().mockResolvedValue({ outcome: "unchanged", remoteText: "" });
		const folder = makeFolder("s", 6, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 10_000);
		poller.start();
		for (let i = 0; i < 4; i++) await flushPromises();
		expect(pull).toHaveBeenCalledTimes(6);

		// The connection drops and a tick sees the share offline.
		folder.isOnline = false;
		clock.setTime(t0 + 10_000);
		await flushPromises();
		expect(folder.listenerCount()).toBe(1);

		// On reconnect the folder sync replays the marker a peer wrote while
		// this client was offline -- before the poller's next tick.
		folder.isOnline = true;
		folder.announce("s-4", textFingerprint("edited offline"));
		await flushPromises();
		expect(startedGuids(pull).slice(6)).toEqual(["s-4"]);
		poller.destroy();
		expect(folder.listenerCount()).toBe(0);
	});

	test("a share that leaves the registry drops its announcement listener", async () => {
		const pull = jest.fn<PullFn>().mockResolvedValue({ outcome: "unchanged", remoteText: "" });
		const folder = makeFolder("s", 1, pull, 3);
		const folders = [folder];
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry(folders) as never, 10_000);
		poller.start();
		expect(folder.listenerCount()).toBe(1);

		folders.length = 0;
		clock.setTime(t0 + 10_000);
		await flushPromises();
		expect(folder.listenerCount()).toBe(0);
		poller.destroy();
	});

	test("destroy() aborts in-flight pulls and drops announcement listeners", () => {
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 2, pull, 2);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 10_000);
		poller.start();
		expect(folder.listenerCount()).toBe(1);

		poller.destroy();
		expect(held.map((h) => h.control.signal?.aborted)).toEqual([true, true]);
		expect(folder.listenerCount()).toBe(0);
		expect(poller.stats().inflight).toBe(0);
	});

	test("sweep pulls ask for relay tokens as background, an announced pull does not", async () => {
		resetTokenRequestClasses();
		const held: Held[] = [];
		const pull = holdingPull(held);
		const folder = makeFolder("s", 100, pull, 3);
		const poller = new CrdtBackgroundSyncPoller(clock as never, makeRegistry([folder]) as never, 60_000);
		poller.start();
		expect(startedGuids(pull)).toEqual(["s-0", "s-1", "s-2"]);
		expect(["s-0", "s-1", "s-2"].map(tokenRequestClass)).toEqual(["background", "background", "background"]);

		folder.announce("s-90", textFingerprint("edited"));
		await flushPromises();
		expect(startedGuids(pull)[3]).toBe("s-90");
		expect(tokenRequestClass("s-90")).toBe("normal");

		// A finished sweep pull gives its documents' class back.
		held.shift()?.resolve({ outcome: "unchanged", remoteText: "" });
		await flushPromises();
		expect(tokenRequestClass("s-0")).toBe("normal");
		poller.destroy();
		expect(poller.stats().tokenWait.backgroundDocs).toBe(0);
	});
});
