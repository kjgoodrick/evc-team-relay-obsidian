import { restoreGeneration } from "../collaboration/RestoreGeneration";
import { RECOVERY_FOLDER } from "../conflictCopyPath";
import { sourceInventoryCache, type SourceInventoryIdentity } from "./source-document-cache";

export type SourceChoice = { kind: "legacy" } | { kind: "source"; restoreGeneration: string | null };
export interface SourcePreparation {
	archive: { path: string; manifestSha256: string };
	plan: { id: string; sha256: string };
}
export interface PendingSourceSelection {
	reviewId: string;
	restoreGeneration: string | null;
	phase: "review" | "prepared" | "applying";
	preparation?: SourcePreparation;
}
export interface SourceSelectionState {
	version: 1;
	scopeIdentity: string;
	revision: string | null;
	active: SourceChoice;
	retired: (string | null)[];
	pending: PendingSourceSelection | null;
}
type Change = { type: "begin"; reviewId: string; restoreGeneration: string | null }
	| { type: "prepare"; reviewId: string; preparation: SourcePreparation }
	| { type: "start" | "commit" | "cancel"; reviewId: string };
export type SourceSelectionCommand = Change & { operationId: string; expectedRevision: string | null };
interface Receipt { command: string; revision: string }

const invalid = () => new Error("Invalid source selection journal. Retained work must be reviewed before synchronization.");
function uuid(value: unknown): string {
	const id = restoreGeneration(value);
	if (id === null) throw invalid();
	return id;
}
function generation(value: unknown): string | null {
	if (value === undefined) throw invalid();
	return restoreGeneration(value);
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw invalid();
	return value;
}
function preparation(value: SourcePreparation): SourcePreparation {
	const path = value?.archive?.path;
	if (typeof path !== "string" || path.length > 2048 || !path.startsWith(RECOVERY_FOLDER + "/")
		|| path.includes("\\") || path.includes(":") || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		|| path.split("/").some(part => !part || part === "." || part === "..")) throw invalid();
	return { archive: { path, manifestSha256: digest(value.archive.manifestSha256) }, plan: { id: uuid(value.plan?.id), sha256: digest(value.plan?.sha256) } };
}
function command(value: SourceSelectionCommand): SourceSelectionCommand {
	const base = { operationId: uuid(value?.operationId), expectedRevision: value?.expectedRevision === null ? null : uuid(value?.expectedRevision), reviewId: uuid(value?.reviewId) };
	switch (value.type) {
		case "begin": return { ...base, type: value.type, restoreGeneration: generation(value.restoreGeneration) };
		case "prepare": return { ...base, type: value.type, preparation: preparation(value.preparation) };
		case "start": case "commit": case "cancel": return { ...base, type: value.type };
		default: throw invalid();
	}
}
function initial(scopeIdentity: string): SourceSelectionState {
	return { version: 1, scopeIdentity, revision: null, active: { kind: "legacy" }, retired: [], pending: null };
}
function parse(value: unknown, scopeIdentity: string): SourceSelectionState {
	if (value === undefined) return initial(scopeIdentity);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
	const row = value as SourceSelectionState;
	if (row.version !== 1 || row.scopeIdentity !== scopeIdentity || !Array.isArray(row.retired) || row.retired.length > 1024) throw invalid();
	const revision = uuid(row.revision);
	const active: SourceChoice = row.active?.kind === "legacy" ? { kind: "legacy" }
		: row.active?.kind === "source" ? { kind: "source", restoreGeneration: generation(row.active.restoreGeneration) } : (() => { throw invalid(); })();
	const retired = row.retired.map(generation);
	if (new Set(retired).size !== retired.length || active.kind === "source" && retired.includes(active.restoreGeneration)) throw invalid();
	let pending: PendingSourceSelection | null = null;
	if (row.pending !== null) {
		const item = row.pending;
		if (!item || !["review", "prepared", "applying"].includes(item.phase)) throw invalid();
		pending = { reviewId: uuid(item.reviewId), restoreGeneration: generation(item.restoreGeneration), phase: item.phase };
		if (retired.includes(pending.restoreGeneration) || active.kind === "source" && pending.restoreGeneration === active.restoreGeneration) throw invalid();
		if (item.phase === "review") { if (item.preparation !== undefined) throw invalid(); }
		else pending.preparation = preparation(item.preparation!);
	}
	const parsed: SourceSelectionState = { version: 1, scopeIdentity, revision, active, retired, pending };
	// Refuse unknown or noncanonical fields instead of silently dropping future
	// schema information or treating a corrupt journal as the legacy default.
	const same = (a: unknown, b: unknown): boolean => {
		if (a === b) return true;
		if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
		const left = Object.keys(a), right = Object.keys(b);
		return left.length === right.length && left.every(key => Object.prototype.hasOwnProperty.call(b, key) && same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
	};
	if (!same(row, parsed)) throw invalid();
	return parsed;
}
function advance(current: SourceSelectionState, change: SourceSelectionCommand): SourceSelectionState {
	const next: SourceSelectionState = JSON.parse(JSON.stringify(current));
	if (change.type === "begin") {
		if (next.pending) throw new Error("A source selection is already awaiting recovery.");
		if (next.active.kind === "source" && next.retired.length >= 1024) throw new Error("Source selection history needs maintenance before another activation.");
		if (next.retired.includes(change.restoreGeneration) || next.active.kind === "source" && next.active.restoreGeneration === change.restoreGeneration) throw new Error("This source generation is already active or retired. Review the current server generation.");
		next.pending = { reviewId: change.reviewId, restoreGeneration: change.restoreGeneration, phase: "review" };
	} else {
		const pending = next.pending;
		if (!pending || pending.reviewId !== change.reviewId) throw new Error("The source review changed. Reload it before continuing.");
		switch (change.type) {
			case "prepare":
				if (pending.phase !== "review") throw new Error("This source review is already prepared.");
				pending.phase = "prepared"; pending.preparation = change.preparation; break;
			case "start":
				if (pending.phase !== "prepared") throw new Error("Prepare and verify recovery files before installing a source generation.");
				pending.phase = "applying"; break;
			case "commit":
				if (pending.phase !== "applying") throw new Error("Source installation has not started.");
				if (next.active.kind === "source") next.retired.push(next.active.restoreGeneration);
				if (next.retired.length > 1024) throw new Error("Source selection history needs maintenance before another activation.");
				next.active = { kind: "source", restoreGeneration: pending.restoreGeneration }; next.pending = null; break;
			case "cancel":
				if (pending.phase === "applying") throw new Error("Source installation may have changed native files. Recover it before synchronization.");
				next.pending = null; break;
		}
	}
	next.revision = crypto.randomUUID(); return next;
}

/** Durable selection and interruption state, not a native installation engine.
 * The caller must verify the referenced archive/plan, quiesce writers before
 * start, and verify installed native files before commit. Pending states always
 * deny ordinary source admission. A receipt never reinstates an older decision.
 * No method opens, imports, deletes or relabels an inventory/document cache. */
export class SourceSelectionJournal {
	private closed = false;
	private constructor(private db: IDBDatabase, readonly scopeIdentity: string, readonly name: string) {
		db.onversionchange = () => this.close();
	}
	static async open(scope: Omit<SourceInventoryIdentity, "restoreGeneration">): Promise<SourceSelectionJournal> {
		const descriptor = await sourceInventoryCache({ ...scope, restoreGeneration: null });
		const name = descriptor.name.replace("relay-inventory-v1-", "relay-selection-v1-");
		return new Promise((resolve, reject) => {
			let finished = false;
			const request = indexedDB.open(name, 1);
			const fail = (error: unknown) => { if (finished) return; finished = true; window.clearTimeout(timer); reject(error); };
			const timer = window.setTimeout(() => fail(new Error("Opening the source selection journal timed out.")), 5000);
			request.onblocked = () => fail(new Error("The source selection journal is blocked by another window."));
			request.onupgradeneeded = () => {
				if (finished) { request.transaction!.abort(); return; }
				request.result.createObjectStore("selection"); request.result.createObjectStore("receipts");
			};
			request.onerror = () => fail(request.error ?? invalid());
			request.onsuccess = () => {
				if (finished) { request.result.close(); return; }
				if (!request.result.objectStoreNames.contains("selection") || !request.result.objectStoreNames.contains("receipts")) { request.result.close(); fail(invalid()); return; }
				finished = true; window.clearTimeout(timer); resolve(new SourceSelectionJournal(request.result, descriptor.identity, name));
			};
		});
	}
	close(): void { this.closed = true; this.db.close(); }
	async read(): Promise<SourceSelectionState> { return this.transaction(); }
	async apply(input: SourceSelectionCommand): Promise<SourceSelectionState> {
		// Freeze/normalize the command before the first asynchronous boundary.
		return this.transaction(command(input));
	}
	async assertActive(revision: string | null, choice: SourceChoice): Promise<void> {
		const expectedRevision = revision === null ? null : uuid(revision);
		const expected: SourceChoice = choice.kind === "legacy" ? { kind: "legacy" }
			: choice.kind === "source" ? { kind: "source", restoreGeneration: generation(choice.restoreGeneration) } : (() => { throw invalid(); })();
		const state = await this.read();
		if (state.pending || state.revision !== expectedRevision || state.active.kind !== expected.kind
			|| state.active.kind === "source" && (expected.kind !== "source" || state.active.restoreGeneration !== expected.restoreGeneration)) {
			throw new Error("The source selection changed or is awaiting recovery. Synchronization remains paused.");
		}
	}
	private transaction(change?: SourceSelectionCommand): Promise<SourceSelectionState> {
		return new Promise((resolve, reject) => {
			if (this.closed) { reject(new Error("The source selection journal is closed.")); return; }
			const tx = this.db.transaction(["selection", "receipts"], change ? "readwrite" : "readonly");
			const states = tx.objectStore("selection"), receipts = tx.objectStore("receipts"), request = states.get("state");
			const historyCount = receipts.count();
			const receipt = change ? receipts.get(change.operationId) : undefined;
			let result: SourceSelectionState, failure: unknown;
			const timer = window.setTimeout(() => {
				failure = new Error("The source selection journal did not respond. Recheck the saved decision before continuing.");
				try { tx.abort(); } catch { /* A commit may already have happened; its receipt settles a retry. */ }
				reject(failure);
			}, 5000);
			const ready = () => {
				try {
					if (request.result === undefined && historyCount.result > 0) throw invalid();
					result = parse(request.result, this.scopeIdentity);
					if (!change) return;
					const text = JSON.stringify(change), accepted: Receipt | undefined = receipt!.result;
					if (accepted !== undefined) {
						if (!accepted || typeof accepted !== "object" || Object.keys(accepted).length !== 2 || typeof accepted.command !== "string" || typeof accepted.revision !== "string") throw invalid();
						if (accepted.command !== text) throw new Error("This source selection operation ID was already used for different work.");
						if (accepted.revision !== result.revision) throw new Error("This source selection receipt was superseded. Reload the current decision.");
						return;
					}
					if (change.expectedRevision !== result.revision) throw new Error("The source selection changed. Reload it before continuing.");
					result = advance(result, change);
					states.put(result, "state"); receipts.add({ command: text, revision: result.revision }, change.operationId);
				} catch (error) { failure = error; tx.abort(); }
			};
			(receipt ?? historyCount).onsuccess = ready;
			tx.oncomplete = () => { window.clearTimeout(timer); resolve(result); };
			tx.onabort = () => { window.clearTimeout(timer); reject(failure ?? tx.error ?? new Error("Saving the source selection was aborted.")); };
			tx.onerror = () => { /* Only the final transaction outcome is authoritative. */ };
		});
	}
}
