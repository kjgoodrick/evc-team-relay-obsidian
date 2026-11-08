/**
 *: the provider's own onclose-driven reconnect must not replay the
 * URL (and token) it connected with once that token has expired.
 *
 * An established connection only needs its token at the handshake, so it can
 * outlive it by hours. When it drops (sleep/wake, server restart, network
 * change) with no "error" event, YSweetProvider's own onclose path reopens the
 * socket against the URL it was created with — an expired token, guaranteed
 * rejected by the relay. This drives the REAL ProviderBacked + YSweetProvider
 * against a fake WebSocket and records every URL the socket layer is asked to
 * open.
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

class FakeWS {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances: FakeWS[] = [];
	readyState = FakeWS.CONNECTING;
	binaryType = "";
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onclose: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onmessage: ((e: unknown) => void) | null = null;
	constructor(public url: string) {
		FakeWS.instances.push(this);
	}
	send(): void {}
	close(): void {
		this.readyState = FakeWS.CLOSED;
	}
	open(): void {
		this.readyState = FakeWS.OPEN;
		this.onopen?.();
	}
	/** Server-side drop of an established connection: close, no error event. */
	drop(code = 1006): void {
		this.readyState = FakeWS.CLOSED;
		this.onclose?.({ code });
	}
}

import { ProviderBacked } from "../src/ProviderBacked";
import { RemoteFolderAddress } from "../src/ResourceAddress";
import type { RelayCredentialCache } from "../src/RelayCredentialCache";
import type { AuthSession } from "../src/AuthSession";
import type { DocumentGrant } from "../src/relay/TokenShapes";
import { testGlobal } from "./mocks/testGlobal";
import { resetConnectGate } from "../src/client/connectGate";

const grant = (token: string, expiryTime: number): DocumentGrant =>
	({
		token,
		url: "ws://relay.example.com/d/doc/ws",
		docId: "doc",
		expiryTime,
	}) as DocumentGrant;

const G = "44444444-4444-4444-8444-444444444444";

function build(getToken: jest.Mock) {
	const cache = {
		peekToken: () => undefined,
		getToken,
		dropFromQueue: jest.fn(),
	} as unknown as RelayCredentialCache;
	return new ProviderBacked(
		G,
		new RemoteFolderAddress("relay-onprem", G),
		cache,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
}

const urls = () => FakeWS.instances.map((w) => w.url);

describe("onclose reconnect never reuses an expired token", () => {
	const RealWS = (testGlobal as { WebSocket?: unknown }).WebSocket;
	beforeEach(() => {
		jest.useFakeTimers();
		FakeWS.instances = [];
		resetConnectGate();
		(testGlobal as { WebSocket?: unknown }).WebSocket = FakeWS;
	});
	afterEach(() => {
		jest.useRealTimers();
		(testGlobal as { WebSocket?: unknown }).WebSocket = RealWS;
	});

	test("managed restore close pauses immediately without replay, token refresh or loss of local edits", async () => {
		const token = { ...grant("old", Date.now() + 600_000), url: "ws://relay.example.com/v1/managed/socket" };
		const getToken = jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(token);
		const pb = build(getToken); pb.crdtDoc.getText("contents").insert(0, "keep these edits");
		expect(await pb.bringOnline()).toBe(true); FakeWS.instances[0].open();
		FakeWS.instances[0].drop(4412);
		expect(pb.restoreReviewRequired).toBe(true); expect(pb.isOnline).toBe(false);
		await jest.advanceTimersByTimeAsync(60_000);
		expect(getToken).toHaveBeenCalledTimes(1); expect(FakeWS.instances).toHaveLength(1);
		expect(await pb.bringOnline()).toBe(false);
		pb.applyRefreshedToken({ ...token, token: "late" }); expect(pb.issuedToken.token).toBe("old");
		await expect(pb.ensureActiveProvider()).rejects.toThrow("restore review");
		expect(pb.crdtDoc.getText("contents").toString()).toBe("keep these edits");
		pb.dismantle(); pb.crdtDoc.destroy();
	});

	test("expired token: the reconnect after a silent drop opens with a NEWLY minted token, never the old one", async () => {
		const t0 = Date.now();
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValueOnce(grant("old", t0 + 5 * 60_000))
			.mockResolvedValueOnce(grant("new", t0 + 65 * 60_000));
		const pb = build(getToken);

		expect(await pb.bringOnline()).toBe(true);
		FakeWS.instances[0].open();
		expect(urls()[0]).toContain("token=old");

		// The connection lives past its token's expiry, then drops silently.
		jest.setSystemTime(t0 + 60 * 60_000);
		FakeWS.instances[0].drop();
		await jest.advanceTimersByTimeAsync(10_000);

		expect(urls().some((u, i) => i > 0 && u.includes("token=old"))).toBe(false);
		expect(getToken).toHaveBeenCalledTimes(2);
		expect(urls()[urls().length - 1]).toContain("token=new");
	});

	test("CONTROL: a still-fresh token is reused without a mint (fast path unchanged)", async () => {
		const t0 = Date.now();
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValue(grant("old", t0 + 5 * 60_000));
		const pb = build(getToken);

		await pb.bringOnline();
		FakeWS.instances[0].open();
		FakeWS.instances[0].drop();
		await jest.advanceTimersByTimeAsync(10_000);

		expect(getToken).toHaveBeenCalledTimes(1);
		expect(FakeWS.instances.length).toBe(2);
		expect(urls()[1]).toContain("token=old");
	});

	test("a reconnect queued while fresh checks credentials again after sleep", async () => {
		const t0 = Date.now();
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValueOnce(grant("old", t0 + 5 * 60_000))
			.mockResolvedValueOnce(grant("new", t0 + 65 * 60_000));
		const pb = build(getToken);
		await pb.bringOnline();
		FakeWS.instances[0].open();
		FakeWS.instances[0].drop();
		expect(getToken).toHaveBeenCalledTimes(1);
		expect(FakeWS.instances).toHaveLength(1);

		// Sleep advances wall time without running the pending backoff timer.
		jest.setSystemTime(t0 + 60 * 60_000);
		await jest.advanceTimersByTimeAsync(10_000);

		expect(urls().slice(1).some((u) => u.includes("token=old"))).toBe(false);
		expect(getToken).toHaveBeenCalledTimes(2);
		expect(urls().at(-1)).toContain("token=new");
		pb.dismantle();
	});

	test("a deliberate goOffline() is not turned back into a reconnect by the guard", async () => {
		const t0 = Date.now();
		const getToken = jest
			.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValue(grant("old", t0 + 5 * 60_000));
		const pb = build(getToken);

		await pb.bringOnline();
		FakeWS.instances[0].open();
		jest.setSystemTime(t0 + 60 * 60_000);
		pb.goOffline();
		FakeWS.instances[0].drop();
		await jest.advanceTimersByTimeAsync(10_000);

		expect(getToken).toHaveBeenCalledTimes(1);
		expect(FakeWS.instances.length).toBe(1);
	});

	test.each(["goOffline", "dismantle"] as const)("%s cancels a socket attempt queued before sleep", async (stop) => {
		const t0 = Date.now();
		const getToken = jest.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValue(grant("old", t0 + 5 * 60_000));
		const pb = build(getToken);
		await pb.bringOnline();
		FakeWS.instances[0].open();
		FakeWS.instances[0].drop();
		pb[stop]();
		jest.setSystemTime(t0 + 60 * 60_000);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(getToken).toHaveBeenCalledTimes(1);
		expect(FakeWS.instances).toHaveLength(1);
		if (stop !== "dismantle") pb.dismantle();
	});

	test("failed renewal after sleep opens no stale socket and retries through the cache", async () => {
		const t0 = Date.now();
		const getToken = jest.fn<() => Promise<DocumentGrant>>()
			.mockResolvedValueOnce(grant("old", t0 + 5 * 60_000))
			.mockRejectedValueOnce(new Error("temporarily offline"))
			.mockResolvedValueOnce(grant("new", t0 + 65 * 60_000));
		const pb = build(getToken);
		await pb.bringOnline();
		FakeWS.instances[0].open();
		FakeWS.instances[0].drop();
		jest.setSystemTime(t0 + 60 * 60_000);
		await jest.advanceTimersByTimeAsync(200);
		expect(getToken).toHaveBeenCalledTimes(2);
		expect(FakeWS.instances).toHaveLength(1);
		await jest.advanceTimersByTimeAsync(10_000);
		expect(getToken).toHaveBeenCalledTimes(3);
		expect(urls().slice(1)).toHaveLength(1);
		expect(urls()[1]).toContain("token=new");
		pb.dismantle();
	});
});
