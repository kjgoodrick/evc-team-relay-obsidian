/**
 * Tests for MultiServerAuthManager
 *
 * Focused on does the onSessionExpired callback this manager forwards
 * to each RelayOnPremAuthProvider actually thread the correct serverId back
 * to the caller — the classic closure-in-a-loop footgun (addServer() is
 * called once per server; the callback must close over THAT server's id,
 * not whichever id the loop variable landed on last).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { MultiServerAuthManager } from "../../src/auth/MultiServerAuthManager";
import type { RelayOnPremServer } from "../../src/RelayOnPremConfig";

jest.mock("../../src/logging", () => ({
	namedLogger: () => jest.fn(),
	Loggable: class Loggable {
		protected debug = jest.fn();
		protected log = jest.fn();
		protected warn = jest.fn();
		protected error = jest.fn();
	},
}));

jest.mock("../../src/platformFetch");
import { platformFetch } from "../../src/platformFetch";
import { createAuthStorageShim } from "../mocks/authStorageShim";
const mockFetch = platformFetch as jest.MockedFunction<typeof platformFetch>;

jest.mock("../../src/auth/NativeOAuthHandler");

const mockStorage = createAuthStorageShim("test-app-id");

function mockFetchResponse(status: number, data: unknown, ok = true) {
	return Promise.resolve({
		ok: ok !== false && status < 400,
		status,
		text: async () => JSON.stringify(data),
		json: async () => data,
		arrayBuffer: new ArrayBuffer(0),
		headers: new Headers(),
	} as Response);
}

const APP_ID = "test-app-id";

function makeServer(id: string): RelayOnPremServer {
	return {
		id,
		name: `Server ${id}`,
		controlPlaneUrl: `https://${id}.example.com`,
		isValidated: false,
	};
}

function seedAuth(serverId: string) {
	mockStorage.set(
		`evc-team-relay_onprem_auth_${APP_ID}_${serverId}`,
		JSON.stringify({
			user: { id: `user-${serverId}`, email: `${serverId}@example.com` },
			token: "token",
			expiresAt: Date.now() + 3600000,
			refreshToken: "refresh_token",
		}),
	);
}

describe("MultiServerAuthManager", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockStorage.clear();
	});

	test("onSessionExpired receives the correct serverId, not the last-added one", async () => {
		seedAuth("server-a");
		seedAuth("server-b");

		const onSessionExpired = jest.fn();
		const manager = new MultiServerAuthManager(
			APP_ID,
			[makeServer("server-a"), makeServer("server-b")],
			onSessionExpired,
		);
		await manager.waitForAllRestore();

		mockFetch.mockResolvedValue(
			await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
		);

		const providerA = manager.getProvider("server-a");
		expect(providerA).toBeDefined();
		await expect(providerA!.refreshToken()).rejects.toThrow();

		expect(onSessionExpired).toHaveBeenCalledTimes(1);
		expect(onSessionExpired).toHaveBeenCalledWith("server-a");
	});

	test("each server's expiry is reported independently", async () => {
		seedAuth("server-a");
		seedAuth("server-b");

		const onSessionExpired = jest.fn();
		const manager = new MultiServerAuthManager(
			APP_ID,
			[makeServer("server-a"), makeServer("server-b")],
			onSessionExpired,
		);
		await manager.waitForAllRestore();

		mockFetch.mockResolvedValue(
			await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
		);

		const providerB = manager.getProvider("server-b");
		await expect(providerB!.refreshToken()).rejects.toThrow();

		expect(onSessionExpired).toHaveBeenCalledTimes(1);
		expect(onSessionExpired).toHaveBeenCalledWith("server-b");
	});

	test("addServer() added after construction still wires the callback", async () => {
		const onSessionExpired = jest.fn();
		const manager = new MultiServerAuthManager(APP_ID, [], onSessionExpired);

		seedAuth("server-late");
		manager.addServer(makeServer("server-late"));
		await manager.waitForAllRestore();

		mockFetch.mockResolvedValue(
			await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
		);

		const provider = manager.getProvider("server-late");
		await expect(provider!.refreshToken()).rejects.toThrow();

		expect(onSessionExpired).toHaveBeenCalledWith("server-late");
	});

	test("works with no onSessionExpired callback provided (optional)", async () => {
		seedAuth("server-a");
		const manager = new MultiServerAuthManager(APP_ID, [makeServer("server-a")]);
		await manager.waitForAllRestore();

		mockFetch.mockResolvedValue(
			await mockFetchResponse(401, { error: "Invalid refresh token" }, false),
		);

		const provider = manager.getProvider("server-a");
		// Must not throw due to a missing callback (optional-chaining call).
		await expect(provider!.refreshToken()).rejects.toThrow();
	});
});
