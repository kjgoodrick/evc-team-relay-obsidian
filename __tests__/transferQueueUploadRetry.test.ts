/**
 * Unit tests: TransferQueue re-sends uploads that didn't land
 *
 * Under relay load an upload can come back unsynced (connect failure, sync
 * timeout), and an edit can be saved while the same note's upload is already
 * running. Both used to wait for the share's next full pass, minutes later;
 * on the stand that showed up as edits arriving after two minutes or not at
 * all.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import type { Clock } from "../src/Clock";
import { TransferQueue } from "../src/TransferQueue";
import { Document } from "../src/Document";
import type { VaultShare } from "../src/VaultShare";

/** Runs timeouts only when the test advances time past them. */
class SteppedClock implements Clock {
	time = 1_000;
	private timers = new Map<number, { at: number; callback: () => void }>();
	private nextId = 1;
	now(): number {
		return this.time;
	}
	scheduleTimeout(callback: () => void, ms = 0): number {
		const id = this.nextId++;
		if (ms <= 0) {
			setImmediate(callback);
			return id;
		}
		this.timers.set(id, { at: this.time + ms, callback });
		return id;
	}
	scheduleInterval(): number {
		return 0;
	}
	cancelTimeout(id: number): void {
		this.timers.delete(id);
	}
	cancelInterval(): void {}
	teardown(): void {}
	debounced<T extends (...args: unknown[]) => void>(func: T): (...args: Parameters<T>) => void {
		return (...args: Parameters<T>) => func(...args);
	}
	pending(): number {
		return this.timers.size;
	}
	async advance(ms: number): Promise<void> {
		this.time += ms;
		for (const [id, timer] of [...this.timers]) {
			if (timer.at <= this.time) {
				this.timers.delete(id);
				timer.callback();
			}
		}
		await flushMacrotasks();
	}
}

async function flushMacrotasks(times = 10): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

function makeShare(path: string): VaultShare {
	return {
		path,
		isOnline: true,
		workspaceId: "ws",
		trackedEntries: new Map(),
		absolutePath: (vpath: string) => `${path}/${vpath}`,
	} as unknown as VaultShare;
}

function makeDoc(share: VaultShare, name: string): Document {
	const doc = Object.create(Document.prototype) as Document;
	Object.defineProperty(doc, "entryPath", { value: name });
	Object.defineProperty(doc, "entityGuid", { value: `${share.path}:${name}` });
	Object.defineProperty(doc, "vaultShare", { value: share });
	share.trackedEntries.set(doc.entityGuid, doc);
	return doc;
}

describe("TransferQueue — uploads that didn't land are sent again", () => {
	let clock: SteppedClock;
	let queue: TransferQueue;
	let started: string[];
	let finish: Map<string, (synced: boolean) => void>;

	beforeEach(() => {
		clock = new SteppedClock();
		queue = new TransferQueue({} as never, clock, {} as never, 3);
		started = [];
		finish = new Map();
		jest.spyOn(queue, "uploadDocumentViaSocket").mockImplementation((doc) => {
			started.push(doc.entityGuid);
			return new Promise<boolean>((resolve) => finish.set(doc.entityGuid, resolve));
		});
		queue.wake();
	});

	test.each(["before scheduling", "while waiting"])("restore %s stops background upload retries", async timing => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc); await flushMacrotasks();
		if (timing === "before scheduling") Object.defineProperty(doc, "restoreReviewRequired", { value: true });
		finish.get(doc.entityGuid)?.(false); await flushMacrotasks();
		if (timing === "while waiting") Object.defineProperty(doc, "restoreReviewRequired", { value: true });
		await clock.advance(120_000);
		expect(started).toHaveLength(1); expect(clock.pending()).toBe(0);
		expect(queue.laneStats().uploads.retries.pending).toBe(0);
	});

	test("an upload that came back unsynced is retried after a short delay", async () => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc, { priority: true });
		await flushMacrotasks();
		finish.get(doc.entityGuid)?.(false);
		await flushMacrotasks();
		expect(started).toHaveLength(1);

		await clock.advance(2_000);
		expect(started).toHaveLength(2);
		expect(queue.laneStats().uploads.retries).toMatchObject({ failed: 1, retried: 1, pending: 1 });

		finish.get(doc.entityGuid)?.(true);
		await flushMacrotasks();
		expect(queue.laneStats().uploads.retries.pending).toBe(0);
		await clock.advance(120_000);
		expect(started).toHaveLength(2);
	});

	test("retries back off and stop, leaving the note to the share's next pass", async () => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc);
		for (let i = 0; i < 10; i++) {
			await flushMacrotasks();
			finish.get(doc.entityGuid)?.(false);
			await flushMacrotasks();
			await clock.advance(60_000);
		}
		// The first run plus one per delay, then no more timers.
		expect(started).toHaveLength(6);
		expect(clock.pending()).toBe(0);
		expect(queue.laneStats().uploads.retries).toMatchObject({ retried: 5, gaveUp: 1, pending: 0 });
	});

	test("an edit saved while its note is uploading runs the upload once more", async () => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc);
		await flushMacrotasks();
		expect(started).toHaveLength(1);

		void queue.enqueueUpload(doc, { priority: true });
		void queue.enqueueUpload(doc, { priority: true });
		await flushMacrotasks();
		expect(started).toHaveLength(1);

		finish.get(doc.entityGuid)?.(true);
		await flushMacrotasks();
		expect(started).toHaveLength(2);
		expect(queue.laneStats().uploads.reruns).toBe(1);

		finish.get(doc.entityGuid)?.(true);
		await flushMacrotasks();
		expect(started).toHaveLength(2);
	});

	test("asking again for a note that is only queued doesn't run it twice", async () => {
		const share = makeShare("A");
		const docs = [0, 1, 2, 3, 4].map((i) => makeDoc(share, `n${i}.md`));
		for (const doc of docs) void queue.enqueueUpload(doc);
		await flushMacrotasks();
		void queue.enqueueUpload(docs[4]);
		for (let round = 0; round < 4; round++) {
			for (const [guid, done] of [...finish]) {
				finish.delete(guid);
				done(true);
			}
			await flushMacrotasks();
		}
		expect(started.filter((guid) => guid === docs[4].entityGuid)).toHaveLength(1);
	});

	test("a note deleted before its retry is due isn't uploaded again", async () => {
		const share = makeShare("A");
		const doc = makeDoc(share, "note.md");
		void queue.enqueueUpload(doc);
		await flushMacrotasks();
		finish.get(doc.entityGuid)?.(false);
		await flushMacrotasks();
		share.trackedEntries.delete(doc.entityGuid);
		await clock.advance(2_000);
		expect(started).toHaveLength(1);
		expect(queue.laneStats().uploads.retries).toMatchObject({ retried: 0, pending: 0 });
	});

	test("an upload that throws doesn't leave a retry behind", async () => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc);
		await flushMacrotasks();
		finish.get(doc.entityGuid)?.(false);
		await flushMacrotasks();
		jest.spyOn(queue, "uploadDocumentViaSocket").mockRejectedValueOnce(new Error("boom"));
		jest.spyOn(console, "error").mockImplementation(() => {});
		await clock.advance(2_000);
		expect(queue.laneStats().uploads.retries.pending).toBe(0);
	});

	test("shutdown() cancels pending retries", async () => {
		const doc = makeDoc(makeShare("A"), "note.md");
		void queue.enqueueUpload(doc).catch(() => {});
		await flushMacrotasks();
		finish.get(doc.entityGuid)?.(false);
		await flushMacrotasks();
		expect(clock.pending()).toBe(1);
		queue.shutdown();
		expect(clock.pending()).toBe(0);
	});
});
