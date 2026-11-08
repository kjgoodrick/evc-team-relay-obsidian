import { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RelayOnPremTokenProvider, RelayRestoreRequiredError } from "../src/auth/RelayOnPremTokenProvider";
import { RemoteDocumentAddress, RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import type { AuthSession } from "../src/AuthSession";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import { MockClock } from "./mocks/MockClock";
import { platformFetch } from "../src/platformFetch";

jest.mock("../src/platformFetch");
jest.mock("../src/logging", () => ({ namedLogger: () => jest.fn(), Loggable: class {}, instanceLabels: { set: jest.fn() } }));
const fetch = jest.mocked(platformFetch);
const share = "a1111111-1111-4111-8111-111111111111", document = "b1111111-1111-4111-8111-111111111111", generation = "c1111111-1111-4111-8111-111111111111";
const address = ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", share, document));
const root = ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", share));
const reply = (context: string | null = null) => new Response(JSON.stringify({ token: "grant", relay_url: "ws://fixture/v1/managed/socket",
	expires_at: new Date(Date.now() + 600_000).toISOString(), restore_guard: true, restore_generation: context }));
const restore = () => new Response(JSON.stringify({ error: { message: { code: "restore_generation_changed" } } }), { status: 409 });
const auth = { getToken: () => "fixture", getValidToken: async () => "fixture" } as IAuthProvider;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => fetch.mockReset());

test("restore refusal pauses the document cache through clear/relogin while inventory and another server stay usable", async () => {
	const a = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	const b = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://b.test", authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "fixture", 5, new Map([["a", a], ["b", b]]));
	const listener = jest.fn(); cache.onRestoreRequired(listener);
	try {
		fetch.mockResolvedValueOnce(restore());
		await expect(cache.getToken(address, "Note.md", jest.fn(), "a")).rejects.toBeInstanceOf(RelayRestoreRequiredError);
		expect(cache.isRestoreRequired(address, "a")).toBe(true); expect(cache.isAccessDenied(address)).toBe(false);
		expect(listener).toHaveBeenCalledWith(address);
		cache.clearAccessDenied(); cache.clear();
		await expect(cache.getToken(address, "Note.md", jest.fn(), "a")).rejects.toBeInstanceOf(RelayRestoreRequiredError);
		expect(fetch).toHaveBeenCalledTimes(1);
		fetch.mockResolvedValueOnce(reply(generation));
		expect((await cache.getToken(root, "Team", jest.fn(), "a")).restoreGeneration).toBe(generation);
		fetch.mockResolvedValueOnce(reply()); await cache.getToken(address, "Note.md", jest.fn(), "b");
		expect(cache.isRestoreRequired(address, "b")).toBe(false); expect(fetch).toHaveBeenCalledTimes(3);
	} finally { cache.destroy(); }
});

test("a socket restore notification fences an older successful token still in flight", async () => {
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "fixture", 5, new Map([["a", provider]]));
	const wait = deferred<Response>(); fetch.mockReturnValueOnce(wait.promise);
	const pending = cache.getToken(address, "Note.md", jest.fn(), "a");
	await Promise.resolve(); await Promise.resolve();
	cache.markRestoreRequired(address, "a"); wait.resolve(reply());
	await expect(pending).rejects.toBeInstanceOf(RelayRestoreRequiredError);
	expect(cache.peekToken(address)).toBeNull(); cache.destroy();
});

test.each(["success", "restore"])("late %s after unload settles without notifying or rebuilding the cache", async outcome => {
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "fixture", 5, new Map([["a", provider]]));
	const wait = deferred<Response>(); fetch.mockReturnValueOnce(wait.promise);
	const listener = jest.fn(); cache.onRestoreRequired(listener);
	const pending = cache.getToken(address, "Note.md", jest.fn(), "a");
	await Promise.resolve(); await Promise.resolve();
	cache.destroy(); wait.resolve(outcome === "success" ? reply() : restore());
	await expect(pending).rejects.toThrow();
	expect(cache.peekToken(address)).toBeUndefined(); expect(listener).not.toHaveBeenCalled();
	expect(cache.isRestoreRequired(address, "a")).toBe(false);
	await expect(cache.getToken(address, "Note.md", jest.fn(), "a")).rejects.toThrow("destroyed");
});

test("document request freezes its binding before auth and keeps it across the read fallback", async () => {
	const wait = deferred<string>(), binding = { restoreGeneration: generation };
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: { ...auth, getValidToken: () => wait.promise } });
	fetch.mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(reply(generation));
	const pending = provider.requestToken("relay", share, document, "write", "Note.md", binding);
	binding.restoreGeneration = share; wait.resolve("fixture");
	expect((await pending).restoreGeneration).toBe(generation);
	for (const call of fetch.mock.calls) expect(call[1]?.headers).toMatchObject({ "X-Relay-Restore-Generation": generation });
	expect(JSON.parse(fetch.mock.calls[1][1]?.body as string).mode).toBe("read"); provider.destroy();
});

test("a response cannot stamp a new generation onto an original document, or drop support for a bound one", async () => {
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	fetch.mockResolvedValueOnce(reply(generation));
	await expect(provider.requestToken("relay", share, document)).rejects.toBeInstanceOf(RelayRestoreRequiredError);
	fetch.mockResolvedValueOnce(new Response(JSON.stringify({ token: "grant", relay_url: "ws://fixture", expires_at: new Date(Date.now() + 600_000).toISOString() })));
	await expect(provider.requestToken("relay", share, document, "read", undefined, { restoreGeneration: generation })).rejects.toBeInstanceOf(RelayRestoreRequiredError);
	provider.destroy();
});
