import { NativeOAuthHandler } from "../../src/auth/NativeOAuthHandler";
import { platformFetch } from "../../src/platformFetch";
jest.mock("../../src/platformFetch");
const fetchMock = platformFetch as jest.MockedFunction<typeof platformFetch>;
const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body }) as Response;

beforeEach(() => { jest.resetAllMocks(); });

test("browser sees only the authorize URL; completion holds the matching proof", async () => {
	fetchMock.mockResolvedValueOnce(response(200, { id: "attempt", authorize_url: "https://id.example/authorize?state=opaque", expires_in: 300, interval: 2 }));
	fetchMock.mockResolvedValueOnce(response(200, { user_id: "alice", user_email: "alice@example.com", access_token: "access", refresh_token: "refresh", expires_in: 60 }));
	const browser = jest.fn();
	const handler = new NativeOAuthHandler("https://cp.example");
	const result = await handler.completeOAuthFlow("pocket-id", browser);
	expect(browser).toHaveBeenCalledWith("https://id.example/authorize?state=opaque");
	const start = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
	const claim = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(claim.verifier));
	const expected = Buffer.from(digest).toString("base64url");
	expect(start.challenge).toBe(expected);
	expect(JSON.stringify(start)).not.toContain(claim.verifier);
	expect(result.refreshToken).toBe("refresh");
	handler.destroy();
});

test("cancellation during start never opens the browser and cancels handoff", async () => {
	const abort = new AbortController();
	fetchMock.mockImplementationOnce(async () => {
		abort.abort();
		return response(200, { id: "attempt", authorize_url: "https://id.example/authorize", expires_in: 300 });
	});
	fetchMock.mockResolvedValue(response(204, {}));
	const browser = jest.fn();
	await expect(new NativeOAuthHandler("https://cp.example").completeOAuthFlow("pocket-id", browser, abort.signal)).rejects.toThrow();
	expect(browser).not.toHaveBeenCalled();
	expect(fetchMock.mock.calls[1][0]).toBe("https://cp.example/v1/auth/native/cancel");
});

test("rejects an insecure authorization URL", async () => {
	fetchMock.mockResolvedValueOnce(response(200, { id: "attempt", authorize_url: "http://remote.example/authorize", expires_in: 300 }));
	fetchMock.mockResolvedValue(response(204, {}));
	await expect(new NativeOAuthHandler("https://cp.example").completeOAuthFlow("pocket-id", jest.fn())).rejects.toThrow("secure");
});
