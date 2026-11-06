/**
 * Unit tests: YSweetProvider's initial-awareness resend-on-warm-up
 *
 * The bug: on WebSocket open, the provider broadcast its awareness state once
 * immediately, then scheduled exactly ONE retry 2000ms later — a fixed,
 * one-shot guess at how long the relay's room warm-up takes. If that single
 * retry ALSO landed inside the warm-up window, presence never appeared until
 * some unrelated awareness change happened to resend it.
 *
 * Fixed by retrying repeatedly, bounded by `provider.synced` (the closest
 * real signal this protocol has that the room is up — it flips true once the
 * doc's own sync-step2 response arrives) rather than a single fixed delay.
 *
 * `client/provider.ts` has no Document/AuthSession/pocketbase imports, so —
 * unlike most of this repo — it's directly testable: only the WebSocket
 * itself (the true external/network boundary) is faked via the provider's
 * own `WebSocketPolyfill` injection point; everything else (retry scheduling,
 * the synced getter/setter, encoding) is the real code under test.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import { resetConnectGate } from "../src/client/connectGate";
import {
	YSweetProvider,
	messageSync,
	messageAwareness,
	messageQueryAwareness,
	MAX_AWARENESS_RESEND_ATTEMPTS,
} from "../src/client/provider";

type Listener = (event: unknown) => void;

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = FakeWebSocket.CONNECTING;
	binaryType = "";
	sent: Uint8Array[] = [];

	onopen: Listener | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: Listener | null = null;
	onclose: Listener | null = null;

	constructor(public url: string) {}

	send(data: Uint8Array) {
		this.sent.push(data);
	}

	close() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({});
	}

	/** Test helper: simulate the socket finishing its handshake. */
	triggerOpen() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.(undefined);
	}

	/** Test helper: count how many sent messages are a given message type. */
	countMessagesOfType(messageType: number): number {
		return this.sent.filter((buf) => {
			const decoder = decoding.createDecoder(buf);
			return decoding.readVarUint(decoder) === messageType;
		}).length;
	}
}

/** Build a real, valid sync-step2 message responding to whatever step1 the
 * provider already sent — the same message shape a real relay would send
 * back once the room has finished warming up. */
function buildSyncStep2Response(doc: Y.Doc): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageSync);
	syncProtocol.writeSyncStep2(encoder, doc);
	return encoding.toUint8Array(encoder) as Uint8Array;
}

describe("YSweetProvider initial awareness resend on room warm-up", () => {
	const active: { provider: YSweetProvider; doc: Y.Doc }[] = [];
	beforeEach(() => {
		jest.useFakeTimers();
		resetConnectGate();
	});

	afterEach(() => {
		for (const { provider, doc } of active.splice(0)) { provider.destroy(); doc.destroy(); }
		jest.useRealTimers();
	});

	function makeProvider() {
		const doc = new Y.Doc();
		const awareness = new awarenessProtocol.Awareness(doc);
		awareness.setLocalState({ user: { name: "test" } });

		const provider = new YSweetProvider("wss://example.test", "room", doc, {
			connect: true,
			awareness,
			disableBc: true,
			WebSocketPolyfill: FakeWebSocket as any,
		});

		const ws = provider.ws as unknown as FakeWebSocket;
		active.push({ provider, doc });
		return { provider, doc, ws };
	}

	test("retries the awareness broadcast more than once when the room stays un-synced", () => {
		const { ws } = makeProvider();
		ws.triggerOpen();

		expect(ws.countMessagesOfType(messageAwareness)).toBe(1);

		// Advance through every scheduled retry without ever syncing.
		jest.advanceTimersByTime(10_000);

		// 1 immediate broadcast + MAX_AWARENESS_RESEND_ATTEMPTS retries.
		expect(ws.countMessagesOfType(messageAwareness)).toBe(
			1 + MAX_AWARENESS_RESEND_ATTEMPTS,
		);
	});

	test("is bounded — stops scheduling once the attempt cap is exhausted, doesn't retry forever", () => {
		const { ws } = makeProvider();
		ws.triggerOpen();

		jest.advanceTimersByTime(10_000);
		const countAfterExhaustion = ws.countMessagesOfType(messageAwareness);

		// Nothing left scheduled; advancing further changes nothing.
		jest.advanceTimersByTime(60_000);
		expect(ws.countMessagesOfType(messageAwareness)).toBe(countAfterExhaustion);
	});

	test("stops retrying once the relay's real sync-step2 response confirms the room is up", () => {
		const { provider, doc, ws } = makeProvider();
		ws.triggerOpen();
		expect(ws.countMessagesOfType(messageAwareness)).toBe(1);

		// Feed a REAL sync-step2 response through the actual onmessage handler
		// — the same code path a genuine relay response takes — simulating
		// the room finishing warm-up right after the first resend fires.
		jest.advanceTimersByTime(1);
		ws.onmessage?.({ data: buildSyncStep2Response(doc).buffer });
		expect(provider.synced).toBe(true);

		// Let every remaining scheduled retry timer fire.
		jest.advanceTimersByTime(10_000);

		// 1 immediate broadcast + exactly 1 resend (the one that observed
		// synced==true and stopped scheduling further attempts) — NOT the
		// full MAX_AWARENESS_RESEND_ATTEMPTS, proving it stops early on the
		// real signal instead of blindly exhausting the attempt cap.
		expect(ws.countMessagesOfType(messageAwareness)).toBe(2);
		expect(ws.countMessagesOfType(messageAwareness)).toBeLessThan(
			1 + MAX_AWARENESS_RESEND_ATTEMPTS,
		);
	});

	test("stops retrying if the socket disconnects mid-sequence — no send on a dead socket", () => {
		const { ws } = makeProvider();
		ws.triggerOpen();
		expect(ws.countMessagesOfType(messageAwareness)).toBe(1);

		ws.close();

		jest.advanceTimersByTime(10_000);

		// close() flips provider.ws to null / wsconnected to false; the guard
		// at the top of each scheduled retry must see that and no-op rather
		// than send on (or reference) a socket that's gone.
		expect(ws.countMessagesOfType(messageAwareness)).toBe(1);
	});

	test("only publishes its owned awareness ID, including queries and remote timeout cleanup", () => {
		const { provider, doc, ws } = makeProvider(), peerDoc = new Y.Doc();
		const peer = new awarenessProtocol.Awareness(peerDoc);
		try {
			ws.triggerOpen();
			peer.setLocalState({ user: { id: "peer", name: "Peer" } });
			awarenessProtocol.applyAwarenessUpdate(provider.awareness, awarenessProtocol.encodeAwarenessUpdate(peer, [peerDoc.clientID]), provider);
			const before = ws.sent.length;
			const query = encoding.createEncoder(); encoding.writeVarUint(query, messageQueryAwareness);
			ws.onmessage?.({ data: encoding.toUint8Array(query).buffer });
			const outer = decoding.createDecoder(ws.sent[ws.sent.length - 1]);
			expect(decoding.readVarUint(outer)).toBe(messageAwareness);
			const payload = decoding.createDecoder(decoding.readVarUint8Array(outer));
			expect(decoding.readVarUint(payload)).toBe(1);
			expect(decoding.readVarUint(payload)).toBe(doc.clientID);
			expect(ws.sent).toHaveLength(before + 1);
			awarenessProtocol.removeAwarenessStates(provider.awareness, [peerDoc.clientID], "timeout");
			expect(ws.sent).toHaveLength(before + 1);
			provider.awareness.setLocalState(null);
			expect(ws.sent).toHaveLength(before + 2);
		} finally { provider.destroy(); peer.destroy(); peerDoc.destroy(); doc.destroy(); }
	});
});
