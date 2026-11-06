import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import { AwarenessPublisher, type PresenceAvailability } from "../src/client/AwarenessPublisher";

describe("transient awareness publication", () => {
	const cleanup: (() => void)[] = [];
	beforeEach(() => jest.useFakeTimers());
	afterEach(() => { cleanup.splice(0).forEach(close => close()); jest.useRealTimers(); });
	function fixture() {
		const doc = new Y.Doc(), awareness = new Awareness(doc), frames: Uint8Array[] = [];
		const statuses: PresenceAvailability[] = [];
		let connected = true, next = doc.clientID + 1;
		const publisher = new AwarenessPublisher(awareness, () => connected,
			frame => frames.push(frame), state => statuses.push(state), () => next++);
		cleanup.push(() => { publisher.destroy(); awareness.destroy(); doc.destroy(); });
		const latest = () => {
			const outer = decoding.createDecoder(frames[frames.length - 1]);
			expect(decoding.readVarUint(outer)).toBe(1);
			const data = decoding.createDecoder(decoding.readVarUint8Array(outer));
			expect(decoding.readVarUint(data)).toBe(1);
			return { id: decoding.readVarUint(data), clock: decoding.readVarUint(data), state: JSON.parse(decoding.readVarString(data)) };
		};
		return { doc, awareness, publisher, frames, statuses, latest, setConnected: (value: boolean) => { connected = value; } };
	}

	test("coalesces a burst but delivers its final selection; hiding flushes without a stale timer", () => {
		const f = fixture(); f.publisher.connected();
		for (let i = 0; i < 100; i++) f.awareness.setLocalStateField("cursor", { head: i });
		expect(f.frames).toHaveLength(1);
		jest.advanceTimersByTime(99); expect(f.frames).toHaveLength(1);
		jest.advanceTimersByTime(1); expect(f.frames).toHaveLength(2);
		expect(f.latest().state.cursor.head).toBe(99);
		f.awareness.setLocalStateField("cursor", { head: 100 });
		f.awareness.setLocalStateField("cursor", null);
		expect(f.frames).toHaveLength(3); expect(f.latest().state.cursor).toBeNull();
		jest.advanceTimersByTime(100); expect(f.frames).toHaveLength(3);
		f.awareness.setLocalState(null);
		expect(f.latest().state).toBeNull(); expect(f.frames).toHaveLength(4);
	});

	test("never sends a tombstone before claiming an ID, even when queried", () => {
		const f = fixture(); f.awareness.setLocalState(null);
		f.publisher.connected(); f.publisher.publish(true);
		expect(f.frames).toHaveLength(0);
		f.awareness.setLocalState({ user: { id: "me" } });
		expect(f.frames).toHaveLength(1);
	});

	test("rotates only the presence ID and preserves document history and local selection", () => {
		const f = fixture(); f.doc.getText("contents").insert(0, "keep this");
		f.awareness.setLocalState({ user: { id: "me" }, cursor: { head: 3 } });
		const docId = f.doc.clientID, before = Y.encodeStateAsUpdate(f.doc), count = f.frames.length;
		// Even if a local channel is still open, rotation itself cannot publish.
		f.publisher.disconnected(4409);
		expect(f.frames).toHaveLength(count);
		expect(f.awareness.clientID).not.toBe(docId);
		expect(f.doc.clientID).toBe(docId); expect(Y.encodeStateAsUpdate(f.doc)).toEqual(before);
		expect(f.awareness.getLocalState()?.cursor.head).toBe(3);
		f.publisher.connected();
		expect(f.latest().id).toBe(f.awareness.clientID);
		f.publisher.receive(encodeAwarenessUpdate(f.awareness, [f.awareness.clientID]));
		expect(f.publisher.availability).toBe("ready");
	});

	test("initial colliding room state cannot overwrite local identity or selection", () => {
		const f = fixture(), otherDoc = new Y.Doc(), other = new Awareness(otherDoc);
		try {
			f.awareness.setLocalState({ user: { id: "me" }, cursor: { head: 3 } });
			other.clientID = f.awareness.clientID;
			for (let i = 0; i < 10; i++) other.setLocalState({ user: { id: "other" }, cursor: { head: 99 } });
			const before = f.awareness.meta.get(f.awareness.clientID)?.clock;
			f.publisher.receive(encodeAwarenessUpdate(other, [other.clientID]));
			expect(f.awareness.getLocalState()?.user.id).toBe("me");
			expect(f.awareness.getLocalState()?.cursor.head).toBe(3);
			expect(f.awareness.meta.get(f.awareness.clientID)?.clock).toBe(before);
		} finally { other.destroy(); otherDoc.destroy(); }
	});

	test("bounds collisions without disabling document sync; explicit retry is available", () => {
		const f = fixture(), docId = f.doc.clientID;
		for (let i = 0; i < 4; i++) { f.publisher.disconnected(4409); f.publisher.connected(); }
		expect(f.publisher.availability).toBe("unavailable");
		const count = f.frames.length;
		f.awareness.setLocalStateField("cursor", { head: 12 });
		jest.advanceTimersByTime(120000); f.publisher.publish(true);
		expect(f.frames).toHaveLength(count); expect(f.doc.clientID).toBe(docId);
		f.publisher.retry(); expect(f.frames).toHaveLength(count + 1);
	});

	test("capacity retry uses 30/60/120 second delays while heartbeat and queries stay silent", () => {
		const f = fixture(), id = f.awareness.clientID;
		for (const delay of [30000, 60000, 120000, 120000]) {
			f.publisher.disconnected(4429); f.publisher.connected();
			const count = f.frames.length;
			f.publisher.publish(true); f.awareness.setLocalStateField("cursor", { head: delay });
			jest.advanceTimersByTime(delay - 1); expect(f.frames).toHaveLength(count);
			jest.advanceTimersByTime(1); expect(f.frames).toHaveLength(count + 1);
			expect(f.latest().id).toBe(id); expect(f.publisher.availability).toBe("recovering");
		}
	});

	test("disconnect and destruction cancel retries and pending selection sends", () => {
		const f = fixture(); f.publisher.connected();
		f.awareness.setLocalStateField("cursor", { head: 1 });
		f.publisher.disconnected(); f.setConnected(false);
		jest.advanceTimersByTime(100); expect(f.frames).toHaveLength(1);
		f.setConnected(true); f.publisher.disconnected(4429); f.publisher.connected();
		f.publisher.destroy(); jest.advanceTimersByTime(120000);
		expect(f.frames).toHaveLength(1);
	});
});
