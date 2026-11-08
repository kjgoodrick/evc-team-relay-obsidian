import { deepValueEquals } from "./deepValueEquals";

export interface CanvasNativeSyncHost {
	/** Undefined means confirmed absent; a failed read must reject. */
	readNative(): Promise<string | undefined>;
	readBase(): Promise<string | undefined>;
	remote(): string;
	check(): void;
	preserve(local: string): Promise<void>;
	writeNative(remote: string): Promise<void>;
	writeBase(remote: string): Promise<void>;
}

function sameCanvas(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	try {
		const a: unknown = JSON.parse(left), b: unknown = JSON.parse(right);
		return !!a && typeof a === "object" && "nodes" in a && "edges" in a
			&& Array.isArray(a.nodes) && Array.isArray(a.edges) && deepValueEquals(a, b);
	} catch { return false; }
}

/** Deliver a synchronized Canvas without silently discarding native edits.
 * The base describes bytes delivered to this client, not the latest CRDT state.
 * Older clients with no base preserve a divergent file once before adopting it.
 * No native compare-and-write API exists; rechecks bound the host write window. */
export async function deliverCanvasNative(host: CanvasNativeSyncHost): Promise<"unchanged" | "written" | "deferred"> {
	host.check(); const base = await host.readBase(); host.check();
	const local = await host.readNative(); host.check();
	const remote = host.remote();
	if (!sameCanvas(remote, remote)) throw new Error("The synchronized Canvas is not valid JSON");
	if (sameCanvas(local, remote)) {
		if (!sameCanvas(base, remote)) { await host.writeBase(remote); host.check(); }
		return "unchanged";
	}
	if (local !== undefined && !sameCanvas(local, base)) {
		await host.preserve(local); host.check();
	}
	// Compare bytes here, including formatting edits made during preservation.
	const current = await host.readNative(); host.check();
	if (current !== local) return "deferred";
	await host.writeNative(remote); host.check();
	await host.writeBase(remote); host.check();
	return "written";
}
