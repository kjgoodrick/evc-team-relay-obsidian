import "fake-indexeddb/auto";
import { admitSourceStartup } from "../src/storage/source-startup-admission";
import { SourceSelectionJournal } from "../src/storage/source-selection-journal";
import { SourceSelectionContext } from "../src/storage/source-selection-context";
import { trackNativeDocumentWrite } from "../src/storage/native-document-writes";
import { RemoteFolderAddress, ResourceAddress } from "../src/ResourceAddress";

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
