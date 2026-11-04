/** Awareness is peer supplied. Never load file, script, data or credential URLs. */
export function safeAvatarUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
		if (url.username || url.password) return undefined;
		return url.href;
	} catch { return undefined; }
}
