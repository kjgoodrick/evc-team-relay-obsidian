import { holdNativeSourceWrites, type NativeSourceWriteHold, type NativeWriteWait } from "./native-document-writes";
import { sourceCacheEndpoint, sourceInventoryCacheSync } from "./source-document-cache";
import { SourceSelectionContext, type SourceSelectionScope } from "./source-selection-context";
import { sourceInstallationNativeRoot } from "../SourceInstallationPlan";

interface StartupHold { path: string; hold: NativeSourceWriteHold; busy: boolean }
type StartupHolds = WeakMap<object, Map<string, StartupHold>>;
const key = Symbol.for("team-relay.source-startup-holds.v1");
function registry(): StartupHolds {
	const host = window as unknown as Record<symbol, unknown>;
	if (host[key] === undefined) host[key] = new WeakMap();
	if (!(host[key] instanceof WeakMap)) throw new Error("Source startup admission is unavailable. Restart Obsidian before synchronizing.");
	return host[key] as StartupHolds;
}

/** Let the recovery installer use an existing paused-startup hold without
 * dropping its barrier or competing for a second overlapping hold. A verified
 * plan can name its other root so recovery works after a settings handoff too.
 * Releasing this lease only ends its exclusive use; the source remains paused. */
export function borrowPausedSourceHold(vault: object, path: string, scope: SourceSelectionScope,
	alternativeRoot?: string): NativeSourceWriteHold | undefined {
	const identity = sourceInventoryCacheSync({ ...scope, restoreGeneration: null }).identity;
	const entry = registry().get(vault)?.get(identity);
	if (!entry) return undefined;
	if (entry.path !== path.normalize("NFC").toLowerCase()) {
		if (alternativeRoot !== undefined && entry.path === alternativeRoot.normalize("NFC").toLowerCase()) return undefined;
		throw new Error("The paused source location changed. Review its original location before installation.");
	}
	if (entry.busy) throw new Error("The paused source is already being checked. Wait before installing it.");
	entry.busy = true; let released = false, waiting = 0;
	const check = () => { if (released || registry().get(vault)?.get(identity) !== entry) throw new Error("The paused-source recovery lease ended"); };
	return {
		wait: async options => {
			check(); waiting++; const checkContext = options.check;
			try { await entry.hold.wait({ ...options, check: () => { check(); checkContext(); } }); }
			finally { waiting--; }
		},
		write: async (target, action) => {
			check(); waiting++;
			try { return await entry.hold.write(target, () => { check(); return action(); }); }
			finally { waiting--; }
		},
		release: () => {
			if (released) return;
			if (waiting) throw new Error("The paused-source operation has not settled");
			check(); released = true; entry.busy = false;
		},
	};
}

export function borrowPausedSourceDrain(vault: object, path: string, scope: SourceSelectionScope): Pick<NativeSourceWriteHold, "wait" | "release"> | undefined {
	const hold = borrowPausedSourceHold(vault, path, scope);
	return hold ? { wait: hold.wait, release: hold.release } : undefined;
}

/** After verified activation, retire only the original location's startup hold.
 * A hold already at the selected destination remains for ordinary admission.
 * This verifies the durable decision, not native/cache/server readiness; the
 * activation coordinator must have established those before committing it. */
export async function releaseRetiredSourceHold(vault: object, originalRoot: string, input: SourceSelectionScope,
	selected: { revision: string; destinationRoot: string }, options: NativeWriteWait): Promise<boolean> {
	const oldRoot = sourceInstallationNativeRoot(originalRoot), destination = sourceInstallationNativeRoot(selected.destinationRoot), revision = selected.revision;
	const oldKey = oldRoot.normalize("NFC").toLowerCase(), newKey = destination.normalize("NFC").toLowerCase();
	if (oldKey === newKey || oldKey.startsWith(newKey + "/") || newKey.startsWith(oldKey + "/")) throw new Error("The retired and selected source locations overlap");
	const scope = { hostAppId: input.hostAppId, serverId: input.serverId, controlPlaneUrl: sourceCacheEndpoint(input.controlPlaneUrl), s3rn: input.s3rn };
	const identity = sourceInventoryCacheSync({ ...scope, restoreGeneration: null }).identity, scopes = registry().get(vault), entry = scopes?.get(identity);
	const checkContext = options.check, signal = options.signal, timeoutMs = options.timeoutMs;
	const check = () => { if (signal?.aborted) throw Object.assign(new Error("Source handoff was cancelled"), { name: "AbortError" }); checkContext(); };
	check();
	if (entry && ![oldKey, newKey].includes(entry.path)) throw new Error("The paused source location changed before handoff");
	const retiring = entry?.path === oldKey ? entry : undefined;
	if (retiring?.busy) throw new Error("The original source hold is still in use");
	if (retiring) retiring.busy = true;
	let context: SourceSelectionContext | undefined;
	try {
		if (retiring) await retiring.hold.wait({ check, signal, timeoutMs });
		check(); context = await SourceSelectionContext.open(scope); check();
		if (context.choice.kind !== "source" || context.revision !== revision) throw new Error("The committed source decision changed before handoff");
		context.assertNativeRoot(destination); await context.assertCurrent(); check();
		if (!retiring) return false;
		if (scopes?.get(identity) !== retiring) throw new Error("The paused source hold changed before handoff");
		retiring.hold.release(); scopes!.delete(identity); return true;
	} finally { if (retiring) retiring.busy = false; context?.close(); }
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
	if (entry && entry.path !== path.normalize("NFC").toLowerCase()) {
		// Mapping may have committed before a reload lost the recovery UI's
		// in-memory handoff. Settings alone never authorize this path change:
		// require the durable selected root, then reread its exact revision in
		// the retirement helper. Pending/legacy/unbound decisions stay held.
		if (entry.busy) throw new Error("The paused source location changed while its hold is in use. Wait before synchronizing.");
		const previousPath = entry.path;
		let selected: SourceSelectionContext | undefined;
		try {
			check(); selected = await SourceSelectionContext.open(scope); check();
			if (selected.choice.kind !== "source") throw new Error("The paused source location changed without a committed installation");
			selected.assertNativeRoot(path); await selected.assertCurrent(); check();
			await releaseRetiredSourceHold(vault, previousPath, scope, { revision: selected.revision!, destinationRoot: path }, { check, signal, timeoutMs });
		} finally { selected?.close(); }
		// This immediately closes destination admission and drains any writes
		// admitted before startup. A failed read leaves that new hold in place.
		return admitSourceStartup(vault, path, scope, { check, signal, timeoutMs }, prepare);
	}
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
		await context.assertCurrent(); context.assertNativeRoot(path); check();
		if (prepare) { await prepare(context); check(); await context.assertCurrent(); check(); }
		entry.hold.release(); scopes.delete(identity);
		return context;
	} catch (error) { context?.close(); throw error; }
	finally { entry.busy = false; }
}
