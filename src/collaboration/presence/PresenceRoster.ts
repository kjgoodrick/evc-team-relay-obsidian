import type { PresenceController } from "./PresenceController";
import type { ActivePresencePeer } from "./PresencePeers";
import { presenceColorForUser } from "../../presenceColor";

/** Keyed rows retain keyboard focus through cursor movement and peer arrivals. */
export class PresenceRoster {
	private groups = new Map<string, { root: HTMLElement; title: HTMLElement; rows: Map<string, { root: HTMLElement; label: HTMLElement; jump: HTMLButtonElement; follow: HTMLButtonElement }> }>();
	private empty: HTMLElement;
	constructor(private root: HTMLElement, private controller: PresenceController, private close: () => void) {
		this.empty = root.createEl("p", { text: "No other visible participants in this note." });
	}
	update(): void {
		this.empty.setText(`No other visible participants in this ${this.controller.surfaceName ?? "note"}.`);
		const grouped = new Map<string, ActivePresencePeer[]>();
		for (const peer of this.controller.peers) { const peers = grouped.get(peer.userId) ?? []; peers.push(peer); grouped.set(peer.userId, peers); }
		this.empty.style.display = grouped.size ? "none" : "";
		for (const [id, group] of this.groups) if (!grouped.has(id)) { group.root.remove(); this.groups.delete(id); }
		for (const [id, peers] of grouped) {
			let group = this.groups.get(id);
			if (!group) {
				const root = this.root.createDiv({ cls: "relay-presence-person" });
				group = { root, title: root.createEl("h4"), rows: new Map() }; this.groups.set(id, group);
				root.style.setProperty("--presence-person-color", presenceColorForUser({ id }).color);
			}
			group.title.setText(peers[0].name);
			for (const [key, row] of group.rows) if (!peers.some(peer => peer.key === key)) { row.root.remove(); group.rows.delete(key); }
			for (const [index, peer] of peers.entries()) {
				let row = group.rows.get(peer.key);
				if (!row) {
					const root = group.root.createDiv({ cls: "relay-presence-session" }), label = root.createSpan();
					const jump = root.createEl("button", { text: "Jump" }), follow = root.createEl("button", { text: "Follow" });
					jump.onclick = () => { void this.controller.navigate(peer.key, false).then(ok => { if (ok) this.close(); }); };
					follow.onclick = () => { void this.controller.navigate(peer.key, true).then(ok => { if (ok) this.close(); }); };
					row = { root, label, jump, follow }; group.rows.set(peer.key, row);
				}
				const label = `Session ${index + 1} · ${peer.surface === "image" ? "Viewing image" : peer.surface === "base" ? "Viewing Bases" : peer.surface === "reading" ? "Reading" : "Editing"}`;
				row.label.setText(label + (this.controller.canLocate(peer) ? "" : " · Location unavailable"));
				row.jump.setAttribute("aria-label", `Jump to ${peer.name}, ${label}`);
				row.follow.setAttribute("aria-label", `Follow ${peer.name}, ${label}`);
				row.jump.disabled = row.follow.disabled = !this.controller.canLocate(peer);
			}
		}
	}
}
