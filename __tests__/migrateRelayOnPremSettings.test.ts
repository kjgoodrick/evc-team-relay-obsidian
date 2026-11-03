import { describe, test, expect } from "@jest/globals";
import {
	migrateRelayOnPremSettings,
	DEFAULT_RELAY_ONPREM_SETTINGS,
	EVC_SERVER_ID,
	EVC_CP_URL,
	TR_RU_SERVER_ID,
} from "../src/RelayOnPremConfig";
import type { RelayOnPremServer, RelayOnPremSettings } from "../src/RelayOnPremConfig";

// Fresh fork installations have no hosted server presets. Existing servers survive.

function makeServer(overrides: Partial<RelayOnPremServer> = {}): RelayOnPremServer {
	return {
		id: "server-1",
		name: "Server 1",
		controlPlaneUrl: "https://cp.tr.entire.vc",
		isValidated: true,
		...overrides,
	};
}

function makeSettings(
	servers: RelayOnPremServer[],
	overrides: Partial<RelayOnPremSettings> = {}
): RelayOnPremSettings {
	return {
		enabled: true,
		servers,
		...overrides,
	};
}

describe("migrateRelayOnPremSettings — fresh install", () => {
	test.each([undefined, null])("starts without hosted servers or a default (%s)", old => {
		const result = migrateRelayOnPremSettings(old);
		expect(result.settings).toEqual(DEFAULT_RELAY_ONPREM_SETTINGS);
		expect(result.settings.servers).toEqual([]);
		expect(result.settings.defaultServerId).toBeUndefined();
		expect(result.changed).toBe(true);
	});
});

describe("migrateRelayOnPremSettings — established install (servers[] already present)", () => {
	test("REGRESSION: an install with only EVC configured does NOT gain the RU server", () => {
		// This is the requirement, not just "didn't break": the decision was
		// explicitly "new users only" — an established EVC-only install must
		// stay at exactly one server after migration.
		const existing = makeSettings(
			[makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL })],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers).toHaveLength(1);
		expect(result.settings.servers[0].id).toBe(EVC_SERVER_ID);
		expect(result.settings.servers.some((s) => s.id === TR_RU_SERVER_ID)).toBe(false);
	});

	test("nothing changes for an already-normalized EVC-only install (changed === false)", () => {
		const existing = makeSettings(
			[makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL })],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.changed).toBe(false);
	});

	test("a user's own custom server (unrelated id and URL) is preserved untouched", () => {
		const custom = makeServer({
			id: "my-custom-relay",
			name: "My Custom Relay",
			controlPlaneUrl: "https://relay.example.org",
			isValidated: true,
			lastUserEmail: "me@example.org",
		});
		const existing = makeSettings(
			[
				makeServer({ id: EVC_SERVER_ID, name: "EVC Team Relay", controlPlaneUrl: EVC_CP_URL }),
				custom,
			],
			{ defaultServerId: EVC_SERVER_ID }
		);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers).toHaveLength(2);
		const survived = result.settings.servers.find((s) => s.id === "my-custom-relay");
		expect(survived).toEqual(custom);
	});

	test("a custom server stays the only server and becomes the default", () => {
		const custom = makeServer({
			id: "my-custom-relay",
			name: "My Custom Relay",
			controlPlaneUrl: "https://relay.example.org",
		});
		const existing = makeSettings([custom]);
		const result = migrateRelayOnPremSettings(existing);
		expect(result.settings.servers.map((s) => s.id)).toEqual(["my-custom-relay"]);
		expect(result.settings.defaultServerId).toBe("my-custom-relay");
	});
});

describe("migrateRelayOnPremSettings — idempotency", () => {
	test("running migration on its own fresh-install output a second time makes no further changes", () => {
		const first = migrateRelayOnPremSettings(undefined);
		expect(first.changed).toBe(true);

		const second = migrateRelayOnPremSettings(first.settings);
		expect(second.changed).toBe(false);
		expect(second.settings.servers).toEqual(first.settings.servers);
		expect(second.settings.defaultServerId).toBe(first.settings.defaultServerId);
	});
});
