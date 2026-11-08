/** Change notifications are hints only. Receivers must read their own journal;
 * messages never select a cache, grant admission or release a native hold. */
const key = Symbol.for("team-relay.source-selection-listeners.v1");
const message = "team-relay-source-selection-changed-v1";
type Listeners = Map<string, Set<() => void>>;
function listeners(): Listeners {
	const host = window as unknown as Record<symbol, unknown>;
	if (host[key] === undefined) host[key] = new Map();
	if (!(host[key] instanceof Map)) throw new Error("Source selection notifications are unavailable. Restart Obsidian before synchronizing.");
	return host[key] as Listeners;
}
function channel(name: string): BroadcastChannel | undefined {
	if (!/^relay-selection-v1-[a-f0-9]{64}$/.test(name)) throw new Error("Invalid source selection notification scope");
	try { return typeof window.BroadcastChannel === "function" ? new window.BroadcastChannel(name) : undefined; }
	catch { return undefined; } // Same-realm notifications and durable checks remain.
}

export function watchSourceSelection(name: string, changed: () => void): () => void {
	const all = listeners(), connection = channel(name), group = all.get(name) ?? new Set<() => void>();
	let stopped = false;
	const receive = () => { if (!stopped) changed(); };
	group.add(receive); all.set(name, group);
	if (connection) {
		connection.onmessage = event => { if (event.data === message) receive(); };
		connection.onmessageerror = receive;
	}
	return () => {
		if (stopped) return;
		stopped = true; group.delete(receive); if (!group.size && all.get(name) === group) all.delete(name);
		if (connection) { connection.onmessage = null; connection.onmessageerror = null; try { connection.close(); } catch { /* Already unavailable. */ } }
	};
}

/** Called only after transaction completion, including an exact retry. Failure
 * to deliver a hint must not turn an already committed decision into failure. */
export function notifySourceSelection(name: string): void {
	try {
		for (const receive of [...(listeners().get(name) ?? [])]) {
			try { receive(); } catch { /* Other receivers must still be notified. */ }
		}
		const connection = channel(name);
		if (connection) { try { connection.postMessage(message); } finally { connection.close(); } }
	} catch { /* Durable journal checks remain the authority. */ }
}
