import { RelayCredentialCache } from "../src/RelayCredentialCache";
import { RelayOnPremTokenProvider } from "../src/auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "../src/auth/IAuthProvider";
import type { AuthSession } from "../src/AuthSession";
import { RemoteFileAddress, ResourceAddress } from "../src/ResourceAddress";
import { platformFetch } from "../src/platformFetch";
import { MockClock } from "./mocks/MockClock";

jest.mock("../src/platformFetch");
jest.mock("../src/logging", () => ({ namedLogger: () => jest.fn(), Loggable: class {}, instanceLabels: { set: jest.fn() } }));
const fetch = jest.mocked(platformFetch);
const generation = "a1111111-1111-4111-8111-111111111111";
const address = ResourceAddress.serialize(new RemoteFileAddress("relay-onprem", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"));
const token = (session: string, serial = 0) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: "user", session_id: session, serial })).toString('base64url')}.signature`;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

function setup() {
	const state = { token: token("first"), wait: undefined as Promise<string> | undefined };
	const auth = { getToken: () => state.token, getValidToken: () => state.wait ?? Promise.resolve(state.token) } as IAuthProvider;
	const a = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://a.test", authProvider: auth });
	const b = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://b.test", authProvider: auth });
	const cache = new RelayCredentialCache({} as AuthSession, new MockClock(), "fixture", 5, new Map([["a", a], ["b", b]]));
	return { state, cache, a, b };
}

beforeEach(() => {
	fetch.mockReset().mockImplementation(async (url, options) => {
		const headers = options?.headers as Record<string, string>;
		return new Response(JSON.stringify({ token: "grant", base_url: String(url).replace("/file-token", "/files/id"),
			...(JSON.parse(options?.body as string).read_only === true ? { read_only: true } : {}),
			expires_at: new Date(Date.now() + 600_000).toISOString(), restore_guard: true, restore_generation: headers["X-Relay-Restore-Generation"] ?? null }));
	});
});

test("identical file requests share one credential; length, type, server and restore binding remain separate", async () => {
	const s = setup();
	const read = () => s.cache.resolveFileToken(address, "a".repeat(64), "image/png", 0, "a");
	const [one, two] = await Promise.all([read(), read()]);
	expect(one).toBe(two); expect(await read()).toBe(one); expect(fetch).toHaveBeenCalledTimes(1);
	await s.cache.resolveFileToken(address, "a".repeat(64), "image/png", 5, "a");
	await s.cache.resolveFileToken(address, "a".repeat(64), "image/jpeg", 5, "a");
	await s.cache.resolveFileToken(address, "a".repeat(64), "image/png", 5, "b");
	await s.cache.resolveFileToken(address, "a".repeat(64), "image/png", 5, "a", { restoreGeneration: generation });
	expect(fetch).toHaveBeenCalledTimes(5);
	expect(fetch.mock.calls[3][0]).toContain("https://b.test/");
	expect(fetch.mock.calls[4][1]?.headers).toMatchObject({ "X-Relay-Restore-Generation": generation });
	expect(s.cache.peekToken(address)).toBeUndefined(); // File grants never enter the document refresh queue.
	s.cache.destroy();
});

test("JWT refresh retains a session namespace; logout/relogin and explicit clear cannot reuse it", async () => {
	const s = setup(), read = () => s.cache.resolveFileToken(address, "hash", "image/png", 0, "a");
	await read(); s.state.token = token("first", 1); await read(); expect(fetch).toHaveBeenCalledTimes(1);
	s.state.token = token("second"); await read(); expect(fetch).toHaveBeenCalledTimes(2);
	s.cache.clear(); await read(); expect(fetch).toHaveBeenCalledTimes(3);
	s.cache.destroy(); await expect(read()).rejects.toThrow("closed");
});

test("credentials returning after account change are rejected and cannot poison a new account's cache", async () => {
	const s = setup(), wait = deferred<Response>();
	fetch.mockReturnValueOnce(wait.promise);
	const read = () => s.cache.resolveFileToken(address, "hash", "image/png", 0, "a");
	const old = read(); await Promise.resolve();
	s.state.token = token("second"); const current = await read();
	wait.resolve(new Response(JSON.stringify({ token: "old", base_url: "https://a.test/file", expires_at: new Date(Date.now() + 600_000).toISOString() })));
	await expect(old).rejects.toThrow("login changed");
	expect(await read()).toBe(current); expect(fetch).toHaveBeenCalledTimes(2);
	s.cache.destroy();
});

test("request binding is frozen before asynchronous authentication", async () => {
	const s = setup(), auth = deferred<string>(); s.state.wait = auth.promise;
	const binding = { restoreGeneration: generation };
	const pending = s.a.requestFileToken("relay", "folder", "file", "hash", "image/png", 10, binding);
	binding.restoreGeneration = "b1111111-1111-4111-8111-111111111111";
	auth.resolve(s.state.token); const result = await pending;
	expect(result.restoreGeneration).toBe(generation);
	expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ "X-Relay-Restore-Generation": generation });
	s.cache.destroy();
});

test("an unavailable selected file server cannot use the default provider or cloud fallback", async () => {
	const s = setup();
	await expect(s.cache.resolveFileToken(address, "hash", "image/png", 0, "missing")).rejects.toThrow("No relay-onprem server");
	expect(fetch).not.toHaveBeenCalled(); s.cache.destroy();
});

test("editing the same provider's endpoint invalidates cached and waiting file credentials", async () => {
	const s = setup(), read = () => s.cache.resolveFileToken(address, "hash", "image/png", 0, "a");
	const first = await read();
	s.a.updateControlPlaneUrl("https://replacement.test/");
	const replacement = await read(); expect(replacement).not.toBe(first);
	expect(fetch.mock.calls[1][0]).toContain("https://replacement.test/");
	s.cache.clear();
	const wait = deferred<Response>(); fetch.mockReturnValueOnce(wait.promise);
	const pending = read(); await Promise.resolve();
	s.a.updateControlPlaneUrl("https://final.test");
	wait.resolve(new Response(JSON.stringify({ token: "obsolete", base_url: "https://replacement.test/file", expires_at: new Date(Date.now() + 600_000).toISOString() })));
	await expect(pending).rejects.toThrow("server changed");
	s.cache.destroy();
});

test("clearing credentials while a request waits cannot repopulate the cache", async () => {
	const s = setup(), wait = deferred<Response>(); fetch.mockReturnValueOnce(wait.promise);
	const pending = s.cache.resolveFileToken(address, "hash", "image/png", 0, "a"); await Promise.resolve();
	s.cache.clear();
	wait.resolve(new Response(JSON.stringify({ token: "old", base_url: "https://a.test/file", expires_at: new Date(Date.now() + 600_000).toISOString() })));
	await expect(pending).rejects.toThrow("account or server changed");
	await s.cache.resolveFileToken(address, "hash", "image/png", 0, "a"); expect(fetch).toHaveBeenCalledTimes(2);
	s.cache.destroy();
});

test("inspection grants are fresh, explicitly read-only and isolated from cached sync grants", async () => {
	const s = setup(), hash = "a".repeat(64);
	const sync = await s.cache.resolveFileToken(address, hash, "image/png", 0, "a");
	const inspect = () => s.cache.requestFileInspectionToken(address, hash, "image/png", "a", {});
	const one = await inspect(), two = await inspect();
	expect(one.grant.authorization).toBe("read-only"); expect(two.grant).not.toBe(one.grant);
	expect(sync.authorization).toBe("full");
	expect(await s.cache.resolveFileToken(address, hash, "image/png", 0, "a")).toBe(sync);
	expect(fetch).toHaveBeenCalledTimes(3);
	for (const call of fetch.mock.calls.slice(1)) {
		expect(JSON.parse(call[1]?.body as string)).toMatchObject({ read_only: true, content_length: 0, sha256: hash });
		expect(call[1]?.sensitive).toBe(true);
	}
	expect(s.cache.peekToken(address)).toBeUndefined();
	s.cache.clear(); expect(one.check).toThrow("account or server changed"); s.cache.destroy();
});

test.each([
	{ read_only: undefined }, { read_only: false }, { read_only: "true" },
	{ restore_guard: false }, { restore_generation: generation },
	{ expires_at: "invalid" }, { expires_at: "2000-01-01T00:00:00Z" }, { token: "" },
])("inspection refuses unsupported or mismatched grant %j", async override => {
	const s = setup();
	fetch.mockResolvedValueOnce(new Response(JSON.stringify({ token: "grant", base_url: "https://a.test/file", read_only: true,
		expires_at: new Date(Date.now() + 600_000).toISOString(), restore_guard: true, restore_generation: null, ...override })));
	await expect(s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", {})).rejects.toThrow("read-only attachment grant");
	s.cache.destroy();
});

test("inspection cancellation during authentication prevents transmission", async () => {
	const s = setup(), auth = deferred<string>(); s.state.wait = auth.promise;
	let cancelled = false;
	const pending = s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", {}, () => {
		if (cancelled) throw new Error("Inspection cancelled");
	});
	cancelled = true; auth.resolve(s.state.token);
	await expect(pending).rejects.toThrow("Inspection cancelled");
	expect(fetch).not.toHaveBeenCalled(); s.cache.destroy();
});

test("inspection checks its context after asynchronous grant body parsing", async () => {
	const s = setup(), body = deferred<unknown>();
	fetch.mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), json: () => body.promise } as Response);
	const pending = s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", {});
	await Promise.resolve(); await Promise.resolve();
	s.state.token = token("second");
	body.resolve({ token: "obsolete", base_url: "https://a.test/file", read_only: true, restore_guard: true,
		restore_generation: null, expires_at: new Date(Date.now() + 600_000).toISOString() });
	await expect(pending).rejects.toThrow("login changed"); s.cache.destroy();
});

test("inspection retains its original generation and never redirects a missing server", async () => {
	const s = setup(), binding = { restoreGeneration: generation }, auth = deferred<string>(); s.state.wait = auth.promise;
	const pending = s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", binding);
	binding.restoreGeneration = "b1111111-1111-4111-8111-111111111111";
	auth.resolve(s.state.token);
	expect((await pending).grant.restoreGeneration).toBe(generation);
	await expect(s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "missing", {})).rejects.toThrow("available server");
	expect(fetch).toHaveBeenCalledTimes(1); s.cache.destroy();
});

test("inspection failures never expose response bodies or transport secrets", async () => {
	const s = setup(), warning = jest.spyOn(console, "warn").mockImplementation(() => {});
	for (const status of [403, 429, 500]) {
		fetch.mockResolvedValueOnce(new Response("sensitive-response-secret", { status }));
		await expect(s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", {})).rejects.not.toThrow("sensitive-response-secret");
	}
	fetch.mockRejectedValueOnce(new Error("https://private.test?token=sensitive-response-secret"));
	await expect(s.cache.requestFileInspectionToken(address, "a".repeat(64), "image/png", "a", {})).rejects.not.toThrow("sensitive-response-secret");
	expect(warning).not.toHaveBeenCalled(); warning.mockRestore(); s.cache.destroy();
});
