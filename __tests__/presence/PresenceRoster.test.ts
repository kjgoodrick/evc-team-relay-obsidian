/** @jest-environment jsdom */
import { PresenceRoster } from "../../src/collaboration/presence/PresenceRoster";
import type { PresenceController } from "../../src/collaboration/presence/PresenceController";
import type { PresencePeer } from "../../src/collaboration/presence/PresencePeers";

Object.assign(HTMLElement.prototype, { setText(this: HTMLElement, value: string) { this.textContent = value; } });
const peer = (clientId: number, sessionId: string, name = "Bob", userId = "bob"): PresencePeer => ({
	clientId, sessionId, name, userId, key: JSON.stringify([userId, sessionId, clientId]), surface: "editor",
});

test("roster groups people, distinguishes sessions, preserves keyboard focus and uses current peer actions", async () => {
	const root = document.body.appendChild(document.createElement("div")), close = jest.fn();
	const controller = { peers: [peer(1, "a".repeat(32)), peer(2, "b".repeat(32))], canLocate: () => true, navigate: jest.fn().mockResolvedValue(true) };
	const roster = new PresenceRoster(root, controller as unknown as PresenceController, close);
	try {
		roster.update(); expect(root.querySelectorAll("h4")).toHaveLength(1); expect(root.querySelectorAll("button")).toHaveLength(4);
		const jump = root.querySelector("button")!; jump.focus();
		controller.peers = [...controller.peers, peer(3, "c".repeat(32), "<b>Alice</b>", "alice")]; roster.update();
		expect(document.activeElement).toBe(jump); expect(root.querySelector("b")).toBeNull();
		expect(root.textContent).not.toContain("a".repeat(32));
		jump.click(); await Promise.resolve(); expect(controller.navigate).toHaveBeenCalledWith(controller.peers[0].key, false); expect(close).toHaveBeenCalledTimes(1);
		controller.peers = []; roster.update(); expect(root.querySelectorAll("button")).toHaveLength(0); expect(root.textContent).toContain("No other visible participants");
	} finally { root.remove(); }
});
