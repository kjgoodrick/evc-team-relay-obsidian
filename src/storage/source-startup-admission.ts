import { holdNativeSourceWrites, type NativeSourceWriteHold, type NativeWriteWait } from "./native-document-writes";
import { sourceCacheEndpoint, sourceInventoryCacheSync } from "./source-document-cache";
import { SourceSelectionContext, type SourceSelectionScope } from "./source-selection-context";

interface StartupHold { path: string; hold: NativeSourceWriteHold; busy: boolean }
type StartupHolds = WeakMap<object, Map<string, StartupHold>>;
const key = Symbol.for("team-relay.source-startup-holds.v1");
function registry(): StartupHolds {
	const host = window as unknown as Record<symbol, unknown>;
	if (host[key] === undefined) host[key] = new WeakMap();
	if (!(host[key] instanceof WeakMap)) throw new Error("Source startup admission is unavailable. Restart Obsidian before synchronizing.");
	return host[key] as StartupHolds;
}

/** Close tracked native admission before reading a source journal. A pending,
 * corrupt, blocked or unavailable journal leaves its native hold in place.
 * A later successful read can drain and release that same hold, including after
 * a module reload in this host realm. This does not coordinate other realms or
 * continuously authorize an already-started session; startup must separately
 * stop old providers/callbacks and pass the returned context to its constructor. */
export async function admitSourceStartup(vault: object, path: string, input: SourceSelectionScope,
	options: NativeWriteWait, prepare?: (context: SourceSelectionContext) => Promise<void>): Promise<SourceSelectionContext> {
	const scope = { hostAppId: input.hostAppId, serverId: input.serverId,
		controlPlaneUrl: sourceCacheEndpoint(input.controlPlaneUrl), s3rn: input.s3rn };
	const identity = sourceInventoryCacheSync({ ...scope, restoreGeneration: null }).identity;
	const { signal, check: checkContext, timeoutMs } = options;
	const check = () => {
		if (signal?.aborted) throw Object.assign(new Error("Source startup was cancelled"), { name: "AbortError" });
		checkContext();
	};
	check();
	if (typeof path !== "string") throw new Error("Invalid source startup path");
	const all = registry(), scopes = all.get(vault) ?? new Map<string, StartupHold>(); all.set(vault, scopes);
	let entry = scopes.get(identity);
	if (entry && entry.path !== path.normalize("NFC").toLowerCase()) throw new Error("The paused source location changed. Review its original location before synchronizing.");
	if (entry?.busy) throw new Error("Source startup is already being checked. Wait before retrying.");
	if (!entry) {
		const hold = holdNativeSourceWrites(vault, path);
		entry = { path: path.normalize("NFC").toLowerCase(), hold, busy: false }; scopes.set(identity, entry);
	}
	entry.busy = true;
	let context: SourceSelectionContext | undefined;
	try {
		await entry.hold.wait({ check, signal, timeoutMs }); check();
		context = await SourceSelectionContext.open(scope); check();
		await context.assertCurrent(); check();
		if (prepare) { await prepare(context); check(); await context.assertCurrent(); check(); }
		entry.hold.release(); scopes.delete(identity);
		return context;
	} catch (error) { context?.close(); throw error; }
	finally { entry.busy = false; }
}
