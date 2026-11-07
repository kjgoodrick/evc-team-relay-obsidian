import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { LocationChannel } from "../../src/collaboration/presence/LocationChannel";
import type { BaseLocation, ImageLocation, LocationEvent, SurfaceLocation, SurfaceRosterEvent } from "../../src/collaboration/presence/LocationProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_SURFACE_LOCATION_FIXTURE ? test : test.skip;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Fixture = { base: string; reviewer: string; ownerToken: string; reviewerToken: string; presence: { image: ImageLocation; views: BaseLocation[] } };
async function until(check: () => boolean, label: string): Promise<void> {
	const end = Date.now() + 7000;
	while (!check()) { if (Date.now() > end) throw new Error("Timed out: " + label); await new Promise(resolve => window.setTimeout(resolve, 20)); }
}

run("actual image/Bases socket roster, Follow, hidden observation, reconnect and idle revocation", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_SURFACE_LOCATION_FIXTURE!, "utf8")) as Fixture;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const channels: LocationChannel[] = [], sockets: WebSocket[] = [];
	const { image, views } = f.presence;
	function participant(token: string, instanceId: string) {
		const claims = decodeJwt(token), events: LocationEvent[] = [], rosters: SurfaceRosterEvent[] = [], opened: WebSocket[] = [];
		let acknowledgments = 0, refreshes = 0;
		const channel = new LocationChannel({ serverUrl: f.base, accountId: claims.sub!, loginSessionId: claims.session_id as string, instanceId }, {
			surfaceLocations: true, credential: async () => ({ accountId: claims.sub!, accessToken: token }),
			location: event => events.push(event), roster: event => rosters.push(event),
			socket: url => {
				const socket = new WebSocket(url), send = socket.send.bind(socket); sockets.push(socket); opened.push(socket);
				expect(new URL(url).search).toBe("");
				socket.send = value => { send(value); if (typeof value === "string" && JSON.parse(value).type === "presence") send('{"type":"ping"}'); };
				socket.addEventListener("message", event => { const value = JSON.parse(String(event.data)) as { type: string }; if (value.type === "pong") acknowledgments++; if (value.type === "authenticated") refreshes++; });
				return socket;
			},
		});
		channels.push(channel);
		return { channel, events, rosters, opened, refreshes: () => refreshes, publish: async (location: SurfaceLocation | null) => {
			const previous = acknowledgments; channel.publish(location); await until(() => acknowledgments > previous, "processed publication");
		} };
	}
	const publisher = participant(f.ownerToken, id(401)), viewer = participant(f.reviewerToken, id(402));
	try {
		publisher.channel.start(image.share_id, image);
		viewer.channel.watch(image); viewer.channel.start(image.share_id, null);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "image roster");
		expect(publisher.channel.supportsSurfaceLocations).toBe(true); expect(viewer.channel.supportsSurfaceRoster).toBe(true);
		expect(viewer.channel.supportsImageContext).toBe(true);
		expect(await viewer.channel.readImageLocation(image.share_id, image.entry_id)).toEqual(image);
		const target = viewer.rosters.at(-1)!.peers[0].target;
		expect(viewer.rosters.at(-1)!.peers[0].name).toBe("owner");
		publisher.channel.watch(image);
		await until(() => publisher.rosters.at(-1)?.status === "available", "hidden observer exclusion");
		expect(publisher.rosters.at(-1)!.peers).toEqual([]);
		const follow = viewer.channel.follow(target, image);
		await until(() => viewer.events.at(-1)?.subscriptionId === follow && viewer.events.at(-1)?.location?.kind === "image", "image Follow");
		await publisher.publish(views[0]);
		await until(() => viewer.events.at(-1)?.location?.kind === "base", "image to Bases Follow");
		viewer.channel.watch(views[1]);
		await until(() => viewer.rosters.at(-1)?.status === "available", "other saved view roster");
		expect(viewer.rosters.at(-1)!.peers).toEqual([]);
		await publisher.publish(views[1]);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "saved view arrival");
		publisher.channel.credentialsChanged(); await until(() => publisher.refreshes() === 1, "same-socket renewal");
		await publisher.publish(null);
		await until(() => viewer.events.at(-1)?.location === null && viewer.rosters.at(-1)?.peers.length === 0, "hidden publisher");
		const eventCount = viewer.events.length;
		await publisher.publish(views[1]); await until(() => viewer.rosters.at(-1)?.peers.length === 1, "visible publisher returns");
		expect(viewer.events).toHaveLength(eventCount);
		viewer.opened[0].close();
		await until(() => viewer.opened.length === 2 && viewer.channel.ready && viewer.rosters.at(-1)?.peers.length === 1, "reconnect refreshes roster");
		expect(viewer.events).toHaveLength(eventCount);
		await publisher.publish(image); viewer.channel.watch(image);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "return to image");
		const second = viewer.channel.follow(target, image);
		await until(() => viewer.events.at(-1)?.subscriptionId === second && viewer.events.at(-1)?.location?.kind === "image", "explicit Follow restart");
		const revoked = await fetch(`${f.base}/v1/managed/shares/${image.share_id}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: f.reviewer, path: "", recursive: true, permission: "read" }, { user_id: f.reviewer, path: "Presence.png", recursive: false, permission: "none" }]) });
		expect(revoked.status).toBe(200);
		await until(() => viewer.rosters.at(-1)?.status === "unavailable" && viewer.events.at(-1)?.location === null, "idle read revocation");
		await expect(viewer.channel.readImageLocation(image.share_id, image.entry_id)).rejects.toThrow();
		expect(JSON.stringify(viewer.rosters)).not.toContain("Presence.png");
	} finally {
		channels.forEach(channel => channel.stop());
		await until(() => sockets.every(socket => socket.readyState === 3), "socket cleanup");
	}
}, 30000);
