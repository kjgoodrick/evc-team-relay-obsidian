import * as Y from "yjs";
import type { EmbeddedImage, EmbeddedImagesEvent } from "../../src/collaboration/presence/EmbeddedImageProtocol";
import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { LocationChannel, type ObservationEvent } from "../../src/collaboration/presence/LocationChannel";
import { basePresenceLocation } from "../../src/collaboration/presence/BasePresenceProtocol";
import type { BasePresenceState, BaseStatesEvent } from "../../src/collaboration/presence/BasePositionProtocol";
import type { NoteLocation, BaseLocation, ImageLocation, LocationEvent, SurfaceLocation, SurfaceRosterEvent, ImageStatesEvent } from "../../src/collaboration/presence/LocationProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const run = process.env.EVC_SURFACE_LOCATION_FIXTURE ? test : test.skip;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Fixture = { base: string; reviewer: string; ownerToken: string; reviewerToken: string; presence: { note: NoteLocation; image: ImageLocation; views: BaseLocation[] } };
async function until(check: () => boolean, label: string): Promise<void> {
	const end = Date.now() + 7000;
	while (!check()) { if (Date.now() > end) throw new Error("Timed out: " + label); await new Promise(resolve => window.setTimeout(resolve, 20)); }
}

run("actual image/Bases socket roster, Follow, hidden observation, reconnect and idle revocation", async () => {
	const f = JSON.parse(readFileSync(process.env.EVC_SURFACE_LOCATION_FIXTURE!, "utf8")) as Fixture;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const channels: LocationChannel[] = [], sockets: WebSocket[] = [];
	const { image, views, note } = f.presence;
	function participant(token: string, instanceId: string) {
		const claims = decodeJwt(token), events: LocationEvent[] = [], rosters: SurfaceRosterEvent[] = [], positions: ImageStatesEvent[] = [], opened: WebSocket[] = [];
		const embeds: EmbeddedImagesEvent[] = [], basePositions: BaseStatesEvent[] = [];
		const observations: ObservationEvent[] = [];
		let acknowledgments = 0, refreshes = 0;
		const channel = new LocationChannel({ serverUrl: f.base, accountId: claims.sub!, loginSessionId: claims.session_id as string, instanceId }, {
			surfaceLocations: true, credential: async () => ({ accountId: claims.sub!, accessToken: token }),
			location: event => events.push(event), roster: event => rosters.push(event),
			imageStates: event => positions.push(event), imageEmbeds: event => embeds.push(event),
			baseStates: event => basePositions.push(event), observation: event => observations.push(event),
			socket: url => {
				const socket = new WebSocket(url), send = socket.send.bind(socket); sockets.push(socket); opened.push(socket);
				expect(new URL(url).search).toBe("");
				socket.send = value => { send(value); if (typeof value === "string" && JSON.parse(value).type === "presence") send('{"type":"ping"}'); };
				socket.addEventListener("message", event => { const value = JSON.parse(String(event.data)) as { type: string }; if (value.type === "pong") acknowledgments++; if (value.type === "authenticated") refreshes++; });
				return socket;
			},
		});
		channels.push(channel);
		return { channel, events, rosters, positions, embeds, basePositions, observations, opened, refreshes: () => refreshes, publish: async (location: SurfaceLocation | null) => {
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
		expect(viewer.channel.supportsBaseContext).toBe(true);
		const baseContext = await viewer.channel.readBaseContext(views[0].share_id, views[0].entry_id);
		expect(baseContext.views.map(view => basePresenceLocation(baseContext, view.id))).toEqual(views);
		expect(baseContext.views.map(view => view.slot)).toEqual([0, 1]);
		expect(JSON.stringify(baseContext)).not.toMatch(/filters|configuration|Presence.base/);
		expect(viewer.channel.supportsImageStates).toBe(true);
		const state = { pointer: { x: 0.25, y: 0.75 }, viewport: { x: 0, y: 0.5, width: 1, height: 0.5 } }, rosterCount = viewer.rosters.length;
		publisher.channel.publishImageState(state);
		await until(() => viewer.positions.at(-1)?.peers.length === 1, "image position");
		expect(viewer.positions.at(-1)!.peers[0].state).toEqual(state); expect(viewer.rosters).toHaveLength(rosterCount);
		const target = viewer.rosters.at(-1)!.peers[0].target;
		expect(viewer.rosters.at(-1)!.peers[0].name).toBe("owner");
		publisher.channel.watch(image);
		await until(() => publisher.rosters.at(-1)?.status === "available", "hidden observer exclusion");
		expect(publisher.rosters.at(-1)!.peers).toEqual([]);
		const follow = viewer.channel.follow(target, image);
		await until(() => viewer.events.at(-1)?.subscriptionId === follow && viewer.events.at(-1)?.location?.kind === "image", "image Follow");
		await publisher.publish(views[0]);
		await until(() => viewer.events.at(-1)?.location?.kind === "base", "image to Bases Follow");
		await until(() => viewer.positions.at(-1)?.peers.length === 0, "old image position withdrawn");
		viewer.channel.watch(views[1]);
		await until(() => viewer.rosters.at(-1)?.status === "available", "other saved view roster");
		expect(viewer.rosters.at(-1)!.peers).toEqual([]);
		await publisher.publish(views[1]);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "saved view arrival");
		expect(viewer.channel.supportsBaseStates).toBe(true);
		const record = await viewer.channel.readBaseRecordContext(note.share_id, note.entry_id);
		expect(record).toEqual({ protocol_version: 1, share_id: note.share_id, entry_id: note.entry_id, generation: expect.any(String), type: "markdown" });
		const baseState: BasePresenceState = { version: 1, pointer: { target: { type: "cell", record_id: record.entry_id, record_generation: record.generation, property: { source: "note", name: "status" } }, offset: { x: 0.25, y: 0.5 } }, viewport: null };
		const baseRosterCount = viewer.rosters.length;
		publisher.channel.publishBaseState(baseState);
		await until(() => viewer.basePositions.at(-1)?.peers.length === 1, "record cell position");
		expect(viewer.basePositions.at(-1)!.peers).toEqual([{ target, state: baseState }]);
		expect(viewer.rosters).toHaveLength(baseRosterCount);
		expect(viewer.channel.supportsBaseTargetsV2).toBe(true);
		const group = { type: "group" as const, record_id: record.entry_id, record_generation: record.generation,
			property: { source: "note" as const, name: "status" }, value_sha256: "a".repeat(64), references: [] };
		const groupState: BasePresenceState = { version: 2, pointer: { target: group, offset: { x: 0.25, y: 0.5 } }, viewport: baseState.pointer };
		publisher.channel.publishBaseState(groupState);
		await until(() => viewer.basePositions.at(-1)?.peers[0]?.state.pointer?.target.type === "group", "group position");
		expect(viewer.basePositions.at(-1)!.peers[0].state).toEqual(groupState);
		const rangeState: BasePresenceState = { version: 2, pointer: { target: { type: "timeline_range",
			axis: { version: 1, renderer: "sabidurian-timeline", start_property: { source: "note", name: "start" }, end_property: null, time_zone: "America/Denver" },
			range: { version: 1, kind: "calendar", start: "2026-11-01", end: "2026-11-07", start_inclusive: true, end_inclusive: true, time_zone: "America/Denver" }, lane: group }, offset: { x: 0.4, y: 0.5 } }, viewport: baseState.pointer };
		publisher.channel.publishBaseState(rangeState);
		await until(() => viewer.basePositions.at(-1)?.peers[0]?.state.pointer?.target.type === "timeline_range", "lane range position");
		expect(viewer.basePositions.at(-1)!.peers[0].state).toEqual(rangeState);
		expect(viewer.rosters).toHaveLength(baseRosterCount);
		publisher.channel.publishBaseState(null);
		await until(() => viewer.basePositions.at(-1)?.peers.length === 0, "record position explicitly cleared");
		publisher.channel.publishBaseState(baseState);
		await until(() => viewer.basePositions.at(-1)?.peers.length === 1, "record position restored");
		publisher.channel.credentialsChanged(); await until(() => publisher.refreshes() === 1, "same-socket renewal");
		await publisher.publish(null);
		await until(() => viewer.events.at(-1)?.location === null && viewer.rosters.at(-1)?.peers.length === 0, "hidden publisher");
		await until(() => viewer.basePositions.at(-1)?.peers.length === 0, "hidden record position");
		const eventCount = viewer.events.length;
		await publisher.publish(views[1]); await until(() => viewer.rosters.at(-1)?.peers.length === 1, "visible publisher returns");
		expect(viewer.events).toHaveLength(eventCount);
		viewer.opened[0].close();
		await until(() => viewer.opened.length === 2 && viewer.channel.ready && viewer.rosters.at(-1)?.peers.length === 1, "reconnect refreshes roster");
		expect(viewer.events).toHaveLength(eventCount);
		await publisher.publish(image); viewer.channel.watch(image);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "return to image");
		publisher.channel.publishImageState(state); await until(() => viewer.positions.at(-1)?.peers.length === 1, "new image position");
		// The relative positions are real Yjs values; this fixture verifies the
        // transport contract, while native source/render binding has separate tests.
        const doc = new Y.Doc(), text = doc.getText("contents"); text.insert(0, "![image](Presence.png)");
        const embed: EmbeddedImage = { version: 1, occurrence: { anchor: Y.createRelativePositionFromTypeIndex(text, 0), head: Y.createRelativePositionFromTypeIndex(text, text.length, -1) },
            source_sha256: "c".repeat(64), asset: { kind: "managed", entry_id: image.entry_id, generation: image.generation, sha256: image.content_sha256 },
            basis: { width: 640, height: 480, orientation: "display" }, state };
        await publisher.publish(note); viewer.channel.watchEmbeds({ ...note, surface: "reading" });
        await until(() => viewer.embeds.at(-1)?.status === "available", "note image observer");
        expect(viewer.channel.supportsEmbeddedImages).toBe(true);
        publisher.channel.publishEmbeddedImage(embed);
        await until(() => viewer.embeds.at(-1)?.peers.length === 1, "note embedded image");
        expect(viewer.embeds.at(-1)!.peers).toEqual([{ target, embed: JSON.parse(JSON.stringify(embed)) }]);
        publisher.channel.publishEmbeddedImage(null);
        await until(() => viewer.embeds.at(-1)?.peers.length === 0, "embedded pointer cleared");
        await publisher.publish(image); viewer.channel.watch(image);
        await until(() => viewer.rosters.at(-1)?.peers.length === 1, "image after note embed");
        publisher.channel.publishImageState(state);
        await until(() => viewer.positions.at(-1)?.peers.length === 1, "image pointer after embed");
        // Additional note/image scopes remain independent of the foreground
        // Base and reuse exactly the same authenticated socket.
        expect(viewer.channel.supportsMultiWatch).toBe(true);
        viewer.channel.watch(views[0]); viewer.channel.observe([image, note]);
        await until(() => viewer.observations.some(event => event.type === "image_states" && event.peers.length === 1), "passive image pointer");
        await until(() => viewer.observations.some(event => event.type === "image_embeds" && event.status === "available"), "passive note subscription");
        await until(() => viewer.rosters.at(-1)?.scope?.kind === "base" && viewer.rosters.at(-1)?.status === "available", "independent foreground Base");
        expect(viewer.rosters.at(-1)?.peers).toEqual([]);
        await publisher.publish(note); publisher.channel.publishEmbeddedImage(embed);
        await until(() => viewer.observations.some(event => event.type === "image_embeds" && event.peers.length === 1), "passive exact image embed");
        expect(viewer.opened).toHaveLength(2); // Only the earlier deliberate reconnect.
        await publisher.publish(image); publisher.channel.publishImageState(state);
        viewer.channel.observe([]); viewer.channel.watch(image);
        await until(() => viewer.rosters.at(-1)?.scope?.kind === "image" && viewer.rosters.at(-1)?.peers.length === 1, "foreground image after observer cleanup");
        const second = viewer.channel.follow(target, image);
		await until(() => viewer.events.at(-1)?.subscriptionId === second && viewer.events.at(-1)?.location?.kind === "image", "explicit Follow restart");
		const revoked = await fetch(`${f.base}/v1/managed/shares/${image.share_id}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: f.reviewer, path: "", recursive: true, permission: "read" }, { user_id: f.reviewer, path: "Presence.png", recursive: false, permission: "none" }]) });
		expect(revoked.status).toBe(200);
		await until(() => viewer.rosters.at(-1)?.status === "unavailable" && viewer.events.at(-1)?.location === null, "idle read revocation");
		await until(() => viewer.positions.at(-1)?.status === "unavailable" && viewer.positions.at(-1)?.peers.length === 0, "position revocation");
		await expect(viewer.channel.readImageLocation(image.share_id, image.entry_id)).rejects.toThrow();
		expect(JSON.stringify(viewer.rosters)).not.toContain("Presence.png");
        await publisher.publish(note); viewer.channel.watchEmbeds(note);
        await until(() => viewer.embeds.at(-1)?.status === "available", "note remains readable after image revocation");
        publisher.channel.publishEmbeddedImage(embed);
        // An external embed in the same note remains observable. The denied
        // managed image's entry/hash/geometry must never appear in between.
        const count = viewer.embeds.length;
        const external: EmbeddedImage = { ...embed, asset: { kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown" } };
        publisher.channel.publishEmbeddedImage(external);
        await until(() => viewer.embeds.at(-1)?.peers[0]?.embed.asset.kind === "external", "external embed on readable note");
        expect(viewer.embeds.slice(count).flatMap(event => event.peers).every(peer => peer.embed.asset.kind === "external")).toBe(true);
        publisher.channel.publishEmbeddedImage(embed);
        await until(() => viewer.embeds.at(-1)?.status === "available" && viewer.embeds.at(-1)?.peers.length === 0, "managed embed denied without ending note observation");
        expect(JSON.stringify(viewer.embeds)).not.toContain("Presence.png");
        doc.destroy();
		await publisher.publish(views[1]); viewer.channel.watch(views[1]);
		await until(() => viewer.rosters.at(-1)?.peers.length === 1, "Base before record revocation");
		publisher.channel.publishBaseState(baseState);
		await until(() => viewer.basePositions.at(-1)?.peers.length === 1, "Base cell before revocation");
		const deniedRecord = await fetch(`${f.base}/v1/managed/shares/${image.share_id}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: f.reviewer, path: "", recursive: true, permission: "read" }, { user_id: f.reviewer, path: "Presence.png", recursive: false, permission: "none" }, { user_id: f.reviewer, path: "Presence.md", recursive: false, permission: "none" }]) });
		expect(deniedRecord.status).toBe(200);
		await until(() => viewer.basePositions.at(-1)?.status === "available" && viewer.basePositions.at(-1)?.peers.length === 0, "idle record revocation retains Base observation");
		expect(viewer.rosters.at(-1)?.peers).toHaveLength(1);
		await expect(viewer.channel.readBaseRecordContext(note.share_id, note.entry_id)).rejects.toThrow();
		expect(JSON.stringify(viewer.basePositions)).not.toContain("Presence.md");
	} finally {
		channels.forEach(channel => channel.stop());
		await until(() => sockets.every(socket => socket.readyState === 3), "socket cleanup");
	}
}, 30000);
