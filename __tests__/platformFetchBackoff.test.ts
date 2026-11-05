import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { requestUrl } from "obsidian";
import { platformFetch } from "../src/platformFetch";
import { setVerboseLogging } from "../src/logging";
import { RelayHttpError, isTransientRelayFailure } from "../src/relayRequestErrors";
import { FeatureToggleState } from "../src/featureToggleState";

const request = requestUrl as jest.MockedFunction<typeof requestUrl>;
function response(status: number) {
	return { status, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "unavailable", json: {} };
}

describe("transient request backoff", () => {
	beforeEach(() => { jest.useFakeTimers(); request.mockReset(); });
	afterEach(() => { jest.useRealTimers(); });

	test.each([500, 502, 503, 504])("delays GET retry after HTTP %i", async (status) => {
		request.mockResolvedValueOnce(response(status)).mockResolvedValueOnce(response(200));
		const pending = platformFetch("https://relay.example/v1/shares/x");
		await jest.advanceTimersByTimeAsync(799);
		expect(request).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(401);
		expect((await pending).status).toBe(200);
		expect(request).toHaveBeenCalledTimes(2);
	});

	test("a persistent timeout has at most three separated attempts", async () => {
		request.mockRejectedValue(new Error("Request timed out"));
		const pending = platformFetch("https://relay.example/v1/shares/x");
		await jest.advanceTimersByTimeAsync(799);
		expect(request).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(5000);
		expect((await pending).status).toBe(503);
		expect(request).toHaveBeenCalledTimes(3);
	});

	test.each(["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET"])("retries a transport failure reported only by %s", async (code) => {
		request.mockRejectedValueOnce(Object.assign(new Error("Socket failed"), { code }))
			.mockResolvedValueOnce(response(200));
		const pending = platformFetch("https://relay.example/v1/shares/x").catch((error: unknown) => error);
		await jest.advanceTimersByTimeAsync(1200);
		expect(await pending).toMatchObject({ status: 200 });
		expect(request).toHaveBeenCalledTimes(2);
	});

	test("recognizes code-only errors without broadening unrelated failures", () => {
		expect(isTransientRelayFailure({ code: "ETIMEDOUT" })).toBe(true);
		expect(isTransientRelayFailure(new RelayHttpError(429, "Too Many Requests"))).toBe(true);
		expect(isTransientRelayFailure(Object.assign(new Error("Invalid input"), { code: "EINVAL" }))).toBe(false);
		expect(isTransientRelayFailure(new Error("Invalid input"))).toBe(false);
	});

	test("retry warnings omit signed credentials from URLs and transport errors", async () => {
		const warning = jest.spyOn(console, "debug").mockImplementation(() => {});
		setVerboseLogging(true);
		try {
			const signedUrl = "https://relay.example/files/content?token=synthetic-credential";
			request.mockRejectedValueOnce(new Error(`Request timed out: ${signedUrl}`))
				.mockResolvedValueOnce(response(200));
			const pending = platformFetch(signedUrl);
			await jest.advanceTimersByTimeAsync(1200);
			expect((await pending).status).toBe(200);
			expect(warning).toHaveBeenCalled();
			expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-credential");
		} finally {
			setVerboseLogging(false);
			warning.mockRestore();
		}
	});

	test.each(["POST", "PUT", "PATCH", "DELETE"])("does not retry %s after 503", async (method) => {
		request.mockResolvedValue(response(503));
		await expect(platformFetch("https://relay.example/v1/shares/x", { method })).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("does not retry an authorization failure", async () => {
		request.mockResolvedValue(response(403));
		expect((await platformFetch("https://relay.example/v1/shares/x")).status).toBe(403);
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("sensitive requests omit response bodies and cursor URLs even with network logging enabled", async () => {
		const log = jest.spyOn(console, "debug").mockImplementation(() => {});
		const state = FeatureToggleState.getShared(), original = state.currentToggles;
		state.currentToggles = { ...original, enableNetworkLogging: true }; setVerboseLogging(true);
		try {
			request.mockResolvedValue({ ...response(503), text: "private-comment", headers: { "retry-after": "60" } });
			await expect(platformFetch("https://relay.example/changes?cursor=private-cursor", { method: "POST", sensitive: true }))
				.rejects.toMatchObject({ message: "Relay request failed", retryAfterMs: 60000 });
			expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-comment|private-cursor/);
		} finally { state.currentToggles = original; setVerboseLogging(false); log.mockRestore(); }
	});
});
