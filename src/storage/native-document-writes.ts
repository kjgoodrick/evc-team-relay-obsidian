/** Track native source writes already admitted by this plugin. A context check
 * cannot cancel a Vault/adapter write once it has started. Restore inspection
 * must wait for it before reading the file it might still replace.
 *
 * A source hold fences callers of this module in this host realm only.
 * Other plugins, older binaries and other JavaScript realms are not covered. */
type Writes = WeakMap<object, Map<string, Set<Promise<void>>>>;
interface Barrier { path: string }
type Barriers = WeakMap<object, Set<Barrier>>;
export interface NativeWriteWait { check: () => void; signal?: AbortSignal; timeoutMs?: number }
export class NativeSourceWriteHeldError extends Error {
	readonly code = "native_source_write_held";
	constructor() { super("Native source writes are paused for recovery."); this.name = "NativeSourceWriteHeldError"; }
}
/** Code-based recognition also works after a plugin module reload. */
export function isNativeSourceWriteHeld(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "native_source_write_held";
}
export interface NativeSourceWriteHold {
	wait(options: NativeWriteWait): Promise<void>;
	write<T>(path: string, write: () => Promise<T>): Promise<T>;
	release(): void;
}
const key = Symbol.for("team-relay.native-document-writes.v1");
const barrierKey = Symbol.for("team-relay.native-source-write-holds.v1");
function registry(): Writes {
	// Keep admitted promises across a plugin module reload in this host realm.
	// The weak vault key does not retain a closed app/vault indefinitely.
	const host = window as unknown as Record<symbol, unknown>;
	if (host[key] === undefined) host[key] = new WeakMap();
	if (!(host[key] instanceof WeakMap)) throw new Error("Native document save tracking is unavailable. Restart Obsidian before recovery.");
	return host[key] as Writes;
}

function barriers(): Barriers {
	const host = window as unknown as Record<symbol, unknown>;
	if (host[barrierKey] === undefined) host[barrierKey] = new WeakMap();
	if (!(host[barrierKey] instanceof WeakMap)) throw new Error("Native source write holds are unavailable. Restart Obsidian before recovery.");
	return host[barrierKey] as Barriers;
}
function canonical(path: string, root = false): string {
	if (root && path === "") return "";
	if (typeof path !== "string" || !path || path.includes("\\") || /^[a-z]:/i.test(path)
		|| [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		|| path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid native source path");
	// Conservative on case-sensitive filesystems; do not miss a case/Unicode
	// alias on the common case-insensitive native vault filesystems.
	return path.normalize("NFC").toLowerCase();
}
function contains(root: string, path: string): boolean { return root === "" || path === root || path.startsWith(root + "/"); }
function intersects(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }
function pending(vault: object, matches: (path: string) => boolean): Promise<void>[] {
	return [...new Set([...(registry().get(vault) ?? [])].flatMap(([path, writes]) => matches(path) ? [...writes] : []))];
}

/** Close admission synchronously, then explicitly drain admitted writes. A
 * cancelled/timed-out drain keeps the hold; it never cancels a native operation.
 * The coordinator must separately stop untracked/older writers, validate its
 * durable journal and verify native bytes before releasing admission. */
export function holdNativeSourceWrites(vault: object, path: string): NativeSourceWriteHold {
	const root = canonical(path, true), all = barriers();
	const holds = all.get(vault) ?? new Set<Barrier>(); all.set(vault, holds);
	if ([...holds].some(hold => intersects(hold.path, root))) throw new Error("This native source already has a recovery hold.");
	const hold = { path: root }; holds.add(hold);
	const matches = (candidate: string) => intersects(root, canonical(candidate));
	const check = () => { if (!holds.has(hold)) throw new Error("The native source recovery hold was released."); };
	return {
		wait: options => {
			const checkContext = options.check;
			return waitForWrites(vault, matches, { ...options, check: () => { check(); checkContext(); } });
		},
		write: async (target, write) => {
			check();
			if (!contains(root, canonical(target))) throw new Error("Recovery write is outside its native source hold.");
			if (pending(vault, matches).length) throw new Error("A native source write is still running. Drain it before installation.");
			return trackWrite(vault, [target], write, hold);
		},
		release: () => {
			if (!holds.has(hold)) return;
			if (pending(vault, matches).length) throw new Error("A native source write is still running. Keep the recovery hold until it settles.");
			holds.delete(hold);
		},
	};
}

export async function trackNativeDocumentWrite<T>(vault: object, path: string, write: () => Promise<T>): Promise<T> {
	return trackWrite(vault, [path], write);
}
/** Register both ends of a move before calling the native API. Directory
 * operations also overlap a hold/reader for any of their descendants. */
export async function trackNativeSourceMutation<T>(vault: object, paths: readonly string[], write: () => Promise<T>): Promise<T> {
	return trackWrite(vault, paths, write);
}
async function trackWrite<T>(vault: object, affected: readonly string[], write: () => Promise<T>, owner?: Barrier): Promise<T> {
	if (!Array.isArray(affected) || !affected.length || affected.length > 64) throw new Error("Invalid native source operation paths");
	const names = [...new Set(affected)], targets = names.map(path => canonical(path));
	if ([...(barriers().get(vault) ?? [])].some(hold => hold !== owner && targets.some(target => intersects(hold.path, target)))) throw new NativeSourceWriteHeldError();
	const all = registry();
	const paths = all.get(vault) ?? new Map<string, Set<Promise<void>>>(); all.set(vault, paths);
	let finish!: () => void;
	const settled = new Promise<void>(resolve => { finish = resolve; });
	const entries = names.map(path => {
		let pending = paths.get(path); if (!pending) { pending = new Set(); paths.set(path, pending); }
		pending.add(settled); return { path, pending };
	});
	try { return await write(); }
	finally {
		for (const { path, pending } of entries) { pending.delete(settled); if (!pending.size && paths.get(path) === pending) paths.delete(path); }
		finish();
	}
}

export async function waitForNativeDocumentWrites(vault: object, path: string,
	options: NativeWriteWait): Promise<void> {
	const target = canonical(path);
	return waitForWrites(vault, candidate => intersects(canonical(candidate), target), options);
}
async function waitForWrites(vault: object, matches: (path: string) => boolean, options: NativeWriteWait): Promise<void> {
	const timeout = options.timeoutMs ?? 10_000;
	const { signal, check: checkContext } = options;
	if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid native document save wait");
	const check = () => {
		if (signal?.aborted) throw Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" });
		checkContext();
	};
	check();
	if (!pending(vault, matches).length) return;
	let timer: number | undefined;
	let abort: (() => void) | undefined;
	const interrupted = new Promise<never>((_resolve, reject) => {
		timer = window.setTimeout(() => reject(new Error("A native document save is still running. Wait before comparing this source again.")), timeout);
		abort = () => reject(Object.assign(new Error("Source comparison was cancelled"), { name: "AbortError" }));
		signal?.addEventListener("abort", abort, { once: true });
	});
	// A synchronous context check can abort and throw before the first race.
	// Observe that rejection even when no waiter reaches Promise.race.
	void interrupted.catch(() => undefined);
	try {
		while (pending(vault, matches).length) {
			check();
			await Promise.race([Promise.all(pending(vault, matches)), interrupted]);
			check();
		}
	} finally { window.clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}
