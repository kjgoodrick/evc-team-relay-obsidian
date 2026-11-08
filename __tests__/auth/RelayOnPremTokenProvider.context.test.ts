import { RelayOnPremTokenProvider, TokenRequestThrottle, RelayRestoreRequiredError } from "../../src/auth/RelayOnPremTokenProvider";
import type { IAuthProvider } from "../../src/auth/IAuthProvider";
import { platformFetch } from "../../src/platformFetch";

jest.mock("../../src/platformFetch");
jest.mock("../../src/logging", () => ({ namedLogger: () => jest.fn(), Loggable: class {}, instanceLabels: { set: jest.fn() } }));
const fetch = jest.mocked(platformFetch);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const jwt = (session: string, serial = 0) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: "fixture-user", session_id: session, serial })).toString('base64url')}.signature`;
const data = () => ({ token: "grant", relay_url: "ws://fixture/relay", base_url: "https://fixture/file", expires_at: new Date(Date.now() + 600000).toISOString() });
const providers: RelayOnPremTokenProvider[] = [];
function setup() {
	const state = { token: jwt("first"), auth: undefined as Promise<string> | undefined };
	const provider = new RelayOnPremTokenProvider({ controlPlaneUrl: "https://first.test", authProvider: {
		getToken: () => state.token, getValidToken: () => state.auth ?? Promise.resolve(state.token),
	} as IAuthProvider }); providers.push(provider);
	const request = (kind: string) => kind === "file" ? provider.requestFileToken("relay", "share", "file", "hash", "image/png", 10)
		: provider.requestToken("relay", "share", "document", "write");
	const change = (kind: string) => {
		if (kind === "account") state.token = jwt("second");
		if (kind === "server") provider.updateControlPlaneUrl("https://second.test");
		if (kind === "destroy") provider.destroy();
	};
	return { state, provider, request, change };
}
beforeEach(() => fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify(data()))));
afterEach(() => { for (const provider of providers.splice(0)) provider.destroy(); jest.restoreAllMocks(); });

test.each(["document", "file"].flatMap(kind => ["account", "server", "destroy"].map(change => [kind, change])))("%s auth wait cannot transmit credentials after %s changes", async (kind, change) => {
	const s = setup(), wait = deferred<string>(); s.state.auth = wait.promise;
	const old = s.request(kind); s.change(change); wait.resolve(s.state.token);
	await expect(old).rejects.toThrow(/changed/); expect(fetch).not.toHaveBeenCalled();
});

test.each(["account", "server", "destroy"])("document throttle wait is fenced after %s changes", async change => {
	const s = setup(), slot = deferred<void>(), entered = deferred<void>();
	jest.spyOn(TokenRequestThrottle.prototype, "acquire").mockImplementationOnce(() => { entered.resolve(); return slot.promise; });
	const old = s.request("document"); await entered.promise;
	s.change(change); slot.resolve();
	await expect(old).rejects.toThrow(/changed/); expect(fetch).not.toHaveBeenCalled();
});

test.each(["document", "file"].flatMap(kind => ["account", "server", "destroy"].map(change => [kind, change])))("late %s response after %s changes is not returned as a usable grant", async (kind, change) => {
	const s = setup(), wait = deferred<Response>(), sent = deferred<void>();
	fetch.mockImplementationOnce(() => { sent.resolve(); return wait.promise; });
	const old = s.request(kind); await sent.promise;
	s.change(change); wait.resolve(new Response(JSON.stringify(data())));
	await expect(old).rejects.toThrow(/changed/);
	expect(fetch.mock.calls[0][0]).toContain("https://first.test/");
	expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(["document", "file"])("%s validates its context after parsing a delayed response body", async kind => {
	const s = setup(), body = deferred<ReturnType<typeof data>>(), parsing = deferred<void>();
	const response = new Response(null); response.json = () => { parsing.resolve(); return body.promise; };
	fetch.mockResolvedValueOnce(response);
	const old = s.request(kind); await parsing.promise;
	s.change("account"); body.resolve(data());
	await expect(old).rejects.toThrow(/changed/);
});

test.each(["document", "file"])("%s routine JWT refresh in the same session keeps the request valid", async kind => {
	const s = setup(), wait = deferred<string>(); s.state.auth = wait.promise;
	const context = s.provider.getFileCredentialContext(), pending = s.request(kind);
	s.state.token = jwt("first", 1); wait.resolve(s.state.token);
	expect((await pending).token).toBe("grant"); expect(s.provider.getFileCredentialContext()).toBe(context);
	expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${s.state.token}` });
});

test("changing a URL away and back still invalidates the waiting request; cosmetic normalization does not", async () => {
	const s = setup(), wait = deferred<string>(); s.state.auth = wait.promise;
	const old = s.request("document");
	s.provider.updateControlPlaneUrl("https://second.test"); s.provider.updateControlPlaneUrl("https://first.test");
	wait.resolve(s.state.token); await expect(old).rejects.toThrow(/changed/); expect(fetch).not.toHaveBeenCalled();
	const context = s.provider.getFileCredentialContext(); s.provider.updateControlPlaneUrl("https://first.test/");
	expect(s.provider.getFileCredentialContext()).toBe(context);
	expect((await s.request("document")).token).toBe("grant");
});

test("an old write refusal cannot start a read fallback under a replacement account", async () => {
	const s = setup(), wait = deferred<Response>(), sent = deferred<void>();
	fetch.mockImplementationOnce(() => { sent.resolve(); return wait.promise; });
	const old = s.request("document"); await sent.promise;
	s.change("account"); wait.resolve(new Response(null, { status: 403 }));
	await expect(old).rejects.toThrow(/changed/); expect(fetch).toHaveBeenCalledTimes(1);
	await s.request("document"); expect(JSON.parse(fetch.mock.calls[1][1]?.body as string).mode).toBe("write");
});

test("a restore rejection parsed after an account change does not pause the replacement account", async () => {
	const s = setup(), body = deferred<string>(), parsing = deferred<void>();
	const response = new Response(null, { status: 409 }); response.text = () => { parsing.resolve(); return body.promise; };
	fetch.mockResolvedValueOnce(response);
	const old = s.request("document"); await parsing.promise;
	s.change("account"); body.resolve(JSON.stringify({ detail: { code: "restore_generation_changed" } }));
	await expect(old).rejects.not.toBeInstanceOf(RelayRestoreRequiredError);
});

test("destroyed providers cannot make new document or file requests", async () => {
	const s = setup(); s.provider.destroy();
	await expect(s.request("document")).rejects.toThrow("destroyed");
	await expect(s.request("file")).rejects.toThrow("destroyed"); expect(fetch).not.toHaveBeenCalled();
});
