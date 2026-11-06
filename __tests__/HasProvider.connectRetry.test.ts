/**
 * Regression test for: a failed first token request used to be
 * terminal.
 *
 * ProviderBacked.bringOnline() fetches a token, then calls _liveProvider.connect()
 * to open the websocket. Before this fix, a rejected token fetch just logged a
 * warning and returned false — _liveProvider.connect() was never called, so
 * _liveProvider never emits "connection-error", so the ONE automatic retry path
 * (attachConnectionErrorHandler's reconnectGate.schedule) never fires. A
 * transient failure on the very first bringOnline() attempt (wrong-host 404
 * while multi-server routing catches up, a 500, a network blip) left the
 * folder/document disconnected forever, until Obsidian restarted.
 *
 * This test drives the real ProviderBacked class (not a reimplementation) with
 * a fake token store whose first call rejects and a fake YSweetProvider (no
 * real network/websocket — that class is not what's under test here) to
 * assert a retry is actually SCHEDULED AND FIRES, not just that bringOnline()
 * returns false.
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

jest.mock("../src/client/provider", () => {
	class FakeYSweetProvider {
		maxBackoffTime: number;
		connectionState: { status: string } = { status: "disconnected" };
		intent = "read";
		awareness = { setLocalStateField: jest.fn(), setLocalState: jest.fn(), getLocalState: () => null };
		connect = jest.fn(() => {
			this.connectionState = { status: "connected" };
		});
		disconnect = jest.fn(() => {
			this.connectionState = { status: "disconnected" };
		});
		destroy = jest.fn();
		private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

		constructor(_url: string, _room: string, _doc: unknown, opts: { maxBackoffTime?: number } = {}) {
			this.maxBackoffTime = opts.maxBackoffTime ?? 2500;
		}

		on(event: string, cb: (...args: unknown[]) => void): void {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set());
			this.listeners.get(event)!.add(cb);
		}

		off(event: string, cb: (...args: unknown[]) => void): void {
			this.listeners.get(event)?.delete(cb);
		}

		canReconnect(): boolean {
			return true;
		}

		hasUrl(): boolean {
			return true;
		}

		refreshToken(url: string): { urlChanged: boolean; newUrl: string } {
			return { urlChanged: false, newUrl: url };
		}
	}
	return { YSweetProvider: FakeYSweetProvider };
});

import { ProviderBacked } from "../src/ProviderBacked";
import { RemoteFolderAddress } from "../src/ResourceAddress";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import type { AuthSession } from "../src/AuthSession";
import type { DocumentGrant } from "../src/relay/TokenShapes";

const VALID_TOKEN: DocumentGrant = {
	token: "real-token",
	url: "ws://relay.example.com/d/doc/ws",
	docId: "doc",
	expiryTime: Date.now() + 60_000,
} as DocumentGrant;

function makeTokenStore(getToken: jest.Mock): RelayCredentialCache {
	return {
		peekToken: () => undefined,
		getToken,
		dropFromQueue: jest.fn(),
	} as unknown as RelayCredentialCache;
}

describe("ProviderBacked.bringOnline() retries after a failed first token request", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test("BUG (would fail pre-fix): a rejected first getProviderToken() schedules a retry, which succeeds", async () => {
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockRejectedValueOnce(new Error("404 wrong host"))
			.mockResolvedValueOnce(VALID_TOKEN);

		const hp = new ProviderBacked(
			"11111111-1111-4111-8111-111111111111",
			new RemoteFolderAddress("relay-onprem", "11111111-1111-4111-8111-111111111111"),
			makeTokenStore(getToken),
			{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
			"server-b",
		);

		// First attempt: token fetch rejects.
		const firstResult = await hp.bringOnline();
		expect(firstResult).toBe(false);
		expect(getToken).toHaveBeenCalledTimes(1);
		expect(hp.isOnline).toBe(false);

		// Nothing external (no "connection-error" event) drives the retry --
		// _liveProvider.connect() was never reached on the failing attempt, so
		// that event physically cannot fire. The only thing that can make a
		// second attempt happen is the fix itself: the catch branch
		// scheduling its own retry. Advance past _liveProvider.maxBackoffTime
		// (2500ms here) with no other stimulus.
		await jest.advanceTimersByTimeAsync(2500);

		expect(getToken).toHaveBeenCalledTimes(2);
		expect(hp.isOnline).toBe(true);
	});

	test("goOffline() after a failed bringOnline() cancels the scheduled retry", async () => {
		// A background pull whose token request failed releases the doc with
		// goOffline(); the retry must not reconnect it behind that intent.
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockRejectedValueOnce(new Error("503 control plane"))
			.mockResolvedValue(VALID_TOKEN);

		const hp = new ProviderBacked(
			"33333333-3333-4333-8333-333333333333",
			new RemoteFolderAddress("relay-onprem", "33333333-3333-4333-8333-333333333333"),
			makeTokenStore(getToken),
			{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
			"server-b",
		);

		expect(await hp.bringOnline()).toBe(false);
		hp.goOffline();
		await jest.advanceTimersByTimeAsync(10_000);

		expect(getToken).toHaveBeenCalledTimes(1);
		expect(hp.isOnline).toBe(false);
	});

	test("CONTROL: a successful first bringOnline() does not schedule a spurious extra retry", async () => {
		const getToken = jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(VALID_TOKEN);

		const hp = new ProviderBacked(
			"22222222-2222-4222-8222-222222222222",
			new RemoteFolderAddress("relay-onprem", "22222222-2222-4222-8222-222222222222"),
			makeTokenStore(getToken),
			{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
			"server-a",
		);

		const result = await hp.bringOnline();
		expect(result).toBe(true);
		expect(getToken).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(5000);

		// No retry scheduled on the success path -- still exactly one call.
		expect(getToken).toHaveBeenCalledTimes(1);
	});

	test("a SECOND consecutive failure schedules another retry (not a one-shot)", async () => {
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockRejectedValueOnce(new Error("500"))
			.mockRejectedValueOnce(new Error("timeout"))
			.mockResolvedValueOnce(VALID_TOKEN);

		const hp = new ProviderBacked(
			"33333333-3333-4333-8333-333333333333",
			new RemoteFolderAddress("relay-onprem", "33333333-3333-4333-8333-333333333333"),
			makeTokenStore(getToken),
			{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
			"server-c",
		);

		expect(await hp.bringOnline()).toBe(false);
		expect(getToken).toHaveBeenCalledTimes(1);

		// Two failures in a row must not exhaust the retry mechanism -- each
		// scheduled retry has to reschedule itself again on its own failure,
		// not just once. Don't assert the exact intermediate timing (the
		// gate's lastFiredAt=0 initial state makes the first computed delay
		// 0 under fake timers, which is a test-harness artifact, not part of
		// what this test is checking) -- assert the eventual outcome: both
		// retries fire and the third attempt succeeds.
		await jest.advanceTimersByTimeAsync(10_000);
		expect(getToken).toHaveBeenCalledTimes(3);
		expect(hp.isOnline).toBe(true);
	});
});
