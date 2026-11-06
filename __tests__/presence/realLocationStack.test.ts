import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import * as Y from "yjs";
import { LocationChannel } from "../../src/collaboration/presence/LocationChannel";
import type { LocationEvent, NoteLocation } from "../../src/collaboration/presence/LocationProtocol";
import { presencePeers } from "../../src/collaboration/presence/PresencePeers";
import { YSweetProvider } from "../../src/client/provider";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_LOCATION_FIXTURE ? test : test.skip;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function until(check: () => boolean, label: string) {
	const end = Date.now() + 7000;
	while (!check()) { if (Date.now() > end) throw new Error("Timed out: " + label); await new Promise(resolve => setTimeout(resolve, 20)); }
}

run("location channels join authenticated awareness identity, follow authorized destinations, hide private notes and revalidate access", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_LOCATION_FIXTURE!, "utf8"));
	for (const url of [f.base, f.relay]) expect(new URL(url).hostname).toBe("127.0.0.1");
	const providers: YSweetProvider[] = [], docs: Y.Doc[] = [], channels: LocationChannel[] = [];
	const location = (entry = f.note): NoteLocation => ({ kind: "note", share_id: f.share, entry_id: entry, surface: "editor" });
	async function peer(token: string, instanceId: string, mode: "read" | "write") {
		const grantResponse = await fetch(f.base + "/v1/tokens/relay", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
			body: JSON.stringify({ share_id: f.share, doc_id: f.note, mode }) });
		expect(grantResponse.status).toBe(200); const grant = await grantResponse.json();
		const doc = new Y.Doc(); docs.push(doc);
		const provider = new YSweetProvider(grant.relay_url, f.note, doc, { connect: false, disableBc: true, params: { token: grant.token } });
		provider.awareness.setLocalState({ instanceId, surface: "editor", user: { id: "forged", name: "Forged" } });
		providers.push(provider); provider.connect(); await until(() => provider.synced, "note synchronization");
		return provider;
	}
	function channel(token: string, instanceId: string) {
		const claims = decodeJwt(token), events: LocationEvent[] = [];
		let acknowledgments = 0, refreshes = 0;
		const channel = new LocationChannel({ serverUrl: f.base, accountId: claims.sub!, loginSessionId: claims.session_id as string, instanceId }, {
			credential: async () => ({ accountId: claims.sub!, accessToken: token }), location: event => events.push(event),
			socket: url => {
				expect(new URL(url).search).toBe("");
				const socket = new WebSocket(url), send = socket.send.bind(socket);
				// A ping after publication is a deterministic server processing
				// barrier; it does not replace or bypass the client's transport.
				socket.send = value => { send(value); if (typeof value === "string" && JSON.parse(value).type === "presence") send('{"type":"ping"}'); };
				socket.addEventListener("message", event => {
					const value = JSON.parse(String(event.data)); if (value.type === "pong") acknowledgments++;
					if (value.type === "authenticated") refreshes++;
				});
				return socket;
			},
		});
		channels.push(channel); return { channel, events, acks: () => acknowledgments, refreshes: () => refreshes };
	}
	try {
		await peer(f.ownerToken, id(1), "write"); const reader = await peer(f.bobToken, id(2), "read");
		await until(() => presencePeers(reader.awareness).some(peer => peer.userId === f.ownerId), "authenticated peer");
		const known = presencePeers(reader.awareness).find(peer => peer.userId === f.ownerId)!;
		expect(known.instanceId).toBe(id(1)); expect(known.name).not.toBe("Forged");
		const target = { user_id: known.userId, session_id: known.sessionId, instance_id: known.instanceId! };
		const publisher = channel(f.ownerToken, id(1)), follower = channel(f.bobToken, id(2));
		publisher.channel.start(f.share, location()); follower.channel.start(f.share, null);
		await until(() => publisher.channel.ready && follower.channel.ready && publisher.acks() > 0 && follower.acks() > 0, "location publication");
		const first = follower.channel.follow(target, location()); expect(first).toBeDefined();
		await until(() => follower.events.some(event => event.subscriptionId === first && event.location?.entry_id === f.note), "initial shared context");
		publisher.channel.publish(location(f.second));
		await until(() => follower.events.at(-1)?.location?.entry_id === f.second, "authorized second note");
		publisher.channel.credentialsChanged(); await until(() => publisher.refreshes() === 1, "same-session refresh");
		publisher.channel.publish(location(f.secret));
		await until(() => follower.events.at(-1)?.location === null, "private destination hidden");
		expect(JSON.stringify(follower.events)).not.toContain(f.secret); expect(JSON.stringify(follower.events)).not.toContain("Budget");
		const count = follower.events.length, ack = publisher.acks(); publisher.channel.publish(location());
		await until(() => publisher.acks() > ack, "return to shared note");
		expect(follower.events).toHaveLength(count);
		const second = follower.channel.follow(target, location());
		await until(() => follower.events.at(-1)?.subscriptionId === second && follower.events.at(-1)?.location?.entry_id === f.note, "explicit follow restart");
		const revoked = await fetch(`${f.base}/v1/managed/shares/${f.share}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: f.bobId, path: "", recursive: true, permission: "none" }]) });
		expect(revoked.status).toBe(200);
		await until(() => follower.events.at(-1)?.subscriptionId === second && follower.events.at(-1)?.location === null, "idle permission revocation");
	} finally { channels.forEach(channel => channel.stop()); providers.forEach(provider => provider.destroy()); docs.forEach(doc => doc.destroy()); }
}, 30000);
