/**
 * Regression test for (two vaults assign DIFFERENT Y.Doc guids to
 * the same shared file).
 *
 * Root cause: ProviderBacked.onceEverSynced()'s "synced" flag is sticky
 * BY DESIGN (see its own doc comment) -- once true, it never resets, even
 * across a disconnect. That's correct for its original use case ("did this
 * object ever complete a sync"), but VaultShare's own bootstrap gate
 * (_onReady()/refreshFromServer()) needs a DIFFERENT question answered: "has a FRESH
 * sync landed for the connection I'm about to act on". Reusing the sticky
 * method there meant adoptLocalFiles() could run against local state whose
 * folderIndex hadn't actually received this connection's own folder metadata
 * yet -- confirmed live (self-hosted stand): the sticky flag resolved
 * immediately while the underlying provider reported NOT synced at that
 * exact moment.
 *
 * This test drives the real ProviderBacked class (not a reimplementation),
 * with a fake YSweetProvider whose `synced` flag and "synced" event are
 * driven manually, to prove:
 *   (a) onceEverSynced() is (deliberately) still sticky -- unchanged
 *       behavior, not a regression to "fix" away.
 *   (b) onceFreshlySynced() is NOT sticky -- on the exact same post-
 *       disconnect state where (a) resolves immediately, it waits for a
 *       genuinely new "synced" event.
 *   (c) onceFreshlySynced() still resolves immediately when the provider
 *       IS currently synced (the common, fast-path case).
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
		maxBackoffTime = 2500;
		connectionState: { status: string } = { status: "disconnected" };
		intent = "read";
		synced = false;
		awareness = { setLocalStateField: jest.fn(), setLocalState: jest.fn(), getLocalState: () => null };
		connect = jest.fn(() => {
			this.connectionState = { status: "connected" };
		});
		disconnect = jest.fn(() => {
			this.connectionState = { status: "disconnected" };
			// Matches the real provider per onceEverSynced()'s own doc
			// comment: "provider.synced resets to false on disconnect".
			this.synced = false;
		});
		destroy = jest.fn();
		private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

		constructor(_url: string, _room: string, _doc: unknown) {}

		on(event: string, cb: (...args: unknown[]) => void): void {
			if (!this.listeners.has(event)) this.listeners.set(event, new Set());
			this.listeners.get(event)!.add(cb);
		}

		off(event: string, cb: (...args: unknown[]) => void): void {
			this.listeners.get(event)?.delete(cb);
		}

		once(event: string, cb: (...args: unknown[]) => void): void {
			const wrapper = (...args: unknown[]) => {
				this.off(event, wrapper);
				cb(...args);
			};
			this.on(event, wrapper);
		}

		/** Test helper: simulate the provider completing a fresh sync round-trip. */
		fireSynced(): void {
			this.synced = true;
			this.listeners.get("synced")?.forEach((cb) => cb());
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

function makeTokenStore(): RelayCredentialCache {
	return {
		peekToken: () => undefined,
		getToken: jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(VALID_TOKEN),
		dropFromQueue: jest.fn(),
	} as unknown as RelayCredentialCache;
}

function makeProviderBacked(guid: string): ProviderBacked {
	return new ProviderBacked(
		guid,
		new RemoteFolderAddress("relay-onprem", guid),
		makeTokenStore(),
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
}

function fakeProviderOf(hp: ProviderBacked): any {
	return (hp as any)._liveProvider;
}

describe("ProviderBacked: onceEverSynced() sticky vs onceFreshlySynced() fresh", () => {
	test("onceEverSynced() resolves immediately on the FIRST ever sync (unaffected baseline)", async () => {
		const hp = makeProviderBacked("11111111-1111-4111-8111-111111111111");
		const p = hp.onceEverSynced();
		let resolved = false;
		void p.then(() => { resolved = true; });
		await Promise.resolve();
		expect(resolved).toBe(false); // hasn't synced yet -- must wait

		fakeProviderOf(hp).fireSynced();
		await p;
		expect(resolved).toBe(true);
	});

	test("BUG (documents unchanged, deliberate behavior): onceEverSynced() is sticky across a disconnect", async () => {
		const hp = makeProviderBacked("22222222-2222-4222-8222-222222222222");
		fakeProviderOf(hp).fireSynced();
		await hp.onceEverSynced(); // first call settles the sticky featureKey

		// Disconnect: the underlying provider genuinely un-syncs.
		fakeProviderOf(hp).disconnect();
		expect(fakeProviderOf(hp).synced).toBe(false);

		// A second call resolves IMMEDIATELY despite the provider reporting
		// NOT synced right now -- this is onceEverSynced()'s documented,
		// intentional stickiness, not something this fix touches.
		let resolvedSync = false;
		void hp.onceEverSynced().then(() => { resolvedSync = true; });
		await Promise.resolve();
		expect(resolvedSync).toBe(true);
	});

	test("FIX: onceFreshlySynced() is NOT sticky -- on the identical post-disconnect state, it waits for a genuinely new sync", async () => {
		const hp = makeProviderBacked("33333333-3333-4333-8333-333333333333");
		fakeProviderOf(hp).fireSynced();
		await hp.onceEverSynced(); // sticky featureKey now permanently true

		fakeProviderOf(hp).disconnect();
		expect(fakeProviderOf(hp).synced).toBe(false);

		// Same state as the BUG test above -- but onceFreshlySynced() must NOT
		// resolve until a fresh "synced" event actually arrives.
		let resolvedFresh = false;
		const freshPromise = hp.onceFreshlySynced().then(() => { resolvedFresh = true; });
		await Promise.resolve();
		expect(resolvedFresh).toBe(false); // <-- this is what onceEverSynced() gets wrong

		fakeProviderOf(hp).fireSynced(); // the reconnect's own genuine sync lands
		await freshPromise;
		expect(resolvedFresh).toBe(true);
	});

	test("CONTROL: onceFreshlySynced() still resolves immediately when currently synced (fast path preserved)", async () => {
		const hp = makeProviderBacked("44444444-4444-4444-8444-444444444444");
		fakeProviderOf(hp).fireSynced();

		let resolved = false;
		void hp.onceFreshlySynced().then(() => { resolved = true; });
		await Promise.resolve();
		expect(resolved).toBe(true);
	});
});
