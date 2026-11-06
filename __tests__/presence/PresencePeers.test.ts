import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { peerLocation, presencePeers, presencePosition } from "../../src/collaboration/presence/PresencePeers";

test("remote positions survive concurrent prefix edits and invalid sessions are excluded", () => {
	const doc = new Y.Doc(), peerDoc = new Y.Doc(), text = doc.getText("contents"), awareness = new Awareness(doc), peer = new Awareness(peerDoc);
	try {
		text.insert(0, "alpha beta");
		const anchor = Y.createRelativePositionFromTypeIndex(text, 6), head = Y.createRelativePositionFromTypeIndex(text, 10);
		peer.setLocalState({ user: { id: "bob", name: "Bob", avatarUrl: "file:///private/photo" }, sessionId: "a".repeat(32), surface: "reading", viewport: anchor, selection: { anchor, head } });
		applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "test");
		const [remote] = presencePeers(awareness); expect(remote.avatarUrl).toBeUndefined(); expect(remote.cursor).toBeNull();
		expect(peerLocation(remote, text, false)).toEqual({ from: 6, to: 10 }); expect(peerLocation(remote, text, true)).toEqual({ from: 6, to: 6 });
		text.insert(0, "prefix "); expect(peerLocation(remote, text, false)).toEqual({ from: 13, to: 17 });
		expect(peerLocation(remote, peerDoc.getText("contents"), false)).toBeUndefined();
		peer.setLocalState({ user: { id: "bob", name: "Bob" }, sessionId: "invalid" });
		applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "test"); expect(presencePeers(awareness)).toEqual([]);
	} finally { awareness.destroy(); peer.destroy(); doc.destroy(); peerDoc.destroy(); }
});

test.each(["a8c90563-f8dd-466c-aeaa-87493d018754", undefined, "invalid", {}, "A8C90563-F8DD-466C-AEAA-87493D018754"])("instance identity is optional and validated: %j", instanceId => {
	const doc = new Y.Doc(), peerDoc = new Y.Doc(), awareness = new Awareness(doc), peer = new Awareness(peerDoc);
	try {
		peer.setLocalState({ user: { id: "bob", name: "Bob" }, sessionId: "a".repeat(32), instanceId });
		applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), "test");
		const [remote] = presencePeers(awareness);
		expect(remote.userId).toBe("bob");
		expect(remote.instanceId).toBe(instanceId === "a8c90563-f8dd-466c-aeaa-87493d018754" ? instanceId : undefined);
	} finally { awareness.destroy(); peer.destroy(); doc.destroy(); peerDoc.destroy(); }
});

test.each([null, {}, { tname: "private" }, { tname: "contents", item: { client: -1, clock: 0 } },
	{ tname: "contents", assoc: "1" }, { tname: "contents", item: { client: 1, clock: 0, path: "private" } }])("malformed semantic position rejects: %j", value => {
	expect(presencePosition(value)).toBe(false);
});
