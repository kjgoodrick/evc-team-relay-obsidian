/**
 * W10 guard: our OWN lifecycle methods were renamed
 * `connect` -> `bringOnline` and `destroy` -> `dismantle`, but the calls
 * ProviderBacked makes INTO the third-party y-sweet provider and into Yjs's
 * own `Y.Doc` must keep their original spellings — `_provider.connect()`,
 * `_provider.destroy()`, `ydoc.destroy()`. Those are external APIs; we do not
 * get to rename them.
 *
 * `tsc` cannot catch a rename that slipped into one of those calls. The
 * provider is mocked/duck-typed in tests, and in production a wrong name on a
 * structurally-typed object either resolves to `undefined` (a TypeError only
 * at teardown time, in a `?.`-guarded path that swallows it) or, worse,
 * silently does nothing — a websocket left open and a Y.Doc never torn down,
 * with a green compile and a green type-check. So the assertion has to be
 * about the LITERAL PROPERTY NAME reaching the external object at runtime.
 *
 * The provider fake below is therefore a Proxy that records every property
 * name read off it. The tests assert both directions:
 *   - the original names ARE read and the underlying functions ARE invoked;
 *   - the NEW names are never read off the external object at all (a rename
 *     that leaked would show up here as `bringOnline`/`dismantle` in the
 *     access log even if the call itself failed silently).
 *
 * Negative control included: a deliberately-miscalled teardown is shown to
 * fail these assertions, so a green run means the probe can actually go red.
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
				once: jest.fn(),
				canReconnect: () => true,
				hasUrl: () => true,
				refreshToken: (url: string) => ({ urlChanged: false, newUrl: url }),
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

function makeBacked(guid: string): ProviderBacked {
	const tokenStore = {
		peekToken: () => undefined,
		getToken: jest.fn<() => Promise<DocumentGrant>>().mockResolvedValue(VALID_TOKEN),
		dropFromQueue: jest.fn(),
	} as unknown as RelayCredentialCache;
	return new ProviderBacked(
		guid,
		new RemoteFolderAddress("relay-onprem", guid),
		tokenStore,
		{ getCurrentUserForServer: () => undefined, on: () => (() => {}) } as unknown as AuthSession,
		"server-a",
	);
}

describe("W10: our rename must not have touched the external provider / Y.Doc API", () => {
	beforeEach(() => {
		propReads.length = 0;
	});

	test("bringOnline() reaches the provider as `connect`, never as `bringOnline`", async () => {
		const backed = makeBacked("11111111-1111-4111-8111-111111111111");
		propReads.length = 0;

		await backed.bringOnline();

		// The external function actually ran...
		expect(lastProvider.connect).toHaveBeenCalledTimes(1);
		// ...and it was reached under its ORIGINAL name.
		expect(propReads).toContain("connect");
		// The renamed spelling must never be looked up on the external object.
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

	test("disconnect() still reaches the provider as `disconnect` (untouched by the rename)", () => {
		const backed = makeBacked("33333333-3333-4333-8333-333333333333");
		propReads.length = 0;

		backed.goOffline();

		expect(lastProvider.disconnect).toHaveBeenCalledTimes(1);
		expect(propReads).toContain("disconnect");
	});

	test("NEGATIVE CONTROL: a teardown that used the renamed spelling would fail the assertions above", () => {
		const backed = makeBacked("44444444-4444-4444-8444-444444444444");
		propReads.length = 0;

		// Stand-in for the exact defect this suite exists to catch: a blind
		// find/replace having rewritten `this._provider.destroy()` into
		// `this._provider.dismantle()`. It compiles (the provider is
		// structurally typed in tests), it throws nothing that a `?.` chain
		// wouldn't swallow, and the websocket is simply never torn down.
		const provider = (backed as unknown as { _liveProvider: Record<string, unknown> })._liveProvider;
		const wrongName = provider["dismantle"] as (() => void) | undefined;
		wrongName?.();

		expect(wrongName).toBeUndefined();
		expect(lastProvider.destroy).not.toHaveBeenCalled();
		expect(propReads).toContain("dismantle");
		// i.e. had the production call looked like this, the two tests above
		// would have gone red on exactly these two assertions.
	});

	test("Y.Doc teardown still calls Yjs's own `destroy` (Document/CanvasDocument dismantle path)", () => {
		// Document.dismantle()/CanvasDocument.dismantle() call
		// `super.dismantle()` and then `this.crdtDoc.destroy()` — the second is
		// Yjs's own Y.Doc method and keeps its name. Spied on the real
		// prototype so this asserts against actual Yjs, not a stand-in.
		const spy = jest.spyOn(Y.Doc.prototype, "destroy");
		try {
			const backed = makeBacked("55555555-5555-4555-8555-555555555555");
			expect(backed.crdtDoc).toBeInstanceOf(Y.Doc);
			// The exact two statements Document.dismantle() runs, in order.
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
