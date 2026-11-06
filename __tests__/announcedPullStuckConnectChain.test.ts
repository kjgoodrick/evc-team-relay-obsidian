/**
 * Run 7: announced edits to closed notes whose pulls hit a connect that never
 * settles, notes whose doc holds a seed hole the relay lacks too.
 *
 * Real chain: CrdtBackgroundSyncPoller -> TransferQueue -> Document (real
 * ProviderBacked, real LocalDocumentStore over fake-indexeddb, real sync
 * base) -> preserveBeforeTrash (noteCompletedSync / hasHistoryGap). Faked
 * only at the outer boundaries: the clock, the relay socket (YSweetProvider),
 * the token request and the vault.
 *
 * Every note's doc starts in the field shape: a peer's complete text plus a
 * writer's later presence pushes whose seed never reached anybody. The hole
 * is accepted as lost only after completed syncs on two distinct connections
 * left it open (noteCompletedSync); the peer's edit reaches the disk then.
 *
 *   0, 1: the first token request never settles (the first connect hangs)
 *   2, 3: the first socket opens and the relay sends nothing; the reconnect's
 *         token request never settles
 *   4:    the first vault read never returns, so the pull reaches its deadline
 *         (PULL_DEADLINE_MS) and is aborted
 *   1, 3: the file holds a local edit that was never uploaded
 *
 * On c17f4a27 notes 2 and 3 stay parked in await-content until the pull's
 * budget (AWAIT_CONTENT_MS + PULL_DEADLINE_MS) runs out, so their text
 * reaches the disk after ~100s, not within 70s.
 */

import "fake-indexeddb/auto";
import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import * as Y from "yjs";

// The relay socket is the network boundary: a scripted stand-in.
jest.mock("../src/client/provider", () => {
	class FakeYSweetProvider {
		maxBackoffTime = 2500;
		connectionState: { status: string } = { status: "disconnected" };
		intent = "disconnected";
		shouldConnect = false;
		synced = false;
		ws: object | null = null;
		awareness = { setLocalStateField: jest.fn(), setLocalState: jest.fn(), getLocalState: () => null };
		private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

		constructor(
			_url: string,
			_room: string,
			private readonly doc: Y.Doc,
		) {}

		on(event: string, cb: (...args: unknown[]) => void): void {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set());
			this.listeners.get(event)!.add(cb);
		}
		off(event: string, cb: (...args: unknown[]) => void): void {
			this.listeners.get(event)?.delete(cb);
		}
		once(event: string, cb: (...args: unknown[]) => void): void {
			const wrapped = (...args: unknown[]) => {
				this.off(event, wrapped);
				cb(...args);
			};
			this.on(event, wrapped);
		}
		private emit(event: string, ...args: unknown[]): void {
			for (const cb of [...(this.listeners.get(event) ?? [])]) cb(...args);
		}
		connect(): void {
			this.shouldConnect = true;
			this.intent = "connected";
			this.ws = {};
			this.connectionState = { status: "connected" };
			this.emit("status", this.connectionState);
			// The relay answers the doc's state vector, if this note's script says it does.
			const relay = mockRelays.get(this.doc);
			if (relay?.answers()) {
				setImmediate(() => {
					if (this.connectionState.status !== "connected") return;
					Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(relay.doc, Y.encodeStateVector(this.doc)));
					this.synced = true;
					this.emit("synced");
				});
			}
		}
		disconnect(): void {
			this.shouldConnect = false;
			this.intent = "disconnected";
			this.ws = null;
			this.synced = false;
			this.connectionState = { status: "disconnected" };
			this.emit("status", this.connectionState);
		}
		destroy(): void {}
		canReconnect(): boolean {
			return true;
		}
		hasUrl(): boolean {
			return true;
		}
		refreshToken(url: string): { urlChanged: boolean; newUrl: string } {
			return { urlChanged: false, newUrl: url };
		}
	}
	return { YSweetProvider: FakeYSweetProvider };
});

const mockRelays = new WeakMap<Y.Doc, { doc: Y.Doc; answers: () => boolean }>();

import { MockClock } from "./mocks/MockClock";
import { CrdtBackgroundSyncPoller } from "src/CrdtBackgroundSyncPoller";
import { TransferQueue } from "src/TransferQueue";
import { Document } from "src/Document";
import { textFingerprint, type RemoteActivityListener } from "src/docActivity";
import { hasHistoryGap } from "src/preserveBeforeTrash";
import type { DocumentGrant } from "src/relay/TokenShapes";

const flush = async (times = 10): Promise<void> => {
	for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const FULL_TEXT = "Run 7 note\nlast agreed text\n";
const LOCAL_LINE = "local line, never uploaded\n";
const GRANT = {
	token: "t",
	url: "ws://relay.example/d/doc/ws",
	docId: "doc",
	expiryTime: Date.now() + 3_600_000,
} as DocumentGrant;

type Stuck = "first-connect" | "reconnect" | "vault-read";

/** The writer's presence entry: its `ids` list is pushed to after the seed. */
function seedIdentity(doc: Y.Doc): Y.Array<number> {
	const user = new Y.Map<unknown>();
	user.set("ids", new Y.Array<number>());
	user.set("ds", new Y.Array<Uint8Array>());
	doc.getMap("users").set("ghost-account", user);
	const ids = user.get("ids") as Y.Array<number>;
	ids.push([doc.clientID]);
	return ids;
}

/** `doc` gets a peer's complete text and the ghost's later pushes (seed lost everywhere). */
function lostSeedHistory(): Y.Doc {
	const peer = new Y.Doc();
	peer.getText("contents").insert(0, FULL_TEXT);
	const ghost = new Y.Doc();
	const ids = seedIdentity(ghost);
	const held = new Y.Doc();
	Y.applyUpdate(held, Y.encodeStateAsUpdate(peer));
	for (let i = 1; i <= 3; i++) {
		const before = Y.encodeStateVector(ghost);
		ids.push([ghost.clientID + i]);
		Y.applyUpdate(held, Y.encodeStateAsUpdate(ghost, before));
	}
	return held;
}

async function makeNote(parent: Record<string, unknown>, index: number, stuck: Stuck, localEdit: boolean) {
	const guid = `00000000-0000-4000-8000-00000000000${index}`;
	const note = { tokenCalls: 0, vaultReads: 0, vault: localEdit ? FULL_TEXT + LOCAL_LINE : FULL_TEXT };
	const written: string[] = [];
	const conflictCopies: string[] = [];
	let connectsAnswered = 0;

	const credentialCache = {
		peekToken: () => undefined,
		dropFromQueue: () => {},
		getToken: (): Promise<DocumentGrant> => {
			const call = ++note.tokenCalls;
			// Stuck token requests never settle.
			if (stuck === "first-connect" && call === 1) return new Promise<DocumentGrant>(() => {});
			if (stuck === "reconnect" && call === 2) return new Promise<DocumentGrant>(() => {});
			return Promise.resolve(GRANT);
		},
	};
	const share = {
		...parent,
		credentialCache,
		readContents: async () => {
			if (stuck === "vault-read" && ++note.vaultReads === 1) return new Promise<string>(() => {});
			return note.vault;
		},
		writeContents: async (_doc: unknown, content: string) => {
			note.vault = content;
			written.push(content);
		},
		writeConflictCopy: async (_doc: unknown, content: string) => {
			conflictCopies.push(content);
			return "copy.md";
		},
	};
	const doc = new Document(
		`${index}.md`,
		guid,
		{ getCurrentUserForServer: () => undefined, on: () => () => {} } as never,
		share as never,
	);
	await doc.awaitFirstSync();
	// The doc holds the field shape; so does the relay, plus a peer's edit.
	Y.applyUpdate(doc.crdtDoc, Y.encodeStateAsUpdate(lostSeedHistory()));
	const relay = new Y.Doc();
	Y.applyUpdate(relay, Y.encodeStateAsUpdate(doc.crdtDoc));
	relay.getText("contents").insert(0, `PEER LINE ${index}\n`);
	await doc.setSyncBase(FULL_TEXT);
	expect(hasHistoryGap(doc.crdtDoc)).toBe(true);
	mockRelays.set(doc.crdtDoc, {
		doc: relay,
		// The first socket of a "reconnect" note opens on a silent relay.
		answers: () => (stuck === "reconnect" ? ++connectsAnswered > 1 : true),
	});
	return { doc, guid, note, written, conflictCopies, newText: relay.getText("contents").toString() };
}

describe("announced pulls over a connect that never settles, with an accepted seed hole", () => {
	let clock: MockClock;
	let t0: number;

	beforeEach(() => {
		jest.spyOn(console, "log").mockImplementation(() => undefined);
		jest.spyOn(console, "warn").mockImplementation(() => undefined);
		
		jest.spyOn(console, "debug").mockImplementation(() => undefined);
		clock = new MockClock();
		t0 = clock.now();
	});

	/** Moves the clock in small steps so the poller, the queue and their timers interleave. */
	async function advance(ms: number): Promise<void> {
		for (let step = 0; step < ms; step += 250) {
			clock.setTime(clock.now() + 250);
			await flush();
		}
	}

	test("connect timeout / deadline abort -> re-check -> compare -> write: every note gets the relay's text within 70s, a local edit stays as a conflict copy", async () => {
		const listeners = new Set<RemoteActivityListener>();
		const trackedEntries = new Map<string, Document>();
		const queue = new TransferQueue({} as never, clock, {} as never);
		jest.spyOn(queue, "enqueueUpload").mockResolvedValue(undefined);
		const parent = {
			workspaceId: "relay-1",
			entityGuid: "11111111-1111-4111-8111-111111111111",
			isOnline: true,
			path: "notes",
			hostAppId: "test-app",
			config: { onpremServerId: undefined },
			vaultApi: {},
			unsavedStore: {},
			wantsConnection: true,
			resourceAddress: {},
			bringOnline: async () => true,
			trackedEntries,
			transfers: queue,
			folderIndex: { tracks: () => true },
			awaitSynced: async () => {},
			subscribe: () => () => {},
			noteUploaded: async () => {},
			isDeletePending: () => false,
			toVaultFile: () => null,
			docActivity: {
				subscribeRemote: (listener: RemoteActivityListener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		};
		const notes = [
			await makeNote(parent, 0, "first-connect", false),
			await makeNote(parent, 1, "first-connect", true),
			await makeNote(parent, 2, "reconnect", false),
			await makeNote(parent, 3, "reconnect", true),
			await makeNote(parent, 4, "vault-read", false),
		];
		const poller = new CrdtBackgroundSyncPoller(
			clock as never,
			{ each: (cb: (f: typeof parent) => void) => cb(parent) } as never,
			3_600_000,
		);
		poller.start();
		for (const n of notes) trackedEntries.set(n.guid, n.doc);

		for (const n of notes) listeners.forEach((l) => l(n.guid, textFingerprint(n.newText)));
		await flush();
		await advance(70_000);

		for (const n of notes) {
			expect({ path: n.doc.entryPath, vault: n.note.vault }).toEqual({
				path: n.doc.entryPath,
				vault: n.newText,
			});
		}
		// The local edit is kept, once, in a copy; the others had nothing to keep.
		expect(notes.map((n) => n.conflictCopies)).toEqual([
			[],
			[FULL_TEXT + LOCAL_LINE],
			[],
			[FULL_TEXT + LOCAL_LINE],
			[],
		]);
		// The vault-read note reached its deadline and was aborted; the connect ones did not need it.
		expect(poller.stats().timeouts).toEqual({ "read-vault": 1 });
		expect(poller.stats().inflight).toBe(0);
		expect(clock.now() - t0).toBeGreaterThanOrEqual(70_000);
		poller.destroy();
	}, 120_000);
});
