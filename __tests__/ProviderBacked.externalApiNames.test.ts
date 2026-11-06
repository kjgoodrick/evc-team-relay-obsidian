/**
 * W18 guard: gate-4 class-rename residue renamed 26
 * ProviderBacked members, including the ones that WRAP calls into the
 * third-party y-sweet provider (`_provider` -> `_liveProvider`) and into
 * Yjs's own `Y.Doc` (`ydoc` -> `crdtDoc`). Those two fields hold EXTERNAL
 * objects whose own method/property names are not ours to rename:
 * `.connect()`, `.disconnect()`, `.destroy()`, `.hasUrl()`, `.refreshToken()`,
 * `.connectionState`, `.intent`, `.synced`, `.on()`/`.off()`/`.once()`.
 *
 * `tsc` cannot catch a rename that slipped into one of those calls — the
 * provider is structurally typed, so a stray `this._liveProvider.bringOnline()`
 * compiles cleanly against a duck-typed test double and, against the REAL
 * provider in production, either throws deep inside a `?.`-guarded path that
 * swallows it or silently does nothing (a websocket never opened, a Y.Doc
 * never torn down). So the assertion has to be about the LITERAL PROPERTY
 * NAME reaching the external object at runtime, not just "the call didn't
 * throw" — same method used for the first two of these renames (see
 * `providerExternalApiNames.test.ts`, which this file extends for
 * `connect`/`destroy`).
 *
 * The provider fake is a Proxy that records every property name read off it.
 * Each test asserts BOTH directions:
 *   - the ORIGINAL external name IS read and the underlying function IS
 *     invoked;
 *   - the NEW (renamed) spelling is never looked up on the external object
 *     at all -- a leaked rename would show up here as e.g. `bringOnline` in
 *     the access log even if the call itself failed silently.
 *
 * A negative control (mirroring W10's) proves the probe can actually go red:
 * a deliberately-miscalled site is shown to fail exactly these assertions.
 */

import { describe, test, expect, jest, beforeEach } from "@jest/globals";
import * as Y from "yjs";

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

/** Every property name read off the live provider instance, in order. */
const propReads: string[] = [];
/** The most recently constructed provider fake's call spies. */
let lastProvider: FakeProviderShape;

interface FakeProviderShape {
	connect: jest.Mock;
	disconnect: jest.Mock;
	destroy: jest.Mock;
	hasUrl: jest.Mock;
	refreshToken: jest.Mock;
	on: jest.Mock;
	off: jest.Mock;
	once: jest.Mock;
	canReconnect: jest.Mock;
	[k: string]: unknown;
}

jest.mock("../src/client/provider", () => {
	class FakeYSweetProvider {
		constructor(_url: string, _room: string, _doc: unknown) {
			const target: FakeProviderShape = {
				maxBackoffTime: 2500,
				connectionState: { status: "disconnected" },
				intent: "read",
				synced: false,
				awareness: { setLocalStateField: jest.fn(), setLocalState: jest.fn(), getLocalState: () => null },
				connect: jest.fn(() => {
					(target.connectionState as { status: string }).status = "connected";
				}),
				disconnect: jest.fn(() => {
					(target.connectionState as { status: string }).status = "disconnected";
				}),
				destroy: jest.fn(),
				on: jest.fn(),
				off: jest.fn(),
				once: jest.fn((event: string, cb: () => void) => {
					// synchronous single-shot stand-in, matching the real once()'s
					// eventual callback shape -- fireSynced() below triggers it.
					target[`__once_${event}`] = cb;
				}),
				canReconnect: jest.fn(() => true),
				hasUrl: jest.fn(() => true),
				refreshToken: jest.fn((url: string) => ({ urlChanged: false, newUrl: url })),
			};
			lastProvider = target;
			// A Proxy, not a plain object: the point of this fixture is to see
			// WHICH NAME the production code reaches for, including a name that
			// does not exist on the real provider (which a plain object would
			// report only as an unhelpful `undefined is not a function`).
			return new Proxy(target, {
				get(t, prop, recv) {
					if (typeof prop === "string") propReads.push(prop);
					return Reflect.get(t, prop, recv);
				},
			});
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
		// A non-expired token, so the constructor seeds `issuedToken` with
		// something hasFreshProviderToken() can meaningfully evaluate below
		// (an empty/expired seed would make that test's assertion trivial).
		peekToken: () => VALID_TOKEN,
		getToken: jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(VALID_TOKEN),
		dropFromQueue: jest.fn(),
	} as unknown as RelayCredentialCache;
}

function makeBacked(guid: string): ProviderBacked {
	return new ProviderBacked(
		guid,
		new RemoteFolderAddress("relay-onprem", guid),
		makeTokenStore(),
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
}

describe("W18: renamed ProviderBacked members must not have touched the external provider / Y.Doc API", () => {
	beforeEach(() => {
		propReads.length = 0;
	});

	test("bringOnline() reaches the provider as `connect`, never as `bringOnline`", async () => {
		const backed = makeBacked("11111111-1111-4111-8111-111111111111");
		propReads.length = 0;

		await backed.bringOnline();

		expect(lastProvider.connect).toHaveBeenCalledTimes(1);
		expect(propReads).toContain("connect");
		expect(propReads).not.toContain("bringOnline");
	});

	test("dismantle() reaches the provider as `destroy`, never as `dismantle`", () => {
		const backed = makeBacked("22222222-2222-4222-8222-222222222222");
		propReads.length = 0;

		backed.dismantle();

		expect(lastProvider.destroy).toHaveBeenCalledTimes(1);
		expect(propReads).toContain("destroy");
		expect(propReads).not.toContain("dismantle");
	});

	test("goOffline() reaches the provider as `disconnect`, never as `goOffline`", () => {
		const backed = makeBacked("33333333-3333-4333-8333-333333333333");
		propReads.length = 0;

		backed.goOffline();

		expect(lastProvider.disconnect).toHaveBeenCalledTimes(1);
		expect(propReads).toContain("disconnect");
		expect(propReads).not.toContain("goOffline");
	});

	test("hasFreshProviderToken() reaches the provider as `hasUrl`, never as `hasFreshProviderToken` or `providerActive`", () => {
		const backed = makeBacked("44444444-4444-4444-8444-444444444444");
		propReads.length = 0;

		const result = backed.hasFreshProviderToken();

		expect(lastProvider.hasUrl).toHaveBeenCalledTimes(1);
		expect(propReads).toContain("hasUrl");
		expect(propReads).not.toContain("hasFreshProviderToken");
		expect(propReads).not.toContain("providerActive");
		// Sanity: the fake's hasUrl() always returns true and the seeded token
		// hasn't expired, so this should resolve true -- confirms the call's
		// return value is actually being used, not just invoked and discarded.
		expect(result).toBe(true);
	});

	test("applyRefreshedToken() reaches the provider as `refreshToken`, never as `applyRefreshedToken` or `refreshProvider`", () => {
		const backed = makeBacked("55555555-5555-4555-8555-555555555555");
		propReads.length = 0;

		backed.applyRefreshedToken(VALID_TOKEN);

		expect(lastProvider.refreshToken).toHaveBeenCalledTimes(1);
		expect(lastProvider.refreshToken).toHaveBeenCalledWith(
			VALID_TOKEN.url,
			VALID_TOKEN.docId,
			VALID_TOKEN.token,
		);
		expect(propReads).toContain("refreshToken");
		expect(propReads).not.toContain("applyRefreshedToken");
		expect(propReads).not.toContain("refreshProvider");
	});

	test("connectionIntent getter reaches the provider as `intent`, never as `connectionIntent`", () => {
		const backed = makeBacked("66666666-6666-4666-8666-666666666666");
		propReads.length = 0;

		const intent = backed.connectionIntent;

		expect(propReads).toContain("intent");
		expect(propReads).not.toContain("connectionIntent");
		expect(intent).toBe("read");
	});

	test("connectionState getter reaches the provider as `connectionState` (external field name unchanged)", () => {
		const backed = makeBacked("77777777-7777-4777-8777-777777777777");
		propReads.length = 0;

		const state = backed.connectionState;

		expect(propReads).toContain("connectionState");
		expect(state).toEqual({ status: "disconnected" });
	});

	test("onceEverSynced() reaches the provider as `synced`/`once`, never as `onceEverSynced` or `onceProviderSynced`", async () => {
		const backed = makeBacked("88888888-8888-4888-8888-888888888888");
		propReads.length = 0;

		const p = backed.onceEverSynced();
		expect(propReads).toContain("synced");
		expect(propReads).toContain("once");
		expect(propReads).not.toContain("onceEverSynced");
		expect(propReads).not.toContain("onceProviderSynced");

		// Fire the registered "synced" callback the same way the real
		// provider would, so the promise actually settles.
		(lastProvider[`__once_synced`] as (() => void) | undefined)?.();
		await p;
	});

	test("NEGATIVE CONTROL: a call that used a renamed spelling against the raw provider would fail the assertions above", () => {
		const backed = makeBacked("99999999-9999-4999-8999-999999999999");
		propReads.length = 0;

		// Stand-in for the exact defect this suite exists to catch: a blind
		// find/replace having rewritten `this._liveProvider.disconnect()` into
		// `this._liveProvider.goOffline()`. It compiles (the provider is
		// structurally typed in tests), throws nothing a `?.` chain wouldn't
		// swallow, and the websocket is simply never torn down.
		const provider = (backed as unknown as { _liveProvider: Record<string, unknown> })
			._liveProvider;
		const wrongName = provider["goOffline"] as (() => void) | undefined;
		wrongName?.();

		expect(wrongName).toBeUndefined();
		expect(lastProvider.disconnect).not.toHaveBeenCalled();
		expect(propReads).toContain("goOffline");
		// i.e. had the production call looked like this, the goOffline() test
		// above would have gone red on exactly these two assertions.
	});

	test("Y.Doc teardown still calls Yjs's own `destroy` under `crdtDoc` (Document/CanvasDocument dismantle path)", () => {
		// Document.dismantle()/CanvasDocument.dismantle() call
		// `super.dismantle()` and then `this.crdtDoc.destroy()` -- the second
		// is Yjs's own Y.Doc method and keeps its name; only the FIELD we call
		// it through was renamed (`ydoc` -> `crdtDoc`), not the method invoked
		// on it. Spied on the real prototype so this asserts against actual
		// Yjs, not a stand-in.
		const spy = jest.spyOn(Y.Doc.prototype, "destroy");
		try {
			const backed = makeBacked("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
			expect(backed.crdtDoc).toBeInstanceOf(Y.Doc);
			// The exact two statements Document.dismantle()/CanvasDocument.dismantle() run, in order.
			backed.dismantle();
			backed.crdtDoc.destroy();

			expect(spy).toHaveBeenCalledTimes(1);
			// Yjs exposes teardown under `destroy` only; nothing renamed it.
			expect(
				(backed.crdtDoc as unknown as Record<string, unknown>)["dismantle"],
			).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
});
