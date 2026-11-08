import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { TFile } from "obsidian";
import { BaseContentTransport } from "../../src/bases/BaseContentTransport";
import { BaseRegistryTransport } from "../../src/bases/BaseRegistryTransport";
import type { NativeBaseGroupHandle, NativeBasesSurface } from "../../src/bases/NativeBasesSurface";
import { BasePresenceGroups } from "../../src/collaboration/presence/BasePresenceGroups";
import { BasePresenceRecords } from "../../src/collaboration/presence/BasePresenceRecords";
import { basePresenceLocation } from "../../src/collaboration/presence/BasePresenceProtocol";
import { LocationChannel } from "../../src/collaboration/presence/LocationChannel";
import type { BasePresenceState, BaseStatesEvent } from "../../src/collaboration/presence/BasePositionProtocol";
import type { SurfaceRosterEvent } from "../../src/collaboration/presence/LocationProtocol";

jest.mock("../../src/platformFetch", () => ({ platformFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const fixturePath = process.env.EVC_BASE_FORMULA_PRESENCE_FIXTURE;
const integration = fixturePath ? test : test.skip;
async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 12_000;
	while (!check()) { if (Date.now() >= deadline) throw new Error("Timed out: " + label); await new Promise(resolve => setTimeout(resolve, 20)); }
}

integration("actual formula group presence negotiates plans, matches local inputs and withdraws on linked-record revocation", async () => {
	const f = JSON.parse(readFileSync(fixturePath!, "utf8")) as Record<string, string>;
	expect(new URL(f.base).hostname).toBe("127.0.0.1");
	const identity = { serverId: f.base, accountId: f.ownerId, shareId: f.share }, credential = async () => ({ accountId: f.ownerId, accessToken: f.ownerToken });
	const content = new BaseContentTransport(identity, credential, fetch), registry = new BaseRegistryTransport(identity, credential, fetch);
	const claimed = await content.read(f.baseEntry);
	await content.publish(f.baseEntry, { operationId: crypto.randomUUID(), expected: claimed.state, bytes: new TextEncoder().encode(JSON.stringify({
		formulas: { bucket: 'if(status == "Ready", "Bucket", linked)' }, views: [{ name: "Table", type: "table", groupBy: { property: "formula.bucket" } }],
	})).buffer as ArrayBuffer });
	const saved = await content.read(f.baseEntry); await registry.inspect(f.baseEntry, saved.state.record.hash!, saved.state.generation!);
	const channels: LocationChannel[] = [], cleanups: (() => void)[] = [];
	function peer(token: string) {
		const claims = decodeJwt(token), states: BaseStatesEvent[] = [], rosters: SurfaceRosterEvent[] = [];
		const channel = new LocationChannel({ serverUrl: f.base, accountId: claims.sub!, loginSessionId: claims.session_id as string, instanceId: crypto.randomUUID() }, {
			credential: async () => ({ accountId: claims.sub!, accessToken: token }), surfaceLocations: true, location: () => {},
			baseStates: event => states.push(event), roster: event => rosters.push(event), socket: url => new WebSocket(url),
		}); channels.push(channel); channel.start(f.share, null); return { channel, states, rosters };
	}
	try {
		const owner = peer(f.ownerToken), viewer = peer(f.bobToken);
		await until(() => owner.channel.ready && viewer.channel.ready, "presence ready");
		expect(owner.channel.supportsBaseTargetsV3 && viewer.channel.supportsBaseTargetsV3).toBe(true);
		const context = await owner.channel.readBaseContext(f.share, f.baseEntry);
		expect(context.formula_groups).toHaveLength(1);
		expect(await viewer.channel.readBaseContext(f.share, f.baseEntry)).toEqual(context);
		const location = basePresenceLocation(context, context.views[0].id)!;
		const member = Object.assign(Object.create(TFile.prototype), { path: "Team/Note.md" }), linked = Object.assign(Object.create(TFile.prototype), { path: "Team/chart.png" });
		const local = (file: TFile) => file === member ? { id: f.note, type: "markdown" as const, path: "Note.md" } : file === linked ? { id: f.image, type: "image" as const, path: "chart.png" } : undefined;
		function groups(channel: LocationChannel) {
			const records = new BasePresenceRecords({ current: () => channel.ready, local, read: id => channel.readBaseRecordContext(f.share, id), changed: () => {} });
			const groups = new BasePresenceGroups({ current: () => channel.ready, supported: () => channel.supportsBaseTargetsV2,
				formulaSupported: () => channel.supportsBaseTargetsV3, formulaInputs: () => context.formula_groups, location: () => location,
				local, file: id => id === f.note ? member : id === f.image ? linked : undefined, fileAtPath: path => path === member.path ? member : path === linked.path ? linked : null,
				resolve: () => null, records, changed: () => {},
			}); cleanups.push(() => { groups.close(); records.close(); }); return groups;
		}
		const handle: NativeBaseGroupHandle = { target: { type: "group", property: { source: "formula", name: "bucket" }, value: { type: "text", value: "Bucket" } },
			element: {} as HTMLElement, ambiguous: false, current: () => true, members: () => [member] };
		const surface = { current: () => true, groupHandles: () => [handle], groupInputValues: () => [{ type: "file", file: linked }, { type: "text", value: "Ready" }] } as unknown as NativeBasesSurface;
		const sender = groups(owner.channel), receiver = groups(viewer.channel);
		let target = sender.capture(sender.frame(surface), handle);
		await until(() => !!(target = sender.capture(sender.frame(surface), handle)), "formula input metadata");
		expect(target!.references).toHaveLength(1); expect(target!.references[0].record_id).toBe(f.image);
		owner.channel.publish(location); viewer.channel.watch(location);
		const state: BasePresenceState = { version: 3, pointer: { target: target!, offset: { x: 0.5, y: 0.5 } }, viewport: null };
		owner.channel.publishBaseState(state);
		await until(() => viewer.states.at(-1)?.peers.some(peer => peer.state.pointer?.target.type === "group") === true, "formula pointer delivery");
		const received = viewer.states.at(-1)!.peers[0].state.pointer!.target;
		if (received.type !== "group") throw new Error("Expected formula group");
		expect((await receiver.wait(surface, received, () => true))?.current()).toBe(true);
		const revoked = await fetch(`${f.base}/v1/managed/shares/${f.share}/rules`, { method: "PUT", headers: { Authorization: "Bearer " + f.ownerToken, "Content-Type": "application/json" },
			body: JSON.stringify([{ user_id: f.bobId, path: "", recursive: true, permission: "read" }, { user_id: f.bobId, path: "Budget.md", recursive: false, permission: "none" }, { user_id: f.bobId, path: "chart.png", recursive: false, permission: "none" }]) });
		expect(revoked.status).toBe(200);
		await until(() => viewer.states.at(-1)?.peers.length === 0, "idle linked-input revocation");
		expect(viewer.rosters.at(-1)?.peers).toHaveLength(1);
		expect(await content.read(f.baseEntry)).toEqual(saved);
	} finally { cleanups.forEach(close => close()); channels.forEach(channel => channel.stop()); }
}, 40_000);
