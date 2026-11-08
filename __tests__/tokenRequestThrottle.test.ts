/**
 * Unit tests: TokenRequestThrottle
 *
 * Measured on the two-client load stand: the old fixed 25/min queue was the
 * ceiling. Both clients sat at it, and a new connection waited ~47s for its
 * relay token, while the control plane allows 300/min per user and share. The
 * throttle now runs at 120/min with a burst of 10 and falls back to 25/min
 * once a server answers 429.
 */

import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

jest.mock("../src/platformFetch");
import { platformFetch } from "../src/platformFetch";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import {
	RateLimitError,
	RelayOnPremTokenProvider,
	TokenRequestThrottle,
	TOKEN_REQUEST_BURST,
	TOKEN_REQUESTS_PER_MINUTE,
	TOKEN_REQUESTS_PER_MINUTE_LIMITED,
	TOKEN_RATE_LIMITED_HOLD_MS,
} from "../src/auth/RelayOnPremTokenProvider";
import {
	holdBackgroundTokens,
	resetTokenRequestClasses,
	tokenWaitStats,
} from "../src/auth/tokenRequestClass";

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("TokenRequestThrottle", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	test("a request for an ordinary document goes ahead of queued background ones", async () => {
		resetTokenRequestClasses();
		const throttle = new TokenRequestThrottle();
		const order: string[] = [];
		const ask = (docId: string) => void throttle.acquire(docId).then(() => order.push(docId));
		const releases = Array.from({ length: 30 }, (_, i) => holdBackgroundTokens(`bulk-${i}`));
		for (let i = 0; i < 30; i++) ask(`bulk-${i}`);
		await flush();
		expect(order).toHaveLength(TOKEN_REQUEST_BURST);

		// A pull that gave up releases its hold; its queued request must not
		// jump ahead of an edit queued after it.
		releases[29]();
		ask("edit");
		jest.advanceTimersByTime(Math.ceil(60_000 / TOKEN_REQUESTS_PER_MINUTE));
		await flush();
		expect(order.slice(TOKEN_REQUEST_BURST)).toEqual(["edit"]);

		const waits = tokenWaitStats();
		expect(waits.normal.count).toBe(1);
		expect(waits.normal.max).toBeLessThanOrEqual(Math.ceil(60_000 / TOKEN_REQUESTS_PER_MINUTE));
		// The rest still comes, in order.
		jest.advanceTimersByTime(60_000);
		await flush();
		expect(order.slice(TOKEN_REQUEST_BURST + 1)).toEqual(
			Array.from({ length: 30 - TOKEN_REQUEST_BURST }, (_, i) => `bulk-${TOKEN_REQUEST_BURST + i}`),
		);
		releases.forEach((release) => release());
		throttle.destroy();
	});

	test("a document stays background until its last holder lets go", () => {
		resetTokenRequestClasses();
		const first = holdBackgroundTokens("doc");
		const second = holdBackgroundTokens("doc");
		first();
		first();
		expect(tokenWaitStats().backgroundDocs).toBe(1);
		second();
		expect(tokenWaitStats().backgroundDocs).toBe(0);
	});

	function acquireMany(throttle: TokenRequestThrottle, n: number): { done: number } {
		const state = { done: 0 };
		for (let i = 0; i < n; i++) void throttle.acquire().then(() => state.done++);
		return state;
	}

	test("a burst goes out at once, then the steady rate", async () => {
		const throttle = new TokenRequestThrottle();
		const state = acquireMany(throttle, 40);
		await flush();
		expect(state.done).toBe(TOKEN_REQUEST_BURST);

		jest.advanceTimersByTime(60_000);
		await flush();
		// One minute later: the burst plus a minute's worth at the steady rate.
		expect(state.done).toBe(40);
		throttle.destroy();
	});

	test("30 requests are served in well under a minute (the old queue took 72s)", async () => {
		const throttle = new TokenRequestThrottle();
		const state = acquireMany(throttle, 30);
		jest.advanceTimersByTime(Math.ceil(((30 - TOKEN_REQUEST_BURST) * 60_000) / TOKEN_REQUESTS_PER_MINUTE));
		await flush();
		expect(state.done).toBe(30);
		throttle.destroy();
	});

	test("after a 429 it holds the old rate with no burst, then recovers", async () => {
		const throttle = new TokenRequestThrottle();
		throttle.slowDown(0);
		const state = acquireMany(throttle, 400);
		await flush();
		expect(state.done).toBe(0);

		const interval = Math.ceil(60_000 / TOKEN_REQUESTS_PER_MINUTE_LIMITED);
		jest.advanceTimersByTime(interval * 3);
		await flush();
		expect(state.done).toBe(3);

		// Through the whole hold: the old rate only.
		jest.advanceTimersByTime(TOKEN_RATE_LIMITED_HOLD_MS - interval * 3 - 1_000);
		await flush();
		const held = state.done;
		expect(held).toBeLessThanOrEqual(Math.ceil(TOKEN_RATE_LIMITED_HOLD_MS / interval));
		// Past it: the rest at the steady rate.
		const rest = 400 - held;
		jest.advanceTimersByTime(1_000 + Math.ceil((rest * 60_000) / TOKEN_REQUESTS_PER_MINUTE) + 1_000);
		await flush();
		expect(state.done).toBe(400);
		throttle.destroy();
	});

	test("time spent in a hold is credited at the old rate, not the steady one", async () => {
		const throttle = new TokenRequestThrottle();
		acquireMany(throttle, TOKEN_REQUEST_BURST);
		await flush();
		throttle.slowDown(0);
		// Idle through the hold and one second past it.
		jest.advanceTimersByTime(TOKEN_RATE_LIMITED_HOLD_MS + 1_000);
		const state = acquireMany(throttle, 10);
		await flush();
		// At most 1 saved during the hold, plus 1s at 120/min = 2.
		expect(state.done).toBe(3);
		throttle.destroy();
	});

	test("429s that keep coming after each hold make the hold longer", async () => {
		const throttle = new TokenRequestThrottle();
		const interval = Math.ceil(60_000 / TOKEN_REQUESTS_PER_MINUTE_LIMITED);
		throttle.slowDown(0);
		jest.advanceTimersByTime(TOKEN_RATE_LIMITED_HOLD_MS + 1_000);
		// Right after the first hold: another 429, so 20 min this time.
		throttle.slowDown(0);
		jest.advanceTimersByTime(TOKEN_RATE_LIMITED_HOLD_MS + 60_000);
		const state = acquireMany(throttle, 10);
		await flush();
		jest.advanceTimersByTime(interval * 2);
		await flush();
		// Still on the old rate 11 minutes in.
		expect(state.done).toBeLessThanOrEqual(3);
		throttle.destroy();
	});

	test("a clock stepped back doesn't stall the queue", async () => {
		const throttle = new TokenRequestThrottle();
		acquireMany(throttle, TOKEN_REQUEST_BURST);
		await flush();
		jest.setSystemTime(Date.now() - 3_600_000);
		const state = acquireMany(throttle, 3);
		jest.advanceTimersByTime(5_000);
		await flush();
		expect(state.done).toBe(3);
		throttle.destroy();
	});

	test("one timer for any number of waiters; destroy() releases them and leaves no timer", async () => {
		const throttle = new TokenRequestThrottle(60, 1);
		const state = acquireMany(throttle, 5);
		await flush();
		expect(state.done).toBe(1);
		expect(jest.getTimerCount()).toBe(1);
		throttle.slowDown();
		void throttle.acquire().then(() => state.done++);
		expect(jest.getTimerCount()).toBe(1);

		throttle.destroy();
		await flush();
		expect(state.done).toBe(6);
		expect(jest.getTimerCount()).toBe(0);
		await throttle.acquire();
		expect(jest.getTimerCount()).toBe(0);
	});

	test("FIFO order", async () => {
		const throttle = new TokenRequestThrottle(60, 1);
		const order: number[] = [];
		for (let i = 0; i < 4; i++) void throttle.acquire().then(() => order.push(i));
		jest.advanceTimersByTime(5_000);
		await flush();
		expect(order).toEqual([0, 1, 2, 3]);
		throttle.destroy();
	});

	test("a 429 from the control plane slows the provider's token requests down", async () => {
		const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;
		const ok = {
			relay_url: "wss://relay.example.com",
			token: "relay-token",
			expires_at: new Date(Date.now() + 600_000).toISOString(),
		};
		let calls = 0;
		mockFetch.mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				return { ok: false, status: 429, text: async () => "", headers: new Headers({ "Retry-After": "1" }) } as Response;
			}
			return { ok: true, status: 200, json: async () => ok, text: async () => "", headers: new Headers() } as Response;
		});
		const authProvider = { getToken: () => "user-token", getValidToken: async () => "user-token" } as unknown as IAuthProvider;
		const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://cp.example.com", authProvider });
		await expect(provider.requestToken("r", "share", "doc-0")).rejects.toBeInstanceOf(RateLimitError);

		let done = 0;
		for (let i = 1; i <= 5; i++) void provider.requestToken("r", "share", `doc-${i}`).then(() => done++);
		await jest.advanceTimersByTimeAsync(5_000);
		// 25/min: one every 2.4s, not a burst of five.
		expect(done).toBeLessThanOrEqual(2);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(done).toBe(5);
		provider.destroy();
	});
});
