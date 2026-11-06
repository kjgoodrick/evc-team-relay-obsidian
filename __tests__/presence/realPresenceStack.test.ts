import { readFileSync } from "node:fs";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import { YSweetProvider } from "../../src/client/provider";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_PRESENCE_FIXTURE ? test : test.skip;
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 6000;
	while (!check()) { if (Date.now() >= end) throw new Error("Timed out: " + label); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function awareness(entries: { id: number; clock: number; state: unknown }[]): Uint8Array {
	const data = encoding.createEncoder(); encoding.writeVarUint(data, entries.length);
	for (const entry of entries) { encoding.writeVarUint(data, entry.id); encoding.writeVarUint(data, entry.clock); encoding.writeVarString(data, JSON.stringify(entry.state)); }
	const outer = encoding.createEncoder(); encoding.writeVarUint(outer, 1); encoding.writeVarUint8Array(outer, encoding.toUint8Array(data)); return encoding.toUint8Array(outer);
}

run("managed awareness authenticates readers, rejects impersonation/collisions and clears on disconnect/revocation", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_PRESENCE_FIXTURE!, "utf8"));
	for (const url of [f.base, f.relay]) expect(new URL(url).hostname).toBe("127.0.0.1");
	const docs: Y.Doc[] = [], providers: YSweetProvider[] = [], sockets: WebSocket[] = [];
	async function api(route: string, token: string, body: unknown, method = "POST") {
		return fetch(f.base + route, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	}
	async function grant(token: string, mode = "read") {
		const response = await api("/v1/tokens/relay", token, { share_id: f.share, doc_id: f.note, mode });
		expect(response.status).toBe(200); return response.json();
	}
	async function peer(token: string, mode = "read", presenceId?: number) {
		const auth = await grant(token, mode), doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(auth.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: auth.token } });
		if (presenceId !== undefined) { provider.awareness.setLocalState(null); provider.awareness.clientID = presenceId; }
		provider.awareness.setLocalState({ user: { id: "forged-admin", name: "Not the member", avatarUrl: "https://attacker.test/photo" } });
		providers.push(provider); provider.connect(); await until(() => provider.synced, "sync");
		return { doc, provider, auth, text: doc.getText("contents") };
	}
	async function rejected(data: Uint8Array | Uint8Array[], code: number) {
		const auth = await grant(f.bobToken);
		const ws = new WebSocket(auth.relay_url + "/" + f.note + "?token=" + encodeURIComponent(auth.token)); sockets.push(ws);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Rejected peer did not close")), 6000);
			ws.onopen = () => { for (const frame of Array.isArray(data) ? data : [data]) ws.send(frame as Uint8Array<ArrayBuffer>); };
			ws.onclose = event => { clearTimeout(timer); try { expect(event.code).toBe(code); resolve(); } catch (error) { reject(error); } };
		});
	}
	try {
		const owner = await peer(f.ownerToken, "write"), reader = await peer(f.bobToken);
		owner.text.insert(0, "alpha beta");
		await until(() => reader.text.toString() === "alpha beta", "reader text");
		const remote = () => owner.provider.awareness.getStates().get(reader.doc.clientID);
		await until(() => remote()?.user?.id === f.bobId, "reader identity");
		expect(remote()?.user).toEqual({ id: f.bobId, name: "bob" });
		expect(remote()?.sessionId).toMatch(/^[0-9a-f]{32}$/);
		const session = remote()?.sessionId;
		const cursor = { anchor: Y.createRelativePositionFromTypeIndex(reader.text, 6), head: Y.createRelativePositionFromTypeIndex(reader.text, 10) };
		reader.provider.awareness.setLocalStateField("cursor", cursor);
		await until(() => remote()?.cursor?.anchor?.item?.clock === 6, "read-only cursor");
		expect(Y.createAbsolutePositionFromRelativePosition(remote()!.cursor.head, owner.doc)?.index).toBe(10);
		await rejected(awareness([{ id: owner.doc.clientID, clock: 100, state: { user: { id: f.bobId } } }]), 4409);
		await rejected(awareness([{ id: owner.doc.clientID, clock: 101, state: null }]), 4400);
		await rejected(awareness([{ id: 21, clock: 1, state: {} }, { id: owner.doc.clientID, clock: 101, state: null }]), 4400);
		await rejected(awareness([{ id: 21, clock: 1, state: { padding: "x".repeat(5000) } }]), 4400);
		await rejected([awareness([{ id: 21, clock: 1, state: {} }]), awareness([{ id: owner.doc.clientID, clock: 102, state: {} }])], 4400);
		await until(() => reader.provider.awareness.getStates().get(owner.doc.clientID)?.user?.id === f.ownerId, "owner unchanged");
		expect(reader.provider.awareness.getStates().get(owner.doc.clientID)?.user).toEqual({
			id: f.ownerId, name: "Fixture Owner", avatarUrl: "https://identity.example.test/owner.png",
		});
		expect(owner.text.toString()).toBe("alpha beta");
		const collision = await peer(f.bobToken, "read", owner.provider.awareness.clientID);
		const documentId = collision.doc.clientID;
		await until(() => collision.provider.presence.availability === "ready"
			&& collision.provider.awareness.clientID !== owner.provider.awareness.clientID
			&& owner.provider.awareness.getStates().get(collision.provider.awareness.clientID)?.user?.id === f.bobId, "automatic collision recovery");
		expect(collision.doc.clientID).toBe(documentId);
		expect(collision.text.toString()).toBe("alpha beta");
		expect(collision.provider.awareness.getLocalState()?.user.id).toBe("forged-admin");
		collision.provider.disconnect();
		reader.provider.disconnect(); await until(() => !remote(), "immediate disconnect cleanup");
		const resumed = Date.now(); reader.provider.connect();
		await until(() => !!remote(), "immediate presence on reconnect");
		expect(Date.now() - resumed).toBeLessThan(3000);
		expect(remote()?.sessionId).toBe(session);
		expect(remote()?.user.id).toBe(f.bobId);
		reader.provider.awareness.setLocalState({ surface: "reading", cursor: null });
		await until(() => remote()?.surface === "reading" && remote()?.cursor === null, "Reading presence without a caret");
		reader.provider.awareness.setLocalState(null);
		await until(() => !remote(), "privacy removes the whole presence state");
		expect(reader.provider.wsconnected).toBe(true);
		reader.provider.awareness.setLocalState({ surface: "editor", cursor });
		await until(() => remote()?.surface === "editor" && remote()?.user?.id === f.bobId, "foreground activation returns authenticated presence");
		const revoked = await api(`/v1/managed/shares/${f.share}/rules`, f.ownerToken, [{ user_id: f.bobId, path: "", recursive: true, permission: "none" }], "PUT");
		expect(revoked.status).toBe(200);
		await until(() => !remote() && !reader.provider.wsconnected, "revocation removes presence");
	} finally { sockets.forEach(socket => socket.close()); providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy()); }
}, 45000);
