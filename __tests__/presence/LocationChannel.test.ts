import { LocationChannel, type LocationIdentity } from "../../src/collaboration/presence/LocationChannel";
import type { NoteLocation, ImageLocation, BaseLocation } from "../../src/collaboration/presence/LocationProtocol";
import type { BasePresenceState } from "../../src/collaboration/presence/BasePositionProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity: LocationIdentity = { serverUrl: "https://relay.example", accountId: id(1), loginSessionId: id(2), instanceId: id(3) };
const note = (n = 4): NoteLocation => ({ kind: "note", share_id: id(5), entry_id: id(n), surface: "editor" });
const picture = (n = 8): ImageLocation => ({ kind: "image", share_id: id(5), entry_id: id(n), generation: id(9), content_sha256: "a".repeat(64) });
const base = (n = 12): BaseLocation => ({ kind: "base", share_id: id(5), entry_id: id(10), generation: id(9), definition_id: id(11), view_id: id(n), registry_revision: 1 });
const baseContext = () => ({ protocol_version: 1, share_id: id(5), entry_id: id(10), generation: id(9), definition_id: id(11), registry_revision: 1, content_sha256: "a".repeat(64),
	views: [{ id: id(12), slot: 0, name: "Work", type: "table" }] });
const target = { user_id: id(6), session_id: "a".repeat(32), instance_id: id(7) };
const jwt = (patch = {}) => Buffer.from('{"alg":"HS256"}').toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: id(1), session_id: id(2), exp: Math.floor(Date.now() / 1000) + 3600, ...patch })).toString("base64url") + ".synthetic";
const credentials = () => Promise.resolve({ accountId: id(1), accessToken: jwt() });
const response = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers });

class Socket {
	readyState = 0;
	bufferedAmount = 0;
	onopen: WebSocket["onopen"] = null;
	onclose: WebSocket["onclose"] = null;
	onerror: WebSocket["onerror"] = null;
	onmessage: WebSocket["onmessage"] = null;
	frames: Record<string, unknown>[] = [];
	constructor(readonly url: string) {}
	send(value: string) { this.frames.push(JSON.parse(value)); }
	close() { this.readyState = 3; }
	open() { this.readyState = 1; this.onopen?.call(this as unknown as WebSocket, new Event("open")); }
	message(value: unknown) { this.onmessage?.call(this as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent); }
	ready(expiresIn = 3600, protocolVersion = 1) { this.message({ type: "ready", protocol_version: protocolVersion, session_id: "b".repeat(32), instance_id: id(3), expires_at: Math.floor(Date.now() / 1000) + expiresIn }); }
	disconnect(code = 1006) { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent); }
}
function fixture(surfaceLocations = false, serverSupports = surfaceLocations, movement = false, embeds = false, bases = serverSupports, baseMovement = false, baseTargets = false, multiWatch = false) {
	const sockets: Socket[] = [], status = jest.fn(), location = jest.fn(), followStopped = jest.fn(), roster = jest.fn();
	const imageStates = jest.fn(), imageEmbeds = jest.fn(), baseStates = jest.fn(), observation = jest.fn();
	let counter = 0;
	const fetcher = jest.fn(async (url: string) => url.includes("/capabilities?") ? response({ protocol_version: 1, features: { presence_locations_preview: true,
		...(serverSupports ? { presence_surface_locations_preview: true, presence_surface_roster_preview: true, presence_image_context_preview: true, presence_image_states_preview: movement, presence_embedded_images_preview: embeds, presence_base_context_preview: bases, presence_base_states_preview: baseMovement, presence_base_targets_v2_preview: baseTargets, presence_multi_watch_preview: multiWatch } : {}) } }) :
		response({ protocol_version: 1, ticket: "ticket_" + String(++counter).padStart(32, "0"), expires_in: 30, socket_path: "/v1/collaboration/events" }));
	const options = { credential: jest.fn(credentials), fetcher, status, location, followStopped, roster, surfaceLocations, random: () => 0.5,
		imageStates: movement ? imageStates : undefined, imageEmbeds: embeds ? imageEmbeds : undefined,
		baseStates: baseMovement ? baseStates : undefined, observation,
		socket: (url: string) => { const socket = new Socket(url); sockets.push(socket); return socket as unknown as WebSocket; } };
	const channel = new LocationChannel(identity, options);
	return { channel, options, sockets, fetcher, status, location, followStopped, roster, serverSupports, imageStates, imageEmbeds, baseStates, observation };
}
const flush = () => jest.advanceTimersByTimeAsync(0);
async function ready(f: ReturnType<typeof fixture>, expiresIn = 3600) {
	f.channel.start(id(5), note()); await flush();
	const socket = f.sockets.at(-1)!; expect(socket).toBeDefined(); socket.open(); socket.ready(expiresIn, f.options.surfaceLocations && f.serverSupports ? 2 : 1); return socket;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("rapid pane transitions withdraw immediately and subscribe only to the settled scopes", async () => {
	const f = fixture(true, true, true, true, true, true, true, true);
	try {
		const socket = await ready(f);
		f.channel.watchEmbeds(note()); f.channel.observe([note(20)]);
		await jest.advanceTimersByTimeAsync(120);
		const previous = socket.frames.filter(frame => ["watch_embeds", "observe"].includes(String(frame.type)));
		const before = socket.frames.length, resets = f.observation.mock.calls.length;
		for (let i = 0; i < 100; i++) {
			f.channel.watchEmbeds(null); f.channel.observe([]);
			f.channel.watchEmbeds(note(i + 30)); f.channel.observe([note(i + 200)]);
		}
		expect(socket.frames.slice(before).map(frame => frame.type)).toEqual(["unwatch", "unobserve"]);
		expect(f.imageEmbeds).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
		expect(f.observation.mock.calls.length).toBeGreaterThan(resets);
		const calls = f.imageEmbeds.mock.calls.length;
		socket.message({ type: "image_embeds", subscription_id: previous[0].subscription_id, status: "available", peers: [] });
		expect(f.imageEmbeds).toHaveBeenCalledTimes(calls);
		await jest.advanceTimersByTimeAsync(120);
		expect(socket.frames.slice(before + 2)).toMatchObject([
			{ type: "watch_embeds", location: note(129) },
			{ type: "observe", location: { ...note(299), surface: "reading" } },
		]);
		f.channel.watchEmbeds(note(300)); f.channel.observe([note(301)]);
		const stoppedAt = socket.frames.length; f.channel.stop();
		await jest.advanceTimersByTimeAsync(120);
		expect(socket.frames).toHaveLength(stoppedAt);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("image movement coalesces, follows the visible publication and is not replayed after reconnect", async () => {
	const f = fixture(true, true, true);
	try {
		const socket = await ready(f); f.channel.publish(picture());
		for (let x = 0; x <= 1000; x++) f.channel.publishImageState({ pointer: { x: x / 1000, y: 0.5 }, viewport: null });
		expect(socket.frames.filter(value => value.type === "image_state")).toHaveLength(0);
		await jest.advanceTimersByTimeAsync(125);
		expect(socket.frames.slice(-2)).toEqual([{ type: "presence", location: picture() }, { type: "image_state", location: picture(), state: { pointer: { x: 1, y: 0.5 }, viewport: null } }]);
		f.channel.publishImageState(null); expect(socket.frames.at(-1)).toMatchObject({ type: "image_state", state: null });
		f.channel.publishImageState({ pointer: { x: 0, y: 0 }, viewport: null }); f.channel.publish(null);
		await jest.advanceTimersByTimeAsync(125); expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
		f.channel.publish(picture()); f.channel.publishImageState({ pointer: { x: 0, y: 0 }, viewport: null }); await jest.advanceTimersByTimeAsync(125);
		socket.disconnect(); await jest.advanceTimersByTimeAsync(1000); const next = f.sockets.at(-1)!; next.open(); next.ready(3600, 2);
		expect(next.frames.some(frame => frame.type === "image_state")).toBe(false);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("image snapshots are separate from rosters, clear on scope change, and ignore stale subscriptions", async () => {
	const f = fixture(true, true, true), state = { pointer: { x: 0.1, y: 0.5 }, viewport: null };
	try {
		const socket = await ready(f); f.channel.watch(picture()); await jest.advanceTimersByTimeAsync(120); const watch = socket.frames.at(-1)!;
		expect(watch).toMatchObject({ type: "watch", image_states: true });
		const frame = { type: "image_states", subscription_id: watch.subscription_id, status: "available", peers: [{ target, state }] };
		const rosterCalls = f.roster.mock.calls.length; socket.message(frame);
		expect(f.imageStates).toHaveBeenLastCalledWith({ scope: picture(), status: "available", peers: [{ target, state }] });
		expect(f.roster.mock.calls).toHaveLength(rosterCalls);
		f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.at(-1)).not.toHaveProperty("image_states");
		expect(f.imageStates).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
		const count = f.imageStates.mock.calls.length; socket.message(frame); expect(f.imageStates.mock.calls).toHaveLength(count);
	} finally { f.channel.stop(); }
});

test.each([false, true])("unnegotiated image movement is withheld on legacy capability %s", async extended => {
	const f = fixture(true, extended);
	try { const socket = await ready(f); f.channel.publish(picture()); f.channel.publishImageState({ pointer: { x: 0, y: 0 }, viewport: null }); await jest.advanceTimersByTimeAsync(125); expect(socket.frames.some(frame => frame.type === "image_state")).toBe(false); }
	finally { f.channel.stop(); }
});

test("image context uses the session credential and returns only the requested current image", async () => {
	const f = fixture(true);
	try {
		await ready(f); f.fetcher.mockResolvedValueOnce(response({ protocol_version: 1, location: picture() }));
		expect(f.channel.supportsImageContext).toBe(true);
		expect(await f.channel.readImageLocation(id(5), id(8))).toEqual(picture());
		expect(f.fetcher).toHaveBeenLastCalledWith("https://relay.example/v1/collaboration/image-location?share_id=" + id(5) + "&entry_id=" + id(8), expect.objectContaining({ sensitive: true, headers: { Authorization: expect.stringMatching(/^Bearer /) } }));
	} finally { f.channel.stop(); }
});

test("Bases context uses normal credentials and accepts bounded Unicode contexts above the small control-frame budget", async () => {
	const f = fixture(true), value = { ...baseContext(), views: Array.from({ length: 64 }, (_, slot) => ({ id: id(100 + slot), slot, name: "😀".repeat(254) + String(slot).padStart(2, "0"), type: "😀".repeat(256) })) };
	try {
		await ready(f); expect(f.channel.supportsBaseContext).toBe(true);
		f.fetcher.mockResolvedValueOnce(response(value));
		expect(await f.channel.readBaseContext(id(5), id(10))).toEqual(value);
		expect(f.fetcher).toHaveBeenLastCalledWith("https://relay.example/v1/collaboration/base-context?share_id=" + id(5) + "&entry_id=" + id(10), expect.objectContaining({ sensitive: true, method: "GET", headers: { Authorization: expect.stringMatching(/^Bearer /) } }));
	} finally { f.channel.stop(); }
});

test.each([false, true])("Bases lookup requires its own negotiated capability (extended server %s)", async extended => {
	const f = fixture(true, extended, false, false, false);
	try { await ready(f); await expect(f.channel.readBaseContext(id(5), id(10))).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2); }
	finally { f.channel.stop(); }
});

test.each(["identity", "oversized", "protocol", "extra"])("Bases lookup rejects %s responses", async change => {
	const f = fixture(true), value = { ...baseContext(), ...(change === "identity" ? { entry_id: id(99) } : change === "protocol" ? { protocol_version: 2 } : change === "extra" ? { configuration: {} } : {}) };
	try {
		await ready(f); f.fetcher.mockResolvedValueOnce(change === "oversized" ? new Response(" ".repeat(192 * 1024 + 1)) : response(value));
		await expect(f.channel.readBaseContext(id(5), id(10))).rejects.toThrow();
	} finally { f.channel.stop(); }
});

test.each(["disconnect", "stop"])("Bases lookup discards late responses after %s", async action => {
	const f = fixture(true);
	try {
		const socket = await ready(f); let finish!: (value: Response) => void;
		f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const result = f.channel.readBaseContext(id(5), id(10)), rejected = expect(result).rejects.toThrow();
		await flush(); if (action === "stop") f.channel.stop(); else socket.disconnect();
		finish(response(baseContext())); await rejected; expect(f.channel.supportsBaseContext).toBe(false);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test.each([
	{ protocol_version: 1, location: picture(9) },
	{ protocol_version: 1, location: { ...picture(), share_id: id(99) } },
	{ protocol_version: 1, location: note() },
	{ protocol_version: 2, location: picture() },
	{ protocol_version: 1, location: picture(), path: "private" },
	{ protocol_version: 1, location: { ...picture(), content_sha256: "bad" } },
])("image context rejects wrong identity, protocol or extra fields: %j", async value => {
	const f = fixture(true);
	try { await ready(f); f.fetcher.mockResolvedValueOnce(response(value)); await expect(f.channel.readImageLocation(id(5), id(8))).rejects.toThrow(); }
	finally { f.channel.stop(); }
});

test("image context is unavailable on a legacy server without making another request", async () => {
	const f = fixture(true, false);
	try { await ready(f); await expect(f.channel.readImageLocation(id(5), id(8))).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2); }
	finally { f.channel.stop(); }
});

test.each(["disconnect", "stop"])("image context ignores an HTTP response after %s", async action => {
	const f = fixture(true);
	try {
		const socket = await ready(f); let finish!: (value: Response) => void;
		f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
		const result = f.channel.readImageLocation(id(5), id(8)); const rejected = expect(result).rejects.toThrow();
		await flush(); if (action === "stop") f.channel.stop(); else socket.disconnect();
		finish(response({ protocol_version: 1, location: picture() })); await rejected;
	} finally { f.channel.stop(); }
});

test("uses sensitive HTTP, a fixed socket URL, and first-frame ticket authentication; coalesces publication", async () => {
	const f = fixture();
	try {
		const socket = await ready(f);
		expect(f.fetcher.mock.calls).toHaveLength(2);
		expect((f.fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({ sensitive: true, headers: { Authorization: expect.stringMatching(/^Bearer /) } });
		expect(socket.url).toBe("wss://relay.example/v1/collaboration/events");
		expect(socket.frames[0]).toEqual({ type: "authenticate", ticket: "ticket_" + "1".padStart(32, "0"), instance_id: id(3) });
		expect(socket.frames[1]).toEqual({ type: "presence", location: note() });
		for (let i = 8; i < 100; i++) f.channel.publish(note(i));
		expect(socket.frames).toHaveLength(2);
		await jest.advanceTimersByTimeAsync(120);
		expect(socket.frames.at(-1)).toEqual({ type: "presence", location: note(99) });
		f.channel.publish(null); expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
		expect(f.channel.status).toBe("ready");
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test.each([false, undefined])("unsupported server (%s) does not open sockets or poll", async enabled => {
	const f = fixture(); f.fetcher.mockImplementation(async () => response({ protocol_version: 1, features: { presence_locations_preview: enabled } }));
	f.channel.start(id(5), note()); await flush();
	expect(f.channel.status).toBe("unsupported"); expect(f.sockets).toHaveLength(0);
	await jest.advanceTimersByTimeAsync(120_000); expect(f.fetcher).toHaveBeenCalledTimes(1); f.channel.stop();
});

test.each([{ sub: id(9) }, { session_id: id(9) }, { exp: 1 }, { scope: "managed" }])("rejects credentials outside immutable account/session (%j) before HTTP", async patch => {
	const f = fixture(); f.options.credential.mockResolvedValue({ accountId: id(1), accessToken: jwt(patch) });
	f.channel.start(id(5), note()); await flush();
	expect(f.channel.status).toBe("authentication"); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.sockets).toHaveLength(0); f.channel.stop();
});

test("stop during token refresh cancels timers and fences a late credential", async () => {
	const f = fixture(); let resolve!: (value: { accountId: string; accessToken: string }) => void;
	f.options.credential.mockImplementation(() => new Promise(ready => { resolve = ready; }));
	f.channel.start(id(5), note()); await flush(); f.channel.stop();
	expect(jest.getTimerCount()).toBe(0);
	resolve(await credentials()); await flush(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.sockets).toHaveLength(0);
});

test("stop during native HTTP cannot open a socket after its late response", async () => {
	const f = fixture(); let resolve!: (response: Response) => void;
	f.fetcher.mockImplementation(() => new Promise(ready => { resolve = ready; }));
	f.channel.start(id(5), note()); await flush(); f.channel.stop();
	resolve(response({ protocol_version: 1, features: { presence_locations_preview: true } })); await flush();
	expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.sockets).toHaveLength(0); expect(jest.getTimerCount()).toBe(0);
});

test("refreshes a ticket on the same socket without replaying a follow or note", async () => {
	const f = fixture();
	try {
		const socket = await ready(f, 70), subscription = f.channel.follow(target, note());
		await jest.advanceTimersByTimeAsync(10_000);
		expect(socket.frames.filter(frame => frame.type === "authenticate")).toHaveLength(2);
		expect(socket.frames.filter(frame => frame.type === "follow")).toHaveLength(1);
		socket.message({ type: "authenticated", expires_at: Math.floor(Date.now() / 1000) + 3600 });
		socket.message({ type: "location", subscription_id: subscription, status: "available", location: note(8) });
		expect(f.location).toHaveBeenLastCalledWith({ subscriptionId: subscription, location: note(8) });
		expect(f.sockets).toHaveLength(1); expect(f.channel.status).toBe("ready");
	} finally { f.channel.stop(); }
});

test("newer follows ignore old destination responses and explicit stop discards all late navigation", async () => {
	const f = fixture();
	try {
		const socket = await ready(f), first = f.channel.follow(target, note()), second = f.channel.follow(target, note());
		expect(second).not.toBe(first);
		socket.message({ type: "location", subscription_id: first, status: "available", location: note(8) });
		expect(f.location).not.toHaveBeenCalled();
		socket.message({ type: "location", subscription_id: second, status: "unavailable" });
		expect(f.location).toHaveBeenCalledWith({ subscriptionId: second, location: null });
		f.location.mockClear(); const third = f.channel.follow(target, note()); f.channel.unfollow();
		socket.message({ type: "location", subscription_id: third, status: "available", location: note(8) });
		expect(f.location).not.toHaveBeenCalled();
	} finally { f.channel.stop(); }
});

test("disconnect stops following and reconnects publication without silently resubscribing", async () => {
	const f = fixture();
	try {
		const first = await ready(f), subscription = f.channel.follow(target, note()), late = first.onmessage;
		first.disconnect(); expect(f.followStopped).toHaveBeenCalledTimes(1); expect(f.channel.status).toBe("reconnecting");
		await jest.advanceTimersByTimeAsync(999); expect(f.sockets).toHaveLength(1);
		await jest.advanceTimersByTimeAsync(1); expect(f.sockets).toHaveLength(2);
		const second = f.sockets[1]; second.open(); second.ready();
		expect(second.frames.map(frame => frame.type)).toEqual(["authenticate", "presence"]);
		late?.call(first as unknown as WebSocket, { data: JSON.stringify({ type: "location", subscription_id: subscription, status: "available", location: note(8) }) } as MessageEvent);
		expect(f.location).not.toHaveBeenCalled();
	} finally { f.channel.stop(); }
});

test("server retry-after is respected while foreground updates continue", async () => {
	const f = fixture(); f.fetcher.mockImplementationOnce(async () => response({}, 429, { "Retry-After": "60" }));
	f.channel.start(id(5), note()); await flush(); expect(f.channel.status).toBe("reconnecting");
	for (let i = 8; i < 100; i++) f.channel.start(id(5), note(i));
	await jest.advanceTimersByTimeAsync(59_999); expect(f.fetcher).toHaveBeenCalledTimes(1);
	await jest.advanceTimersByTimeAsync(1); expect(f.sockets).toHaveLength(1);
	f.sockets[0].open(); f.sockets[0].ready(); expect(f.sockets[0].frames.at(-1)).toEqual({ type: "presence", location: note(99) }); f.channel.stop();
});

test.each(["buffer", "heartbeat", "handshake"])("bounded %s failure closes and retries without unbounded queues", async kind => {
	const f = fixture();
	try {
		f.channel.start(id(5), note()); await flush(); const socket = f.sockets[0]; socket.open();
		if (kind === "handshake") await jest.advanceTimersByTimeAsync(10_000);
		else {
			socket.ready();
			if (kind === "buffer") { socket.bufferedAmount = 8193; f.channel.publish(null); }
			else await jest.advanceTimersByTimeAsync(30_000);
		}
		expect(socket.readyState).toBe(3); expect(f.channel.status).toBe("reconnecting");
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test.each([
	{ type: "location", status: "unavailable", subscription_id: id(8), location: note(8) },
	{ type: "location", status: "available", subscription_id: id(8), location: { ...note(8), path: "private" } },
	{ type: "ready", instance_id: id(9) }, { type: "pong", extra: true }, { type: "pong", oversized: "x".repeat(4096) },
])("invalid server frames cannot navigate: %j", async message => {
	const f = fixture(); const socket = await ready(f); socket.message(message);
	expect(f.channel.status).toBe("unavailable"); expect(f.location).not.toHaveBeenCalled(); f.channel.stop();
});

test("account/session replacement during renewal stops follow before submitting another account's ticket", async () => {
	const f = fixture(), socket = await ready(f); f.channel.follow(target, note());
	f.options.credential.mockResolvedValue({ accountId: id(9), accessToken: jwt({ sub: id(9), session_id: id(9) }) });
	f.channel.credentialsChanged(); await flush();
	expect(f.channel.status).toBe("authentication"); expect(f.fetcher).toHaveBeenCalledTimes(2);
	expect(f.followStopped).toHaveBeenCalledTimes(1); expect(socket.readyState).toBe(3); f.channel.stop();
});

test("opt-in version two carries exact image and saved-view locations and preserves credential renewal", async () => {
	const f = fixture(true), socket = await ready(f);
	try {
		expect(socket.frames[0]).toMatchObject({ type: "authenticate", protocol_version: 2 });
		expect(f.channel.supportsSurfaceLocations).toBe(true); expect(f.channel.supportsSurfaceRoster).toBe(true);
		for (const scope of [picture(), base()]) {
			f.channel.publish(scope); await jest.advanceTimersByTimeAsync(120);
			expect(socket.frames.at(-1)).toEqual({ type: "presence", location: scope });
			const subscription = f.channel.follow(target, scope);
			expect(socket.frames.at(-1)).toEqual({ type: "follow", subscription_id: subscription, target, from: scope });
			socket.message({ type: "location", subscription_id: subscription, status: "available", location: scope });
			expect(f.location).toHaveBeenLastCalledWith({ subscriptionId: subscription, location: scope });
		}
		f.channel.credentialsChanged(); await flush();
		expect(socket.frames.at(-1)).toMatchObject({ type: "authenticate" });
		socket.message({ type: "authenticated", expires_at: Math.floor(Date.now() / 1000) + 3600 });
		expect(f.channel.supportsSurfaceLocations).toBe(true);
	} finally { f.channel.stop(); }
});

test("older servers retain note navigation while non-note publication and observation remain withdrawn", async () => {
	const f = fixture(true, false), socket = await ready(f);
	try {
		expect(socket.frames[0]).not.toHaveProperty("protocol_version");
		expect(f.channel.supportsSurfaceLocations).toBe(false);
		f.channel.publish(picture()); f.channel.watch(picture()); await jest.advanceTimersByTimeAsync(120);
		expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
		expect(socket.frames.some(frame => frame.type === "watch")).toBe(false);
		expect(f.channel.follow(target, picture())).toBeUndefined();
		f.channel.publish(note()); await jest.advanceTimersByTimeAsync(120);
		expect(socket.frames.at(-1)).toEqual({ type: "presence", location: note() });
		expect(f.channel.follow(target, note())).toBeDefined();
	} finally { f.channel.stop(); }
});

test("hidden observation accepts a bounded large roster and clears immediately on scope change or unwatch", async () => {
	const f = fixture(true), scope = picture();
	f.channel.watch(scope); await jest.advanceTimersByTimeAsync(120); f.channel.start(id(5), null); await flush();
	const socket = f.sockets[0]; socket.open(); socket.ready(3600, 2);
	try {
		expect(socket.frames.filter(frame => frame.type === "presence")).toEqual([{ type: "presence", location: null }]);
		const request = socket.frames.at(-1)!;
		expect(request).toMatchObject({ type: "watch", location: scope });
		const peers = Array.from({ length: 127 }, (_, i) => ({ target: { ...target, instance_id: id(i + 100) }, name: "😀".repeat(255) }));
		socket.message({ type: "roster", subscription_id: request.subscription_id, status: "available", peers });
		expect(f.roster).toHaveBeenLastCalledWith({ scope, status: "available", peers });
		expect(f.channel.ready).toBe(true);
		f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120);
		expect(f.roster).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
		expect(socket.frames.slice(-2)).toEqual([{ type: "unwatch", subscription_id: request.subscription_id }, { type: "watch", subscription_id: expect.any(String), location: base() }]);
		const calls = f.roster.mock.calls.length;
		socket.message({ type: "roster", subscription_id: request.subscription_id, status: "available", peers });
		expect(f.roster).toHaveBeenCalledTimes(calls);
		f.channel.watch(null); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.at(-1)?.type).toBe("unwatch");
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("reconnect clears peers, renews the observed room and never replays Follow", async () => {
	const f = fixture(true), first = await ready(f);
	try {
		f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120); const request = first.frames.at(-1)!;
		f.channel.follow(target, note());
		first.message({ type: "roster", subscription_id: request.subscription_id, status: "available", peers: [{ target, name: "Member" }] });
		first.disconnect();
		expect(f.roster).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
		expect(f.followStopped).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(1000);
		const second = f.sockets[1]; second.open(); second.ready(3600, 2);
		expect(second.frames.map(frame => frame.type)).toEqual(["authenticate", "presence", "watch"]);
		expect(second.frames.at(-1)?.subscription_id).not.toBe(request.subscription_id);
		expect(second.frames.at(-1)?.location).toEqual(base());
	} finally { f.channel.stop(); }
});

test("unavailable observation stays ended until explicit retry, with a new subscription", async () => {
	const f = fixture(true), socket = await ready(f);
	try {
		f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120); const request = socket.frames.at(-1)!;
		socket.message({ type: "roster", subscription_id: request.subscription_id, status: "unavailable" });
		expect(f.roster).toHaveBeenLastCalledWith({ scope: base(), status: "unavailable", peers: [] });
		f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.at(-1)).toBe(request);
		f.channel.retry(); expect(socket.frames.at(-1)?.type).toBe("watch");
		expect(socket.frames.at(-1)?.subscription_id).not.toBe(request.subscription_id);
	} finally { f.channel.stop(); }
});

test.each([
	[{ target, name: "Member", path: "private" }], [{ target, name: "\nMember" }],
	[{ target, name: "Member" }, { target, name: "Duplicate" }],
	Array.from({ length: 128 }, (_, i) => ({ target: { ...target, instance_id: id(i + 100) }, name: "Member" })),
].map(peers => ({ peers })))("rejects malformed or over-limit rosters without retaining participants: %#", async ({ peers }) => {
	const f = fixture(true), socket = await ready(f);
	f.channel.watch(picture()); await jest.advanceTimersByTimeAsync(120); const request = socket.frames.at(-1)!;
	socket.message({ type: "roster", subscription_id: request.subscription_id, status: "available", peers });
	expect(f.channel.status).toBe("unavailable");
	expect(f.roster).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] }); f.channel.stop();
});

test("extended location schemas reject unsupported targets, stale format and imprecise revisions", async () => {
	const f = fixture(true); await ready(f);
	try {
		for (const location of [{ ...base(), registry_revision: 1.5 }, { ...base(), registry_revision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...base(), value: "formula result" }, { ...picture(), content_sha256: "unknown" }, { ...picture(), pointer: { x: 0.5 } }]) {
			expect(() => f.channel.publish(location)).toThrow("Invalid location");
		}
	} finally { f.channel.stop(); }
});

const embedded = (x = 0.5) => ({ version: 1, occurrence: { anchor: { type: null, tname: "contents", item: { client: 7, clock: 10 }, assoc: 0 }, head: { type: null, tname: "contents", item: { client: 7, clock: 30 }, assoc: -1 } },
    source_sha256: "c".repeat(64), asset: { kind: "external", url_sha256: "d".repeat(64), version_evidence: "unknown" },
    basis: { width: 640, height: 480, orientation: "display" }, state: { pointer: { x, y: 0.5 }, viewport: null } } as const);

test("embed publication coalesces, clears on hide and never replays after reconnect", async () => {
    const f = fixture(true, true, false, true);
    try {
        const socket = await ready(f);
        expect(f.channel.supportsEmbeddedImages).toBe(true);
        for (let x = 0; x <= 1000; x++) f.channel.publishEmbeddedImage(embedded(x / 1000));
        await jest.advanceTimersByTimeAsync(125);
        const frames = socket.frames.filter(frame => frame.type === "image_embed");
        expect(frames).toHaveLength(2);
        expect(frames.at(-1)).toEqual({ type: "image_embed", location: note(), embed: embedded(1) });
        f.channel.publishEmbeddedImage(null); expect(socket.frames.at(-1)).toMatchObject({ type: "image_embed", embed: null });
        f.channel.publishEmbeddedImage(embedded()); f.channel.publish(null); await jest.advanceTimersByTimeAsync(125);
        expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
        f.channel.publish(note()); f.channel.publishEmbeddedImage(embedded()); await jest.advanceTimersByTimeAsync(125);
        socket.disconnect(); await jest.advanceTimersByTimeAsync(1000);
        const next = f.sockets.at(-1)!; next.open(); next.ready(3600, 2);
        expect(next.frames.some(frame => frame.type === "image_embed")).toBe(false);
    } finally { f.channel.stop(); }
    expect(jest.getTimerCount()).toBe(0);
});

test("embed observation is independent of publishing, changes scopes and ignores stale delivery", async () => {
    const f = fixture(true, true, true, true);
    try {
        const socket = await ready(f); f.channel.publish(null); f.channel.watchEmbeds(note()); await jest.advanceTimersByTimeAsync(120);
        const watch = socket.frames.at(-1)!;
        expect(watch).toMatchObject({ type: "watch_embeds", location: note() });
        const frame = { type: "image_embeds", subscription_id: watch.subscription_id, status: "available", peers: [{ target, embed: embedded() }] };
        const rosterCalls = f.roster.mock.calls.length; socket.message(frame);
        expect(f.imageEmbeds).toHaveBeenLastCalledWith({ scope: note(), status: "available", peers: frame.peers });
        expect(f.roster.mock.calls).toHaveLength(rosterCalls);
        f.channel.watch(picture()); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.slice(-2)).toMatchObject([{ type: "unwatch", subscription_id: watch.subscription_id }, { type: "watch", image_states: true }]);
        expect(f.imageEmbeds).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
        const count = f.imageEmbeds.mock.calls.length; socket.message(frame); expect(f.imageEmbeds.mock.calls).toHaveLength(count);
        f.channel.watchEmbeds(note(99)); await jest.advanceTimersByTimeAsync(120); const current = socket.frames.at(-1)!;
        socket.message({ type: "image_embeds", subscription_id: current.subscription_id, status: "unavailable" });
        expect(f.imageEmbeds).toHaveBeenLastCalledWith({ scope: note(99), status: "unavailable", peers: [] });
        socket.message({ ...frame, subscription_id: current.subscription_id });
        expect(f.imageEmbeds).toHaveBeenLastCalledWith({ scope: note(99), status: "unavailable", peers: [] });
    } finally { f.channel.stop(); }
});

test.each([false, true])("embed capability is required, including on extended servers: %s", async server => {
    const f = fixture(true, server);
    try {
        const socket = await ready(f); f.channel.watchEmbeds(note()); await jest.advanceTimersByTimeAsync(120); f.channel.publishEmbeddedImage(embedded()); await jest.advanceTimersByTimeAsync(125);
        expect(f.channel.supportsEmbeddedImages).toBe(false);
        expect(socket.frames.some(frame => frame.type === "watch_embeds" || frame.type === "image_embed")).toBe(false);
    } finally { f.channel.stop(); }
});

const baseState = (x = 0.5): BasePresenceState => ({ version: 1, pointer: { target: { type: "cell", record_id: id(40), record_generation: id(41), property: { source: "note", name: "status" } }, offset: { x, y: 0.5 } }, viewport: null });

test("Bases movement coalesces, clears on privacy/surface changes and never replays after reconnect", async () => {
	const f = fixture(true, true, false, false, true, true);
	try {
		const socket = await ready(f); f.channel.publish(base());
		for (let x = 0; x <= 1000; x++) f.channel.publishBaseState(baseState(x / 1000));
		expect(socket.frames.filter(value => value.type === "base_state")).toHaveLength(0);
		await jest.advanceTimersByTimeAsync(125);
		expect(socket.frames.slice(-2)).toEqual([{ type: "presence", location: base() }, { type: "base_state", location: base(), state: baseState(1) }]);
		f.channel.publishBaseState(null); expect(socket.frames.at(-1)).toMatchObject({ type: "base_state", state: null });
		f.channel.publishBaseState(baseState()); f.channel.publish(null); await jest.advanceTimersByTimeAsync(125);
		expect(socket.frames.at(-1)).toEqual({ type: "presence", location: null });
		f.channel.publish(base()); f.channel.publishBaseState(baseState()); await jest.advanceTimersByTimeAsync(125);
		socket.disconnect(); await jest.advanceTimersByTimeAsync(1000); const next = f.sockets.at(-1)!; next.open(); next.ready(3600, 2);
		expect(next.frames.some(frame => frame.type === "base_state")).toBe(false);
		f.channel.publish(picture()); await jest.advanceTimersByTimeAsync(125); expect(next.frames.at(-1)).toEqual({ type: "presence", location: picture() });
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("Bases positions have an independent callback, keep roster controls stable and ignore old saved-view subscriptions", async () => {
	const f = fixture(true, true, false, false, true, true);
	try {
		const socket = await ready(f); f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120); const watch = socket.frames.at(-1)!;
		expect(watch).toMatchObject({ type: "watch", base_states: true }); expect(watch).not.toHaveProperty("image_states");
		const frame = { type: "base_states", subscription_id: watch.subscription_id, status: "available", peers: [{ target, state: baseState() }] };
		const count = f.roster.mock.calls.length; socket.message(frame);
		expect(f.baseStates).toHaveBeenLastCalledWith({ scope: base(), status: "available", peers: frame.peers }); expect(f.roster.mock.calls).toHaveLength(count);
		f.channel.watch(base(13)); await jest.advanceTimersByTimeAsync(120); expect(f.baseStates).toHaveBeenLastCalledWith({ scope: null, status: "unavailable", peers: [] });
		const calls = f.baseStates.mock.calls.length; socket.message(frame); expect(f.baseStates.mock.calls).toHaveLength(calls);
		const current = socket.frames.at(-1)!; socket.message({ type: "base_states", subscription_id: current.subscription_id, status: "unavailable" });
		expect(f.roster).toHaveBeenLastCalledWith({ scope: base(13), status: "unavailable", peers: [] });
	} finally { f.channel.stop(); }
});

test.each([false, true])("Bases record lookup and movement require negotiation (extended %s)", async extended => {
	const f = fixture(true, extended);
	try {
		const socket = await ready(f); f.channel.publish(base()); f.channel.publishBaseState(baseState()); f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120);
		await jest.advanceTimersByTimeAsync(125); expect(socket.frames.some(value => value.type === "base_state" || value.base_states)).toBe(false);
		await expect(f.channel.readBaseRecordContext(id(5), id(40))).rejects.toThrow(); expect(f.fetcher).toHaveBeenCalledTimes(2);
	} finally { f.channel.stop(); }
});

test("Bases record lineage lookup uses session credentials and fences delayed responses after stop", async () => {
	const f = fixture(true, true, false, false, true, true), context = { protocol_version: 1, share_id: id(5), entry_id: id(40), generation: id(41), type: "markdown" };
	try {
		await ready(f); f.fetcher.mockResolvedValueOnce(response(context));
		expect(await f.channel.readBaseRecordContext(id(5), id(40))).toEqual(context);
		expect(f.fetcher).toHaveBeenLastCalledWith(`https://relay.example/v1/collaboration/base-record-context?share_id=${id(5)}&entry_id=${id(40)}`, expect.objectContaining({ sensitive: true, method: "GET", headers: { Authorization: expect.stringMatching(/^Bearer /) } }));
		let complete!: (value: Response) => void; f.fetcher.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
		const pending = f.channel.readBaseRecordContext(id(5), id(40)); const rejection = expect(pending).rejects.toThrow(); await flush(); f.channel.stop(); complete(response(context)); await rejection;
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test.each(["unsolicited", "wrong-surface", "duplicate", "values", "extra"])("rejects invalid Bases frames: %s", async failure => {
	const f = fixture(true, true, false, false, true, failure !== "unsolicited");
	try {
		const socket = await ready(f); f.channel.watch(failure === "wrong-surface" ? picture() : base()); await jest.advanceTimersByTimeAsync(120);
		const watch = socket.frames.at(-1)!, peer = { target, state: baseState() };
		const peers = failure === "duplicate" ? [peer, peer] : failure === "values" ? [{ ...peer, state: { ...baseState(), value: "private" } }] : [peer];
		socket.message({ type: "base_states", subscription_id: watch.subscription_id, status: "available", peers, ...(failure === "extra" ? { path: "private" } : {}) });
		expect(f.channel.status).toBe("unavailable");
	} finally { f.channel.stop(); }
});

test.each([false, true])("extended Bases targets negotiate independently and downgrade for older servers: %s", async enabled => {
	const f = fixture(true, true, false, false, true, true, enabled);
	const state: BasePresenceState = { version: 2, pointer: { target: { type: "group", record_id: id(15), record_generation: id(16), property: { source: "note", name: "status" }, value_sha256: "a".repeat(64), references: [] }, offset: { x: 0.2, y: 0.5 } }, viewport: { target: { type: "property", property: { source: "note", name: "status" } }, offset: { x: 0, y: 0 } } };
	try {
		const socket = await ready(f); f.channel.publish(base()); f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120);
		expect(f.channel.supportsBaseTargetsV2).toBe(enabled);
		const watch = socket.frames.at(-1)!;
		if (enabled) expect(watch.base_target_version).toBe(2); else expect(watch).not.toHaveProperty("base_target_version");
		f.channel.publishBaseState(state); await jest.advanceTimersByTimeAsync(125);
		expect(socket.frames.at(-1)).toEqual({ type: "base_state", location: base(), state: enabled ? state : { version: 1, pointer: null, viewport: state.viewport } });
		if (enabled) {
			socket.message({ type: "base_states", subscription_id: watch.subscription_id, status: "available", peers: [{ target, state }] });
			expect(f.baseStates).toHaveBeenLastCalledWith({ scope: base(), status: "available", peers: [{ target, state }] });
		}
		socket.disconnect(); await jest.advanceTimersByTimeAsync(1000); const next = f.sockets.at(-1)!; next.open(); next.ready(3600, 2);
		expect(next.frames.some(frame => frame.type === "base_state")).toBe(false);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("passive observations deduplicate, isolate callbacks, retain foreground and fence removal", async () => {
	const f = fixture(true, true, true, true, true, true, true, true);
	try {
		const socket = await ready(f); f.channel.watch(base()); await jest.advanceTimersByTimeAsync(120);
		const foreground = socket.frames.at(-1)!;
		f.channel.observe([picture(), note(), { ...note(), surface: "reading" }]); await jest.advanceTimersByTimeAsync(120);
		const watches = socket.frames.filter(frame => frame.type === "observe"); expect(watches).toHaveLength(2);
		const image = watches.find(frame => (frame.location as ImageLocation).kind === "image")!, embed = watches.find(frame => (frame.location as NoteLocation).kind === "note")!;
		expect(image).toMatchObject({ location: picture(), image_states: true });
		const state = { pointer: { x: 0.3, y: 0.5 }, viewport: null }, legacy = f.imageStates.mock.calls.length;
		socket.message({ type: "image_states", subscription_id: image.subscription_id, status: "available", peers: [{ target, state }] });
		expect(f.observation).toHaveBeenLastCalledWith({ type: "image_states", scope: picture(), status: "available", peers: [{ target, state }] });
		expect(f.imageStates).toHaveBeenCalledTimes(legacy);
		socket.message({ type: "image_embeds", subscription_id: embed.subscription_id, status: "available", peers: [{ target, embed: embedded() }] });
		expect(f.observation).toHaveBeenLastCalledWith({ type: "image_embeds", scope: { ...note(), surface: "reading" }, status: "available", peers: [{ target, embed: embedded() }] });
		socket.message({ type: "roster", subscription_id: foreground.subscription_id, status: "available", peers: [{ target, name: "Member" }] });
		expect(f.roster).toHaveBeenLastCalledWith({ scope: base(), status: "available", peers: [{ target, name: "Member" }] });
		const count = socket.frames.length;
		for (let i = 0; i < 100; i++) f.channel.observe([note(), picture()]);
		expect(socket.frames).toHaveLength(count); expect(f.sockets).toHaveLength(1);
		f.channel.observe([note()]); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.at(-1)).toEqual({ type: "unobserve", subscription_id: image.subscription_id });
		expect(f.observation).toHaveBeenLastCalledWith({ type: "reset", scope: picture() });
		const emitted = f.observation.mock.calls.length;
		socket.message({ type: "roster", subscription_id: image.subscription_id, status: "available", peers: [] });
		expect(f.observation).toHaveBeenCalledTimes(emitted); expect(f.channel.ready).toBe(true);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test("passive denial requires retry, preserves other scopes and reconnect uses new subscription identities", async () => {
	const f = fixture(true, true, true, true, true, true, true, true);
	try {
		const socket = await ready(f); f.channel.observe([picture(), base()]); await jest.advanceTimersByTimeAsync(120);
		const first = socket.frames.filter(frame => frame.type === "observe")[0];
		socket.message({ type: "roster", subscription_id: first.subscription_id, status: "unavailable" });
		expect(f.observation).toHaveBeenLastCalledWith({ type: "roster", scope: picture(), status: "unavailable", peers: [] });
		f.channel.observe([picture(), base()]); await jest.advanceTimersByTimeAsync(120); expect(socket.frames.filter(frame => frame.type === "observe")).toHaveLength(2);
		f.channel.retry(); const retry = socket.frames.at(-1)!; expect(retry).toMatchObject({ type: "observe", location: picture() }); expect(retry.subscription_id).not.toBe(first.subscription_id);
		socket.message({ type: "roster", subscription_id: first.subscription_id, status: "available", peers: [] });
		expect(f.observation.mock.calls.at(-1)![0].status).toBe("unavailable");
		socket.disconnect(); expect(f.observation).toHaveBeenLastCalledWith({ type: "reset", scope: null });
		await jest.advanceTimersByTimeAsync(1000); const next = f.sockets.at(-1)!; next.open(); next.ready(3600, 2);
		const renewed = next.frames.filter(frame => frame.type === "observe"); expect(renewed).toHaveLength(2);
		expect(renewed.every(frame => frame.subscription_id !== retry.subscription_id && frame.subscription_id !== first.subscription_id)).toBe(true);
		expect(next.frames.some(frame => frame.type === "image_state" || frame.type === "base_state")).toBe(false);
	} finally { f.channel.stop(); }
	expect(jest.getTimerCount()).toBe(0);
});

test.each([false, true])("multiple observation capability is explicit and bounded (server support %s)", async supported => {
	const f = fixture(true, true, true, true, true, true, true, supported);
	try {
		const socket = await ready(f), scopes = Array.from({ length: 8 }, (_, i) => note(i + 50));
		f.channel.observe(scopes); await jest.advanceTimersByTimeAsync(120); expect(f.channel.supportsMultiWatch).toBe(supported);
		expect(socket.frames.filter(frame => frame.type === "observe")).toHaveLength(supported ? 8 : 0);
		expect(() => f.channel.observe([...scopes, note(99)])).toThrow("Too many");
		expect(socket.frames.filter(frame => frame.type === "unobserve")).toHaveLength(0);
	} finally { f.channel.stop(); }
});

test("passive Bases events keep version negotiation and reject a mismatched surface", async () => {
	const f = fixture(true, true, true, true, true, true, true, true);
	try {
		const socket = await ready(f); f.channel.observe([base()]); await jest.advanceTimersByTimeAsync(120); const request = socket.frames.at(-1)!;
		expect(request).toMatchObject({ type: "observe", base_states: true, base_target_version: 2 });
		socket.message({ type: "base_states", subscription_id: request.subscription_id, status: "available", peers: [{ target, state: baseState() }] });
		expect(f.observation).toHaveBeenLastCalledWith({ type: "base_states", scope: base(), status: "available", peers: [{ target, state: baseState() }] });
		socket.message({ type: "image_states", subscription_id: request.subscription_id, status: "available", peers: [] });
		expect(f.channel.status).toBe("unavailable"); expect(f.observation).toHaveBeenLastCalledWith({ type: "reset", scope: null });
	} finally { f.channel.stop(); }
});
