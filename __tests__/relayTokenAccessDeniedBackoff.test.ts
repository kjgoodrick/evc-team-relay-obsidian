/**
 * A share the signed-in account cannot open (POST /v1/tokens/relay answers
 * 401, or 403 even for read) used to be retried on a fixed short floor
 * forever: bringOnline() failed, rescheduled itself through ReconnectGate,
 * and asked the control plane again (seen in production: one client, 60 x 401
 * per hour, 0 successes). Drives the REAL ProviderBacked + RelayCredentialCache
 * + RelayOnPremTokenProvider; only the network (platformFetch) is faked.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";

jest.mock("../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
		protected setLoggers(): void {}
	},
	instanceLabels: { set: jest.fn() },
}));

jest.mock("../src/platformFetch");
import { platformFetch } from "../src/platformFetch";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

import { ProviderBacked } from "../src/ProviderBacked";
import { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../src/auth/RelayOnPremTokenProvider";
import { ResourceAddress, RemoteDocumentAddress, RemoteFolderAddress } from "../src/ResourceAddress";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import type { AuthSession } from "../src/AuthSession";
import { MockClock } from "./mocks/MockClock";
import { testGlobal } from "./mocks/testGlobal";

/** A successful token leads to a socket; keep it off the network. */
class FakeWS {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FakeWS.CONNECTING;
	binaryType = "";
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onclose: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	constructor(public url: string) {}
	send(): void {}
	close(): void {
		this.readyState = FakeWS.CLOSED;
	}
}

const G = "55555555-5555-4555-8555-555555555555";
const MINUTE = 60_000;

const authProvider: IAuthProvider = {
	isLoggedIn: () => true,
	getCurrentUser: () => undefined,
	getToken: () => "user-jwt",
	getValidToken: async () => "user-jwt",
	loginWithPassword: () => Promise.reject(new Error("unused")),
	loginWithOAuth2: () => Promise.reject(new Error("unused")),
	refreshToken: () => Promise.reject(new Error("unused")),
	logout: () => Promise.reject(new Error("unused")),
	isTokenValid: () => true,
};

function respond(status: number): Promise<Response> {
	const body = status === 200
		? { relay_url: "wss://relay.example.com", token: "relay-token", expires_at: new Date(Date.now() + 5 * MINUTE).toISOString() }
		: { detail: "Not authenticated" };
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
		json: async () => body,
		headers: new Headers(),
	} as Response);
}

/** Answer token requests after `latencyMs`, recording how many overlap. */
let inFlight = 0;
let maxInFlight = 0;
function respondSlowly(status: number, latencyMs: number): Promise<Response> {
	inFlight++;
	maxInFlight = Math.max(maxInFlight, inFlight);
	return new Promise((resolve) => {
		window.setTimeout(() => {
			inFlight--;
			resolve(respond(status));
		}, latencyMs);
	});
}

/** The `mode` each token request asked for, in order. */
function tokenModes(): string[] {
	return mockFetch.mock.calls
		.filter(([url]) => String(url).endsWith("/v1/tokens/relay"))
		.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { mode: string }).mode);
}

function tokenCalls(): number {
	return mockFetch.mock.calls.filter(([url]) => String(url).endsWith("/v1/tokens/relay")).length;
}

/** bringOnline() waits on the token throttle's timer, so let fake time run. */
async function online(pb: ProviderBacked): Promise<boolean> {
	const done = pb.bringOnline();
	await jest.advanceTimersByTimeAsync(3_000);
	return done;
}

function build() {
	const clock = new MockClock();
	const cache = new RelayCredentialCache(
		{ isAuthenticated: false } as unknown as AuthSession,
		clock,
		"vault",
		3,
		new Map([["server-a", new RelayOnPremTokenProvider({ controlPlaneUrl: "https://cp.example.com", authProvider })]]),
		undefined,
		"server-a",
	);
	const pb = new ProviderBacked(
		G,
		new RemoteFolderAddress("relay-onprem", G),
		cache,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
	return { cache, clock, pb, docIn: (docGuid: string) => new ProviderBacked(
		docGuid,
		new RemoteDocumentAddress("relay-onprem", G, docGuid),
		cache,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	) };
}

describe("tokens/relay 401/403: back off instead of retrying on a fixed floor", () => {
	const RealWS = (testGlobal as { WebSocket?: unknown }).WebSocket;
	beforeEach(() => {
		jest.useFakeTimers();
		mockFetch.mockReset();
		inFlight = 0;
		maxInFlight = 0;
		(testGlobal as { WebSocket?: unknown }).WebSocket = FakeWS;
	});
	afterEach(() => {
		jest.useRealTimers();
		(testGlobal as { WebSocket?: unknown }).WebSocket = RealWS;
	});

	test("10 minutes of 401 cost at most 4 token requests", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { pb } = build();

		void pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
	});

	const DOCS = [
		"66666666-6666-4666-8666-666666666661",
		"66666666-6666-4666-8666-666666666662",
		"66666666-6666-4666-8666-666666666663",
	];

	test.each([401, 403])("%i: documents of a refused share ask one at a time: at most 4 requests in 10 minutes, never two in flight", async (status) => {
		// Latency well above the 2.4 s throttle spacing, so unserialized
		// requests would overlap.
		mockFetch.mockImplementation(() => respondSlowly(status, 5_000));
		const { pb, docIn } = build();

		for (const p of [pb, ...DOCS.map(docIn)]) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBe(1);
	});

	test("CONTROL: a working share's documents ask one at a time and are all connected within seconds", async () => {
		// Control-plane latency well above its 2026 p99 (about 230 ms).
		mockFetch.mockImplementation(() => respondSlowly(200, 400));
		const { docIn } = build();
		const ps = ["66666666-6666-4666-8666-66666666666a", ...DOCS].map(docIn);
		const results = ps.map((p) => p.bringOnline());
		await jest.advanceTimersByTimeAsync(5_000);

		expect(await Promise.all(results)).toEqual([true, true, true, true]);
		expect(maxInFlight).toBe(1);
	});

	test("10 minutes of 403 (write, then read) cost at most 4 token requests", async () => {
		mockFetch.mockImplementation(() => respond(403));
		const { pb } = build();

		void pb.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(2);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
	});

	test("the share reports no access while backed off, and a manual reset retries at once", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();

		await online(pb);
		expect(pb.accessDenied).toBe(true);
		const before = tokenCalls();

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		expect(pb.accessDenied).toBe(false);
		await online(pb);

		expect(tokenCalls()).toBe(before + 1);
		expect(pb.accessDenied).toBe(false);
	});

	test("CONTROL: a 500 is not treated as no access", async () => {
		mockFetch.mockImplementation(() => respond(500));
		const { pb } = build();

		await online(pb);
		expect(pb.accessDenied).toBe(false);
	});

	test.each([401, 403])("%i: the renewal sweep backs off too once a granted share is refused", async (status) => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, clock, docIn } = build();
		const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => `77777777-7777-4777-8777-77777777777${n}`);
		for (const p of docs.map(docIn)) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);
		const granted = tokenCalls();
		expect(granted).toBeGreaterThanOrEqual(7);

		// Access is revoked; tokens come up for renewal and the sweep runs every minute.
		mockFetch.mockImplementation(() => respondSlowly(status, 5_000));
		maxInFlight = 0;
		// Off the sweep's minute grid, so a renewal comes up before the token lapses.
		clock.setTime(clock.now() + 30_000);
		cache.startSweeping();
		for (let minute = 0; minute < 10; minute++) {
			clock.setTime(clock.now() + MINUTE);
			await jest.advanceTimersByTimeAsync(MINUTE);
		}
		cache.stopSweeping();

		// The sweep refreshes up to maxConnections (3 here) at once; renewals
		// of one share still ask one at a time.
		expect(tokenCalls() - granted).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBe(1);
		expect(docIn(docs[0]).accessDenied).toBe(true);
	});

	test.each([401, 403])("%i: documents whose tokens lapsed while asleep ask one at a time once the share is revoked", async (status) => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, clock, docIn } = build();
		const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => `88888888-8888-4888-8888-88888888888${n}`);
		const ids = docs.map((d) => ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", G, d)));
		for (const p of docs.map(docIn)) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);
		expect(tokenCalls()).toBeGreaterThanOrEqual(7);

		// Asleep past every token's expiry; access was revoked meanwhile.
		jest.setSystemTime(Date.now() + 30 * MINUTE);
		clock.setTime(clock.now() + 30 * MINUTE);
		mockFetch.mockImplementation(() => respondSlowly(status, 5_000));
		maxInFlight = 0;
		for (const id of ids) void cache.getToken(id, id, () => {}, "server-a").catch(() => undefined);
		await jest.advanceTimersByTimeAsync(30_000);

		expect(maxInFlight).toBe(1);
	});

	test("documents whose tokens lapsed ask one at a time even while another document's grant is still current", async () => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, clock, docIn } = build();
		const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => `88888888-8888-4888-8888-88888888889${n}`);
		const ids = docs.map((d) => ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", G, d)));
		for (const p of docs.map(docIn)) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);

		// One more document is granted later: the share's latest grant outlives the others.
		jest.setSystemTime(Date.now() + 4 * MINUTE);
		clock.setTime(clock.now() + 4 * MINUTE);
		void docIn("88888888-8888-4888-8888-888888888899").bringOnline();
		await jest.advanceTimersByTimeAsync(10_000);

		// The first seven lapse; access was revoked meanwhile.
		jest.setSystemTime(Date.now() + 2 * MINUTE);
		clock.setTime(clock.now() + 2 * MINUTE);
		mockFetch.mockImplementation(() => respondSlowly(401, 5_000));
		maxInFlight = 0;
		const before = tokenCalls();
		for (const id of ids) void cache.getToken(id, id, () => {}, "server-a").catch(() => undefined);
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(maxInFlight).toBe(1);
		expect(tokenCalls() - before).toBeLessThanOrEqual(4);
	});

	test("documents with lapsed tokens restored from storage (and pruned by the sweep) ask one at a time while another grant is current", async () => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, docIn } = build();
		expect(await online(docIn("88888888-8888-4888-8888-8888888888a0"))).toBe(true);
		const docs = [1, 2, 3, 4, 5, 6, 7].map((n) => `88888888-8888-4888-8888-8888888888a${n}`);
		const ids = docs.map((d) => ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", G, d)));
		// As a restart restores them: tokens held before, now past their expiry.
		const entries = (cache as unknown as { tokenEntries: Map<string, unknown> }).tokenEntries;
		for (const id of ids) {
			entries.set(id, { token: { url: "wss://relay.example.com", docId: id, token: "old", expiryTime: 1 }, friendlyName: id, expiryTime: 1, attempts: 0 });
		}
		// The sweep's first pass prunes them before any document asks.
		cache.startSweeping();
		cache.stopSweeping();

		mockFetch.mockImplementation(() => respondSlowly(401, 5_000));
		maxInFlight = 0;
		const before = tokenCalls();
		for (const id of ids) void cache.getToken(id, id, () => {}, "server-a").catch(() => undefined);
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(maxInFlight).toBe(1);
		expect(tokenCalls() - before).toBeLessThanOrEqual(4);
	});

	test.each([
		[401, 40_000],
		[403, 40_000],
		[401, 100_000],
		[401, 200_000],
		[403, 200_000],
	])("%i answered after %i ms: a refused share still asks one at a time, at most 4 requests in 10 minutes", async (status, latency) => {
		// Slower than the token request timeout: the timed-out request is
		// still in flight, so the share must not ask again until it is done.
		mockFetch.mockImplementation(() => respondSlowly(status, latency));
		const { pb, docIn } = build();

		for (const p of [pb, ...DOCS.map(docIn)]) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(10 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(tokenCalls()).toBeLessThanOrEqual(4);
		expect(maxInFlight).toBe(1);
	});

	test.each([401, 403])("%i answered after 15 minutes: the share never has two token requests in flight", async (status) => {
		mockFetch.mockImplementation(() => respondSlowly(status, 15 * MINUTE));
		const { pb, docIn } = build();

		for (const p of [pb, ...DOCS.map(docIn)]) void p.bringOnline();
		await jest.advanceTimersByTimeAsync(20 * MINUTE);

		expect(tokenCalls()).toBeGreaterThanOrEqual(1);
		expect(maxInFlight).toBe(1);
	});

	test("a token request that hangs fails after 30 s and holds its share off the network until it settles", async () => {
		let settle: (r: Response) => void = () => {};
		mockFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (settle = resolve)));
		mockFetch.mockImplementation(() => respond(200));
		const { cache } = build();
		const [hung, next, later] = DOCS.map((d) => ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", G, d)));
		let hungError: unknown;
		void cache.getToken(hung, hung, () => {}, "server-a").catch((e: unknown) => (hungError = e));
		await jest.advanceTimersByTimeAsync(3_000);
		let nextError: unknown;
		void cache.getToken(next, next, () => {}, "server-a").catch((e: unknown) => (nextError = e));

		await jest.advanceTimersByTimeAsync(20_000);
		expect(hungError).toBeUndefined();
		expect(nextError).toBeUndefined();
		await jest.advanceTimersByTimeAsync(15_000);
		expect(String(hungError)).toMatch(/no answer in 30s/);
		// The hung request may still be in flight: the share is not asked again yet.
		expect(String(nextError)).toMatch(/timed out; next try in/);
		expect(tokenCalls()).toBe(1);

		// Backoffs come and go; while the request is in flight no second one is sent.
		for (const wait of [2 * MINUTE, 30 * MINUTE]) {
			await jest.advanceTimersByTimeAsync(wait);
			let laterError: unknown;
			void cache.getToken(later, later, () => {}, "server-a").catch((e: unknown) => (laterError = e));
			await jest.advanceTimersByTimeAsync(3_000);
			expect(String(laterError)).toMatch(/still in flight|next try in/);
			expect(tokenCalls()).toBe(1);
		}

		// Once it settles the share goes back on the network.
		void respond(500).then(settle);
		await jest.advanceTimersByTimeAsync(10 * MINUTE);
		let granted = false;
		void cache.getToken(next, next, () => (granted = true), "server-a");
		await jest.advanceTimersByTimeAsync(3_000);
		expect(granted).toBe(true);
		expect(tokenCalls()).toBe(2);
	});

	test("a successful connect drops the retry an earlier refusal left waiting", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		await online(pb);
		const gate = (pb as unknown as { reconnectGate: { pending: boolean } }).reconnectGate;
		expect(gate.pending).toBe(true);

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		expect(await online(pb)).toBe(true);

		expect(gate.pending).toBe(false);
	});

	test("a cleared refusal brings the waiting retry forward instead of waiting out the old backoff", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		void pb.bringOnline();
		// 2 + 4 + 8 minutes: the next automatic retry is now 16 minutes out.
		await jest.advanceTimersByTimeAsync(15 * MINUTE);
		const before = tokenCalls();

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		await jest.advanceTimersByTimeAsync(2 * MINUTE);

		expect(tokenCalls()).toBe(before + 1);
	});

	test("a manual connect of one folder clears that share only", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		await online(pb);
		const other = "99999999-9999-4999-8999-999999999999";
		const otherId = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", other));
		await cache.getToken(otherId, otherId, () => {}, "server-a").catch(() => undefined);
		await jest.advanceTimersByTimeAsync(3_000);
		expect(cache.isAccessDenied(otherId)).toBe(true);

		pb.clearAccessDenied();

		expect(pb.accessDenied).toBe(false);
		expect(cache.isAccessDenied(otherId)).toBe(true);
	});

	test("a refusal found by the renewal sweep reaches the folder badge", async () => {
		mockFetch.mockImplementation(() => respond(200));
		const { cache, clock, pb } = build();
		expect(await online(pb)).toBe(true);
		const states: string[] = [];
		pb.subscribe({}, () => states.push(pb.accessDenied ? "no access" : "ok"));
		states.length = 0;

		mockFetch.mockImplementation(() => respond(401));
		clock.setTime(clock.now() + 30_000);
		cache.startSweeping();
		for (let minute = 0; minute < 5; minute++) {
			clock.setTime(clock.now() + MINUTE);
			await jest.advanceTimersByTimeAsync(MINUTE);
		}
		cache.stopSweeping();

		expect(states).toContain("no access");
	});

	test("a backed-off refresh reports its refusal asynchronously, so the renewal queue cannot recurse", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		await online(pb);
		expect(pb.accessDenied).toBe(true);

		const gated = (cache as unknown as { gatedRefresh: (id: string, ok: () => void, err: (e: Error) => void) => Promise<void> }).gatedRefresh;
		const contexts = (cache as unknown as { documentContexts: Map<string, { key: string; documentId: string }> }).documentContexts;
		const address = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", G));
		const key = [...contexts.values()].find(context => context.documentId === address)!.key;
		const err = jest.fn();
		void gated.call(cache, key, () => {}, err);
		expect(err).not.toHaveBeenCalled();
		await Promise.resolve();
		await Promise.resolve();
		expect(err).toHaveBeenCalledTimes(1);
	});

	test("a reset asks for write again after a share refused write", async () => {
		mockFetch.mockImplementation(() => respond(403));
		const { cache, pb } = build();
		await online(pb);
		expect(tokenModes()).toEqual(["write", "read"]);

		mockFetch.mockImplementation(() => respond(200));
		cache.clearAccessDenied();
		await online(pb);

		expect(tokenModes().slice(2)).toEqual(["write"]);
	});

	test("after a reset, a refusal is retried on the new window, not on the old long one", async () => {
		mockFetch.mockImplementation(() => respond(401));
		const { cache, pb } = build();
		void pb.bringOnline();
		// 2 + 4 + 8 minutes: the next automatic retry is now 16 minutes out.
		await jest.advanceTimersByTimeAsync(15 * MINUTE);
		const before = tokenCalls();

		cache.clearAccessDenied();
		await online(pb);
		expect(tokenCalls()).toBe(before + 1);
		// The share is refused again on a fresh window: 2 minutes, not 16.
		await jest.advanceTimersByTimeAsync(3 * MINUTE);
		expect(tokenCalls()).toBe(before + 2);
	});
});
