import "fake-indexeddb/auto";
import { admitSourceStartup, borrowPausedSourceDrain, releaseRetiredSourceHold } from "../src/storage/source-startup-admission";
import { SourceSelectionJournal } from "../src/storage/source-selection-journal";
import { SourceSelectionContext } from "../src/storage/source-selection-context";
import { trackNativeDocumentWrite } from "../src/storage/native-document-writes";
import { RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";
import { RECOVERY_FOLDER } from "../src/conflictCopyPath";

function fixture() {
	return { vault: {}, scope: { hostAppId: crypto.randomUUID(), serverId: "fixture", controlPlaneUrl: "https://fixture.test",
		s3rn: ResourceAddress.serialize(new RemoteFolderAddress("relay-onprem", crypto.randomUUID())) } };
}
const options = { check: () => {} };
const write = (vault: object, path = "Team/Note.md") => trackNativeDocumentWrite(vault, path, async () => {});
function deferred() { let finish!: () => void; return { promise: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() }; }

test("startup closes native admission synchronously and drains an earlier save before selecting a context", async () => {
	const s = fixture(), pending = deferred();
	const saving = trackNativeDocumentWrite(s.vault, "Team/Note.md", () => pending.promise);
	let opened = false; const opening = admitSourceStartup(s.vault, "Team", s.scope, options).then(context => { opened = true; return context; });
	await expect(write(s.vault)).rejects.toThrow("paused"); expect(opened).toBe(false);
	await write(s.vault, "Other/Note.md"); await write({});
	pending.finish(); await saving; const context = await opening;
	try { expect(context.choice.kind).toBe("legacy"); await write(s.vault); await context.assertCurrent(); }
	finally { context.close(); }
});

test("a pending journal leaves the native source held across module reload until a fresh reviewed state is available", async () => {
	const s = fixture(), journal = await SourceSelectionJournal.open(s.scope);
	try {
		const pending = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), reviewId: crypto.randomUUID(), expectedRevision: null, restoreGeneration: crypto.randomUUID() });
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
		await expect(write(s.vault)).rejects.toThrow("paused");
		let reloaded!: typeof admitSourceStartup;
		jest.isolateModules(() => { reloaded = require("../src/storage/source-startup-admission").admitSourceStartup; });
		await expect(reloaded(s.vault, "TEAM", s.scope, options)).rejects.toThrow("awaiting recovery");
		await journal.apply({ type: "cancel", operationId: crypto.randomUUID(), reviewId: pending.pending!.reviewId, expectedRevision: pending.revision });
		const context = await reloaded(s.vault, "Team", s.scope, options);
		try { await write(s.vault); expect(context.revision).not.toBeNull(); }
		finally { context.close(); }
	} finally { journal.close(); }
});

test.each(["cancel", "timeout"])("a %s during native draining leaves the source held and can retry after the write finishes", async mode => {
	const s = fixture(), pending = deferred(), controller = new AbortController();
	const saving = trackNativeDocumentWrite(s.vault, "Team/Note.md", () => pending.promise);
	const opening = admitSourceStartup(s.vault, "Team", s.scope, { ...options, signal: controller.signal, timeoutMs: 5 });
	if (mode === "cancel") controller.abort();
	await expect(opening).rejects.toThrow(mode === "cancel" ? "cancelled" : "still running"); await expect(write(s.vault)).rejects.toThrow("paused");
	pending.finish(); await saving; const context = await admitSourceStartup(s.vault, "Team", s.scope, options);
	try { await write(s.vault); } finally { context.close(); }
});

test("a changed caller context after journal reads closes the candidate and keeps its native hold", async () => {
	const s = fixture(); let current = true, candidate: SourceSelectionContext | undefined;
	const open = SourceSelectionContext.open, spy = jest.spyOn(SourceSelectionContext, "open").mockImplementationOnce(async scope => {
		candidate = await open(scope); current = false; return candidate;
	});
	try { await expect(admitSourceStartup(s.vault, "Team", s.scope, { check: () => { if (!current) throw new Error("account changed"); } })).rejects.toThrow("account changed"); }
	finally { spy.mockRestore(); }
	expect(candidate).toBeDefined(); expect(() => candidate!.check()).toThrow("closed");
	await expect(write(s.vault)).rejects.toThrow("paused");
	const context = await admitSourceStartup(s.vault, "Team", s.scope, options); context.close(); await write(s.vault);
});

test("another server or endpoint cannot release a held source through a different scope", async () => {
	const s = fixture(), pending = deferred(), saving = trackNativeDocumentWrite(s.vault, "Team/Note.md", () => pending.promise);
	const opening = admitSourceStartup(s.vault, "Team", s.scope, options);
	for (const scope of [{ ...s.scope, serverId: "other" }, { ...s.scope, controlPlaneUrl: "https://other.test" }]) {
		await expect(admitSourceStartup(s.vault, "Team", scope, options)).rejects.toThrow("already");
	}
	await expect(write(s.vault)).rejects.toThrow("paused"); pending.finish(); await saving;
	const context = await opening; context.close(); await write(s.vault);
});

test("concurrent admission cannot release another in-progress check, and a paused source cannot silently move", async () => {
	const s = fixture(), pending = deferred(), saving = trackNativeDocumentWrite(s.vault, "Team/Note.md", () => pending.promise);
	const opening = admitSourceStartup(s.vault, "Team", s.scope, options);
	await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("already");
	await expect(admitSourceStartup(s.vault, "Moved", s.scope, options)).rejects.toThrow("location changed");
	await expect(write(s.vault)).rejects.toThrow("paused"); pending.finish(); await saving;
	const context = await opening; context.close(); await write(s.vault);
});

test("a journal I/O failure does not fall back to legacy admission", async () => {
	const s = fixture(), spy = jest.spyOn(SourceSelectionJournal, "open").mockRejectedValueOnce(new Error("journal unavailable"));
	try { await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("unavailable"); }
	finally { spy.mockRestore(); }
	await expect(write(s.vault)).rejects.toThrow("paused");
	const context = await admitSourceStartup(s.vault, "Team", s.scope, options); context.close(); await write(s.vault);
});

async function activate(scope: ReturnType<typeof fixture>["scope"], destinationRoot?: string, beforeCommit?: () => Promise<void>) {
	const journal = await SourceSelectionJournal.open(scope), reviewId = crypto.randomUUID();
	try {
		let state = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: null, reviewId, restoreGeneration: crypto.randomUUID() });
		state = await journal.apply({ type: "prepare", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId,
			preparation: { archive: { path: `${RECOVERY_FOLDER}/fixture`, manifestSha256: "a".repeat(64) }, plan: { id: crypto.randomUUID(), sha256: "b".repeat(64) } } });
		state = await journal.apply({ type: "start", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId });
		await beforeCommit?.();
		return await journal.apply({ type: "commit", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId, ...(destinationRoot ? { destinationRoot } : {}) });
	} finally { journal.close(); }
}

test("a restored source starts only at its committed native root after reopening", async () => {
	const s = fixture(); await activate(s.scope, "Restored Team");
	const prepare = jest.fn(async (_context: SourceSelectionContext) => {});
	await expect(admitSourceStartup(s.vault, "Team", s.scope, options, prepare)).rejects.toThrow("no verified installation");
	expect(prepare).not.toHaveBeenCalled(); await expect(write(s.vault)).rejects.toThrow("paused");
	const reopenedVault = {}, context = await admitSourceStartup(reopenedVault, "Restored Team", s.scope, options, prepare);
	try {
		expect(context.nativeRoot).toBe("Restored Team"); expect(prepare).toHaveBeenCalledTimes(1);
		await write(reopenedVault, "Restored Team/Note.md");
	} finally { context.close(); }
});

test("startup after module reload retires the old hold only for the durably committed new root", async () => {
	const s = fixture();
	await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	let reloaded!: typeof admitSourceStartup;
	jest.isolateModules(() => { reloaded = require("../src/storage/source-startup-admission").admitSourceStartup; });
	await expect(reloaded(s.vault, "Unexpected", s.scope, options)).rejects.toThrow("no verified installation");
	await expect(write(s.vault)).rejects.toThrow("paused");
	const prepare = jest.fn(async (context: SourceSelectionContext) => {
		expect(context.nativeRoot).toBe("Restored Team");
		await expect(write(s.vault, "Restored Team/Note.md")).rejects.toThrow("paused");
	});
	const context = await reloaded(s.vault, "Restored Team", s.scope, options, prepare);
	try { expect(prepare).toHaveBeenCalledTimes(1); await write(s.vault); await write(s.vault, "Restored Team/Note.md"); }
	finally { context.close(); }
});

test("a preparation failure after automatic handoff preserves the destination hold for the next retry", async () => {
	const s = fixture();
	await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	await expect(admitSourceStartup(s.vault, "Restored Team", s.scope, options, async () => { throw new Error("Settings unavailable"); })).rejects.toThrow("Settings unavailable");
	await expect(write(s.vault, "Restored Team/Note.md")).rejects.toThrow("paused");
	await write(s.vault); const context = await admitSourceStartup(s.vault, "Restored Team", s.scope, options); context.close();
	await write(s.vault, "Restored Team/Note.md");
});

test("a pending or cancelled review cannot use changed settings to retire the original hold", async () => {
	const s = fixture(), journal = await SourceSelectionJournal.open(s.scope);
	try {
		const state = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), reviewId: crypto.randomUUID(), expectedRevision: null, restoreGeneration: crypto.randomUUID() });
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
		await expect(admitSourceStartup(s.vault, "Restored Team", s.scope, options)).rejects.toThrow("awaiting recovery");
		await expect(write(s.vault)).rejects.toThrow("paused");
		await journal.apply({ type: "cancel", expectedRevision: state.revision, reviewId: state.pending!.reviewId, operationId: crypto.randomUUID() });
		await expect(admitSourceStartup(s.vault, "Restored Team", s.scope, options)).rejects.toThrow("without a committed installation");
		await expect(write(s.vault)).rejects.toThrow("paused");
	} finally { journal.close(); }
});

test("a competing review between handoff reads keeps the original barrier", async () => {
	const s = fixture(); const state = await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	const open = SourceSelectionContext.open; let reads = 0;
	const spy = jest.spyOn(SourceSelectionContext, "open").mockImplementation(async scope => {
		if (++reads === 2) {
			const journal = await SourceSelectionJournal.open(scope);
			try { await journal.apply({ type: "begin", operationId: crypto.randomUUID(), reviewId: crypto.randomUUID(), expectedRevision: state.revision, restoreGeneration: crypto.randomUUID() }); }
			finally { journal.close(); }
		}
		return open(scope);
	});
	try { await expect(admitSourceStartup(s.vault, "Restored Team", s.scope, options)).rejects.toThrow("awaiting recovery"); }
	finally { spy.mockRestore(); }
	await expect(write(s.vault)).rejects.toThrow("paused");
});

test("an older preview choice without a durable native root remains held for review", async () => {
	const s = fixture(); await activate(s.scope);
	await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("no verified installation");
	await expect(write(s.vault)).rejects.toThrow("paused");
	const context = await SourceSelectionContext.open(s.scope);
	try { expect(context.choice.kind).toBe("source"); expect(context.nativeRoot).toBeUndefined(); expect(() => context.assertNativeRoot("Team")).toThrow("no verified installation"); }
	finally { context.close(); }
});

test("a borrowed paused-source drain excludes concurrent startup and releases only its lease", async () => {
	const s = fixture(), journal = await SourceSelectionJournal.open(s.scope);
	try {
		const state = await journal.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: null, reviewId: crypto.randomUUID(), restoreGeneration: crypto.randomUUID() });
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
		const lease = borrowPausedSourceDrain(s.vault, "Team", s.scope)!; expect(lease).toBeDefined();
		expect(() => borrowPausedSourceDrain(s.vault, "Team", s.scope)).toThrow("already being checked");
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("already being checked");
		await lease.wait(options); lease.release(); lease.release();
		await expect(lease.wait(options)).rejects.toThrow("lease ended"); await expect(write(s.vault)).rejects.toThrow("paused");
		await journal.apply({ type: "cancel", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: state.pending!.reviewId });
		const context = await admitSourceStartup(s.vault, "Team", s.scope, options); context.close(); await write(s.vault);
	} finally { journal.close(); }
});

test("the committed destination and revision retire only the old hold and allow its handoff", async () => {
	const s = fixture(), state = await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	const selection = { revision: state.revision!, destinationRoot: "Restored Team" };
	expect(await releaseRetiredSourceHold(s.vault, "Team", s.scope, selection, options)).toBe(true);
	expect(await releaseRetiredSourceHold(s.vault, "Team", s.scope, selection, options)).toBe(false);
	await write(s.vault); const context = await admitSourceStartup(s.vault, "Restored Team", s.scope, options); context.close();
});

test.each(["wrong revision", "wrong destination", "wrong original", "overlap", "pending review", "busy lease"])("an invalid handoff preserves the hold: %s", async kind => {
	const s = fixture(), state = await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	const selection = { revision: kind === "wrong revision" ? crypto.randomUUID() : state.revision!, destinationRoot: kind === "wrong destination" ? "Wrong" : kind === "overlap" ? "Team/Restored" : "Restored Team" };
	const lease = kind === "busy lease" ? borrowPausedSourceDrain(s.vault, "Team", s.scope) : undefined;
	if (kind === "pending review") {
		const journal = await SourceSelectionJournal.open(s.scope);
		try { await journal.apply({ type: "begin", operationId: crypto.randomUUID(), expectedRevision: state.revision, reviewId: crypto.randomUUID(), restoreGeneration: crypto.randomUUID() }); }
		finally { journal.close(); }
	}
	try { await expect(releaseRetiredSourceHold(s.vault, kind === "wrong original" ? "Unexpected" : "Team", s.scope, selection, options)).rejects.toThrow(); }
	finally { lease?.release(); }
	await expect(write(s.vault)).rejects.toThrow("paused");
});

test("a destination hold is retained until its normal startup admission succeeds", async () => {
	const s = fixture(), state = await activate(s.scope, "Restored Team", async () => {
		await expect(admitSourceStartup(s.vault, "Restored Team", s.scope, options)).rejects.toThrow("awaiting recovery");
	});
	expect(await releaseRetiredSourceHold(s.vault, "Team", s.scope, { revision: state.revision!, destinationRoot: "Restored Team" }, options)).toBe(false);
	await expect(write(s.vault, "Restored Team/Note.md")).rejects.toThrow("paused");
	const context = await admitSourceStartup(s.vault, "Restored Team", s.scope, options); context.close(); await write(s.vault, "Restored Team/Note.md");
});
