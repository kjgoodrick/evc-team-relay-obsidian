import { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RelayOnPremTokenProvider, RelayRestoreRequiredError } from "../src/auth/RelayOnPremTokenProvider";
import { ResourceAddress, RemoteDocumentAddress } from "../src/ResourceAddress";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import type { AuthSession } from "../src/AuthSession";
import type { App } from "obsidian";
import { MockClock } from "./mocks/MockClock";
import { platformFetch } from "../src/platformFetch";
import { sourceDocumentCache } from "../src/storage/source-document-cache";

jest.mock("../src/platformFetch");
jest.mock("../src/logging", () => ({ namedLogger: () => jest.fn(), Loggable: class {}, instanceLabels: { set: jest.fn() } }));
const fetch = jest.mocked(platformFetch);
const share = "11111111-1111-4111-8111-111111111111", doc = "22222222-2222-4222-8222-222222222222";
const generation = "a3333333-3333-4333-8333-333333333333";
const address = ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", share, doc));
const jwt = (session: string, serial = 0) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: "user", session_id: session, serial })).toString('base64url')}.signature`;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const response = (server: string, lineage: string | null = null) => new Response(JSON.stringify({ token: server, relay_url: `wss://${server}.test/relay`,
	expires_at: new Date(Date.now() + 600_000).toISOString(), restore_guard: true, restore_generation: lineage }));
const caches: RelayCredentialCache[] = [];
function setup(app?: App) {
	const state = { token: jwt("first"), wait: undefined as Promise<string> | undefined };
	const auth = { getToken: () => state.token, getValidToken: () => state.wait ?? Promise.resolve(state.token) } as IAuthProvider;
	const a = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	const b = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://b.test", authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "fixture", 5, new Map([["a", a], ["b", b]]), app, "a");
	caches.push(cache); return { cache, state, a, b };
}
beforeEach(() => fetch.mockReset().mockImplementation(async (url, options) => response(new URL(String(url)).hostname.split(".")[0],
	(options?.headers as Record<string, string>)["X-Relay-Restore-Generation"] ?? null)));
afterEach(() => { for (const cache of caches.splice(0)) cache.destroy(); jest.restoreAllMocks(); });

test("loaded source identity must still match the selected server, endpoint, document and generation", async () => {
	const s = setup(), selected = { restoreGeneration: generation };
	const descriptor = await sourceDocumentCache({ hostAppId: "fixture", serverId: "a", controlPlaneUrl: "https://a.test", s3rn: address, ...selected });
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address, "a", selected)).not.toThrow();
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address, "b", selected)).toThrow("another server");
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address, "a")).toThrow("another server");
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address.replace(doc, crypto.randomUUID()), "a", selected)).toThrow("another server");
	s.a.updateControlPlaneUrl("https://replacement.test");
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address, "a", selected)).toThrow("another server");
	s.cache.removeRelayOnPremProvider("a");
	expect(() => s.cache.assertDocumentSourceCache(descriptor.identity, address, "a", selected)).toThrow("unavailable");
});

test.each(["session", "endpoint", "clear", "default", "removal"])("source recovery context is invalidated by %s changes", change => {
	const s = setup(), context = s.cache.captureDocumentSourceContext();
	expect(context).toMatchObject({ serverId: "a", controlPlaneUrl: "https://a.test" }); expect(() => context!.check()).not.toThrow();
	if (change === "session") s.state.token = jwt("replacement");
	if (change === "endpoint") s.a.updateControlPlaneUrl("https://replacement.test");
	if (change === "clear") s.cache.clear();
	if (change === "default") s.cache.setDefaultRelayOnPremServerId("b");
	if (change === "removal") s.cache.removeRelayOnPremProvider("a");
	expect(() => context!.check()).toThrow("changed");
	if (change === "removal") expect(s.cache.captureDocumentSourceContext("a")).toBeUndefined();
});

test("identical document IDs on two servers have independent requests, grants and callbacks", async () => {
	const { cache } = setup(), callbackA = jest.fn(), callbackB = jest.fn();
	const [a, b] = await Promise.all([cache.getToken(address, "Team/Note.md", callbackA, "a"), cache.getToken(address, "Team/Note.md", callbackB, "b")]);
	expect(a.token).toBe("a"); expect(b.token).toBe("b");
	expect(callbackA).toHaveBeenCalledWith(a); expect(callbackA).not.toHaveBeenCalledWith(b);
	expect(callbackB).toHaveBeenCalledWith(b); expect(callbackB).not.toHaveBeenCalledWith(a);
	expect(await cache.getToken(address, "Team/Note.md", callbackA, "a")).toBe(a);
	expect(await cache.getToken(address, "Team/Note.md", callbackB, "b")).toBe(b);
	expect(cache.peekToken(address, "a")).toBe(a); expect(cache.peekToken(address, "b")).toBe(b);
	expect(fetch).toHaveBeenCalledTimes(2);
});

test("same-session JWT refresh reuses a document grant; replacement sessions and endpoints do not", async () => {
	const s = setup(), read = () => s.cache.getToken(address, "Note.md", jest.fn(), "a");
	const first = await read(); s.state.token = jwt("first", 1);
	expect(await read()).toBe(first); expect(fetch).toHaveBeenCalledTimes(1);
	s.state.token = jwt("second"); expect(s.cache.peekToken(address, "a")).toBeUndefined();
	const second = await read(); expect(second).not.toBe(first);
	expect(s.cache.isDocumentGrantCurrent(first, address, "a")).toBe(false);
	expect(s.cache.isDocumentGrantCurrent(second, address, "a")).toBe(true);
	s.a.updateControlPlaneUrl("https://replacement.test");
	expect(s.cache.isDocumentGrantCurrent(second, address, "a")).toBe(false);
	expect((await read()).token).toBe("replacement"); expect(fetch).toHaveBeenCalledTimes(3);
});

test("a late old-session result cannot enter the new session's cache or callback", async () => {
	const s = setup(), wait = deferred<Response>(), sent = deferred<void>(), oldCallback = jest.fn();
	fetch.mockImplementationOnce(() => { sent.resolve(); return wait.promise; });
	const old = s.cache.getToken(address, "Note.md", oldCallback, "a"); await sent.promise;
	s.state.token = jwt("second");
	const current = await s.cache.getToken(address, "Note.md", jest.fn(), "a");
	wait.resolve(response("obsolete")); await expect(old).rejects.toThrow("changed");
	expect(oldCallback).not.toHaveBeenCalled(); expect(s.cache.peekToken(address, "a")).toBe(current);
	expect((s.cache as unknown as { tokenEntries: Map<string, unknown> }).tokenEntries.size).toBe(1);
});

test.each(["clear", "default server", "provider replacement", "mode cycle", "default cycle"])("%s while authentication waits stops the original request before transmission", async change => {
	const s = setup(), wait = deferred<string>(); s.state.wait = wait.promise;
	const old = s.cache.getToken(address, "Note.md", jest.fn()); await Promise.resolve();
	if (change === "clear") s.cache.clear();
	if (change === "default server") s.cache.setDefaultRelayOnPremServerId("b");
	if (change === "mode cycle") { s.cache.setRelayOnPremMode(false); s.cache.setRelayOnPremMode(true); }
	if (change === "default cycle") { s.cache.setDefaultRelayOnPremServerId("b"); s.cache.setDefaultRelayOnPremServerId("a"); }
	if (change === "provider replacement") s.cache.setRelayOnPremProvider("a", new RelayOnPremTokenProvider({ controlPlaneUrl: "https://replacement.test",
		authProvider: { getToken: () => s.state.token, getValidToken: async () => s.state.token } as IAuthProvider }));
	wait.resolve(s.state.token); await expect(old).rejects.toThrow(/changed|destroyed/);
	expect(fetch).not.toHaveBeenCalled();
	s.state.wait = undefined;
	expect((await s.cache.getToken(address, "Note.md", jest.fn())).token).toBe(change === "default server" ? "b" : change === "provider replacement" ? "replacement" : "a");
});

test("an explicitly selected missing server never falls back to the default server", async () => {
	const s = setup();
	await expect(s.cache.getToken(address, "Note.md", jest.fn(), "missing")).rejects.toThrow("No relay-onprem server");
	expect(fetch).not.toHaveBeenCalled();
	await s.cache.getToken(address, "Note.md", jest.fn(), "b"); s.cache.removeRelayOnPremProvider("b");
	await expect(s.cache.getToken(address, "Note.md", jest.fn(), "b")).rejects.toThrow("No relay-onprem server");
	expect(fetch).toHaveBeenCalledTimes(1);
});

test("a restore pause and credential cache cannot cross a selected generation", async () => {
	const s = setup(), original = await s.cache.getToken(address, "Note.md", jest.fn(), "a");
	const newer = await s.cache.getToken(address, "Note.md", jest.fn(), "a", { restoreGeneration: generation });
	expect(newer.restoreGeneration).toBe(generation); expect(newer).not.toBe(original);
	s.cache.markRestoreRequired(address, "a");
	await expect(s.cache.getToken(address, "Note.md", jest.fn(), "a")).rejects.toBeInstanceOf(RelayRestoreRequiredError);
	expect(await s.cache.getToken(address, "Note.md", jest.fn(), "a", { restoreGeneration: generation })).toBe(newer);
	s.cache.markRestoreRequired(address, "a", { restoreGeneration: generation.toUpperCase() });
	await expect(s.cache.getToken(address, "Note.md", jest.fn(), "a", { restoreGeneration: generation })).rejects.toBeInstanceOf(RelayRestoreRequiredError);
	expect(fetch).toHaveBeenCalledTimes(2);
});

test("a share refusal on one server does not deny the same ID on another server or session", async () => {
	const s = setup(); fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
	await expect(s.cache.getToken(address, "Note.md", jest.fn(), "a")).rejects.toThrow();
	expect(s.cache.isAccessDenied(address, "a")).toBe(true); expect(s.cache.isAccessDenied(address, "b")).toBe(false);
	expect((await s.cache.getToken(address, "Note.md", jest.fn(), "b")).token).toBe("b");
	s.cache.clearAccessDenied(address, "b"); expect(s.cache.isAccessDenied(address, "a")).toBe(true);
	s.state.token = jwt("new-session"); expect(s.cache.isAccessDenied(address, "a")).toBe(false);
	expect((await s.cache.getToken(address, "Note.md", jest.fn(), "a")).token).toBe("a");
});

test("persisted unscoped grants are not read or written as current document credentials", async () => {
	const load = jest.fn(() => ({ [address]: { token: "stale", expiryTime: Date.now() + 600_000 } })), save = jest.fn();
	const { cache } = setup({ loadLocalStorage: load, saveLocalStorage: save } as unknown as App);
	expect(cache.peekToken(address, "a")).toBeUndefined();
	expect((await cache.getToken(address, "Note.md", jest.fn(), "a")).token).toBe("a");
	expect(load).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
});

test("one token acquisition does not revalidate every unrelated cached document context", async () => {
	const s = setup();
	for (let i = 0; i < 100; i++) s.cache.isAccessDenied(ResourceAddress.serialize(new RemoteDocumentAddress("relay-onprem", share, crypto.randomUUID())), "a");
	const inspect = jest.spyOn(s.a, "getFileCredentialContext");
	await s.cache.getToken(address, "Note.md", jest.fn(), "a");
	expect(inspect.mock.calls.length).toBeLessThan(30);
});

test("a fresh cache request need not wait for authentication from an invalidated request", async () => {
	const s = setup(), wait = deferred<string>(); s.state.wait = wait.promise;
	const old = s.cache.getToken(address, "Note.md", jest.fn(), "a");
	await Promise.resolve(); s.cache.clear(); s.state.wait = undefined;
	const current = await s.cache.getToken(address, "Note.md", jest.fn(), "a");
	expect(current.token).toBe("a");
	wait.resolve(s.state.token); await expect(old).rejects.toThrow("changed");
	expect(s.cache.peekToken(address, "a")).toBe(current); expect(fetch).toHaveBeenCalledTimes(1);
});
