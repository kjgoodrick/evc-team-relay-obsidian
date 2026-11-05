export interface PresenceColor {
	readonly color: string;
	readonly light: string;
}

export const presencePalette: readonly PresenceColor[] = [
	"#30bced", "#6eeb83", "#ffbc42", "#ecd444",
	"#ee6352", "#9ac2c9", "#8acb88", "#1be7ff",
].map((color) => ({ color, light: color + "33" }));

/**
 * Identity, rather than a Yjs client/document or a newly restored Account,
 * determines the color. Resolve on receipt too: older peers advertise a new
 * random color in each note. No storage or cross-document state is needed.
 */
export function presenceColorForUser(user: {
	id?: unknown;
	color?: string;
	colorLight?: string;
}): PresenceColor {
	if (typeof user.id === "string" && user.id.length > 0) {
		// FNV-1a over UTF-16 code units; deterministic on desktop and mobile.
		let hash = 0x811c9dc5;
		for (let i = 0; i < user.id.length; i++) {
			hash = Math.imul(hash ^ user.id.charCodeAt(i), 0x01000193);
		}
		return presencePalette[(hash >>> 0) % presencePalette.length];
	}
	// Legacy anonymous cursors have no identity to match across notes.
	const color = user.color || presencePalette[0].color;
	return { color, light: user.colorLight || color + "33" };
}
