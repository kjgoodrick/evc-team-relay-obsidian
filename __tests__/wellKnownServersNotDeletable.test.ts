/**
 * Neither shipped instance may be deleted.
 *
 * DEFAULT_RELAY_ONPREM_SETTINGS is applied to a fresh install only, so a
 * removed well-known server never returns: not on restart, not on update. The
 * user would lose the way into that instance and have no way to restore it
 * short of editing data.json by hand.
 *
 * The guard used to compare against EVC_SERVER_ID alone, which left the RU
 * instance deletable while the EVC one was not.
 */

import { describe, test, expect } from "@jest/globals";
import {
	EVC_SERVER_ID,
	TR_RU_SERVER_ID,
	WELL_KNOWN_SERVER_IDS,
	isWellKnownServer,
	DEFAULT_RELAY_ONPREM_SETTINGS,
} from "../src/RelayOnPremConfig";

describe("delete guard", () => {
	test("both shipped instances are protected", () => {
		expect(isWellKnownServer(EVC_SERVER_ID)).toBe(true);
		expect(isWellKnownServer(TR_RU_SERVER_ID)).toBe(true);
	});

	test("a server the user added stays deletable", () => {
		expect(isWellKnownServer("cp-example-com-443")).toBe(false);
		expect(isWellKnownServer("")).toBe(false);
	});

	test("every server we ship by default is protected", () => {
		for (const server of DEFAULT_RELAY_ONPREM_SETTINGS.servers) {
			expect(isWellKnownServer(server.id)).toBe(true);
		}
	});

	test("the legacy protected list has no duplicates", () => {
		expect([...WELL_KNOWN_SERVER_IDS].sort()).toEqual([EVC_SERVER_ID, TR_RU_SERVER_ID].sort());
		expect(new Set(WELL_KNOWN_SERVER_IDS).size).toBe(WELL_KNOWN_SERVER_IDS.length);
	});
});
