/**
 * A connect whose token request outlives its caller must not open a socket.
 *
 * A background pull stops waiting for bringOnline() after a timeout and
 * releases the document with goOffline(); the token request it left behind
 * used to finish later and call _liveProvider.connect(), leaving a
 * connection no lane accounted for.
 */

import { describe, test, expect, jest } from "@jest/globals";

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

function makeProvider(getToken: jest.Mock): ProviderBacked {
	const store = { peekToken: () => undefined, getToken, dropFromQueue: jest.fn() } as unknown as RelayCredentialCache;
	return new ProviderBacked(
		"11111111-1111-4111-8111-111111111111",
		new RemoteFolderAddress("relay-onprem", "11111111-1111-4111-8111-111111111111"),
		store,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-b",
	);
}

describe("ProviderBacked.bringOnline() cancelled by goOffline() while its token is on the way", () => {
	test("a token that lands after goOffline() opens no socket", async () => {
		let release!: (grant: DocumentGrant) => void;
		const getToken = jest.fn<() => Promise<DocumentGrant>>(
			() => new Promise<DocumentGrant>((resolve) => (release = resolve)),
		);
		const hp = makeProvider(getToken);

		const connect = hp.bringOnline();
		hp.goOffline();
		release(VALID_TOKEN);

		await expect(connect).resolves.toBe(false);
		expect(hp.isOnline).toBe(false);
	});

	test("control: the same connect without goOffline() does open the socket", async () => {
		let release!: (grant: DocumentGrant) => void;
		const getToken = jest.fn<() => Promise<DocumentGrant>>(
			() => new Promise<DocumentGrant>((resolve) => (release = resolve)),
		);
		const hp = makeProvider(getToken);

		const connect = hp.bringOnline();
		release(VALID_TOKEN);

		await expect(connect).resolves.toBe(true);
		expect(hp.isOnline).toBe(true);
	});

	test("a goOffline() before the connect started does not cancel it", async () => {
		const getToken = jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(VALID_TOKEN);
		const hp = makeProvider(getToken);
		hp.goOffline();
		await expect(hp.bringOnline()).resolves.toBe(true);
		expect(hp.isOnline).toBe(true);
	});

	test("a token that is rejected after goOffline() schedules no retry and opens no socket, however long we wait", async () => {
		jest.useFakeTimers();
		try {
			let reject!: (err: Error) => void;
			const getToken = jest.fn<() => Promise<DocumentGrant>>(
				() => new Promise<DocumentGrant>((_resolve, rej) => (reject = rej)),
			);
			const hp = makeProvider(getToken);

			const connect = hp.bringOnline();
			hp.goOffline();
			reject(new Error("503 control plane"));

			await expect(connect).resolves.toBe(false);
			await jest.advanceTimersByTimeAsync(60_000);
			expect(getToken).toHaveBeenCalledTimes(1);
			expect(hp.isOnline).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

	test("control: a token rejected without goOffline() still schedules its retry", async () => {
		jest.useFakeTimers();
		try {
			const getToken = jest
				.fn<() => Promise<DocumentGrant>>()
				.mockRejectedValueOnce(new Error("503 control plane"))
				.mockResolvedValue(VALID_TOKEN);
			const hp = makeProvider(getToken);

			await expect(hp.bringOnline()).resolves.toBe(false);
			await jest.advanceTimersByTimeAsync(5_000);
			expect(getToken).toHaveBeenCalledTimes(2);
			expect(hp.isOnline).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});
});
