import { LocationChannel, type LocationIdentity } from "../../src/collaboration/presence/LocationChannel";
import type { NoteLocation } from "../../src/collaboration/presence/LocationProtocol";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity: LocationIdentity = { serverUrl: "https://relay.example", accountId: id(1), loginSessionId: id(2), instanceId: id(3) };
const note = (n = 4): NoteLocation => ({ kind: "note", share_id: id(5), entry_id: id(n), surface: "editor" });
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
	ready(expiresIn = 3600) { this.message({ type: "ready", protocol_version: 1, session_id: "b".repeat(32), instance_id: id(3), expires_at: Math.floor(Date.now() / 1000) + expiresIn }); }
	disconnect(code = 1006) { this.readyState = 3; this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent); }
}
function fixture() {
	const sockets: Socket[] = [], status = jest.fn(), location = jest.fn(), followStopped = jest.fn();
	let counter = 0;
	const fetcher = jest.fn(async (url: string) => url.includes("/capabilities?") ? response({ protocol_version: 1, features: { presence_locations_preview: true } }) :
		response({ protocol_version: 1, ticket: "ticket_" + String(++counter).padStart(32, "0"), expires_in: 30, socket_path: "/v1/collaboration/events" }));
	const options = { credential: jest.fn(credentials), fetcher, status, location, followStopped, random: () => 0.5,
		socket: (url: string) => { const socket = new Socket(url); sockets.push(socket); return socket as unknown as WebSocket; } };
	const channel = new LocationChannel(identity, options);
	return { channel, options, sockets, fetcher, status, location, followStopped };
}
const flush = () => jest.advanceTimersByTimeAsync(0);
async function ready(f: ReturnType<typeof fixture>, expiresIn = 3600) {
	f.channel.start(id(5), note()); await flush();
	const socket = f.sockets.at(-1)!; expect(socket).toBeDefined(); socket.open(); socket.ready(expiresIn); return socket;
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

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
