/** Track native text writes already admitted by this plugin. A context check
 * cannot cancel a Vault/adapter write once it has started. Restore inspection
 * must wait for it before reading the file it might still replace.
 *
 * This is not an activation barrier: callers must separately stop new writers.
 * Other plugins, older binaries and other JavaScript realms are not covered. */
type Writes = WeakMap<object, Map<string, Set<Promise<void>>>>;
const key = Symbol.for("team-relay.native-document-writes.v1");
function registry(): Writes {
	// Keep admitted promises across a plugin module reload in this host realm.
	// The weak vault key does not retain a closed app/vault indefinitely.
	const host = window as unknown as Record<symbol, unknown>;
	if (host[key] === undefined) host[key] = new WeakMap();
	if (!(host[key] instanceof WeakMap)) throw new Error("Native document save tracking is unavailable. Restart Obsidian before recovery.");
	return host[key] as Writes;
}

export async function trackNativeDocumentWrite<T>(vault: object, path: string, write: () => Promise<T>): Promise<T> {
	const all = registry();
	let paths = all.get(vault); if (!paths) { paths = new Map(); all.set(vault, paths); }
	let pending = paths.get(path); if (!pending) { pending = new Set(); paths.set(path, pending); }
	let finish!: () => void;
	const settled = new Promise<void>(resolve => { finish = resolve; });
	pending.add(settled);
	try { return await write(); }
	finally { pending.delete(settled); if (!pending.size && paths.get(path) === pending) paths.delete(path); finish(); }
}

export async function waitForNativeDocumentWrites(vault: object, path: string,
	options: { check: () => void; signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
	const timeout = options.timeoutMs ?? 10_000;
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid native document save wait");
	const check = () => {
		if (options.signal?.aborted) throw Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" });
		options.check();
	};
	check();
	const all = registry();
	if (!all.get(vault)?.get(path)?.size) return;
	let timer: number | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		timer = window.setTimeout(() => reject(new Error("A native document save is still running. Wait before comparing this source again.")), timeout);
		abort = () => reject(Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" }));
		options.signal?.addEventListener("abort", abort, { once: true });
	});
	// A synchronous context check can abort and throw before the first race.
	// Observe that rejection even when no waiter reaches Promise.race.
	void interrupted.catch(() => undefined);
	try {
		while (all.get(vault)?.get(path)?.size) {
			check();
			await Promise.race([Promise.all([...all.get(vault)!.get(path)!]), interrupted]);
			check();
		}
	} finally { window.clearTimeout(timer); if (abort) options.signal?.removeEventListener("abort", abort); }
}
