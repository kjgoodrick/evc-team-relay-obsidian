import * as Y from "yjs";
import { ManagedIndexTransport, type ManagedManifest } from "../../src/client/ManagedIndexTransport";
import { platformFetch } from "../../src/platformFetch";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
import type { BaseContentState } from "../../src/bases/BaseContentProtocol";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const fetchMock = platformFetch as jest.MockedFunction<typeof platformFetch>;
const response = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) }) as Response;
const note = (id: string): ItemRecord => ({ id, type: ItemKind.Document, version: 0 });
const empty = (): ManagedManifest => ({ records: {}, permissions: {}, activity: {}, owner: true });
const transports: ManagedIndexTransport[] = [];
const documents: Y.Doc[] = [];
function setup(bytes?: Uint8Array, credentials = () => ({ endpoint: "https://cp.test/v1/managed/index/share", token: "grant" })) {
	const doc = new Y.Doc(); documents.push(doc);
	if (bytes) Y.applyUpdate(doc, bytes);
	const failed = jest.fn();
	const transport = new ManagedIndexTransport(doc, credentials, jest.fn(), failed);
	transports.push(transport);
	return { doc, transport, failed, records: doc.getMap<ItemRecord>("filemeta_v0") };
}
beforeEach(() => jest.resetAllMocks());
afterEach(() => { transports.splice(0).forEach(t => t.destroy()); documents.splice(0).forEach(d => d.destroy()); });

const baseId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const restored = (snapshot = empty(), generation = baseId(80)): ManagedManifest => ({ ...snapshot, restore_guard: true, restore_generation: generation });

function pausedInspection(credentials?: () => { endpoint: string; token: string }) {
	const s = setup(undefined, credentials), before = { ...empty(), records: { "Old.md": note("one") } };
	s.doc.getMap("managed_base_v1").set("snapshot", before);
	s.records.set("Local.md", note("one"));
	s.doc.getMap("managed_base_v1").set("restoreReview", { id: "review", createdAt: "2026-11-08T00:00:00Z", before, observed: restored(before), local: s.records.toJSON(), activity: {} });
	return s;
}

test("restore inspection reads current visible inventory without applying it or reopening queued work", async () => {
	const s = pausedInspection(), before = Y.encodeStateAsUpdate(s.doc);
	const latest = restored({ ...empty(), records: { "Current.md": note("one"), "Added.md": note("two") } }, baseId(81));
	fetchMock.mockResolvedValueOnce(response(200, latest));
	expect(await s.transport.inspectRestore()).toMatchObject({ reviewId: "review", local: { "Local.md": note("one") }, server: latest });
	expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(["GET"]);
	expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before); expect(s.transport.owner).toBe(false);
	expect(s.transport.permissions).toEqual({}); expect(s.transport.isBlocked("Current.md")).toBe(true);
	await expect(s.transport.flush()).rejects.toThrow("restored"); expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each(["local edit", "review", "stop", "destroy", "endpoint", "token", "external context"])("restore inspection discards a late response after %s changes", async change => {
	const credentials = { endpoint: "https://cp.test/v1/managed/index/share", token: "grant" }, s = pausedInspection(() => ({ ...credentials }));
	let finish!: (response: Response) => void, invalidated = false;
	fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = s.transport.inspectRestore(() => { if (invalidated) throw new Error("changed"); });
	if (change === "local edit") s.records.set("Later.md", note("later"));
	if (change === "review") s.doc.getMap("managed_base_v1").set("restoreReview", { ...s.transport.restoreReview, id: "later" });
	if (change === "stop") s.transport.stop();
	if (change === "destroy") s.transport.destroy();
	if (change === "endpoint") credentials.endpoint = "https://replacement.test";
	if (change === "token") credentials.token = "different-account";
	if (change === "external context") invalidated = true;
	finish(response(200, restored())); await expect(pending).rejects.toThrow("changed");
	expect(s.records.get("Local.md")).toEqual(note("one"));
});

test("restore inspection rechecks context after response body parsing", async () => {
	const s = pausedInspection();
	fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => { s.records.set("Later.md", note("later")); return JSON.stringify(restored()); } } as Response);
	await expect(s.transport.inspectRestore()).rejects.toThrow("changed");
});

test("failed restore inspection remains retryable without writing or clearing review", async () => {
	const s = pausedInspection(), before = Y.encodeStateAsUpdate(s.doc);
	fetchMock.mockResolvedValueOnce(response(403, {})); await expect(s.transport.inspectRestore()).rejects.toThrow("403");
	expect(Y.encodeStateAsUpdate(s.doc)).toEqual(before);
	fetchMock.mockResolvedValueOnce(response(200, restored())); await expect(s.transport.inspectRestore()).resolves.toMatchObject({ reviewId: "review" });
	expect(fetchMock.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
});

test("source transfer contexts require a loaded inventory and expire on restore or stop", async () => {
	const s = setup();
	expect(() => s.transport.captureContentContext("photo.png", baseId(3))).toThrow("Wait for");
	fetchMock.mockResolvedValueOnce(response(200, empty())); await s.transport.flush();
	const captured = s.transport.captureContentContext("photo.png", baseId(3)); captured.check();
	fetchMock.mockResolvedValueOnce(response(200, restored()));
	await expect(s.transport.flush()).rejects.toThrow("restored");
	expect(captured.check).toThrow("restored");
	const other = setup(); fetchMock.mockResolvedValueOnce(response(200, restored())); await other.transport.flush();
	const second = other.transport.captureContentContext("photo.png", baseId(3));
	expect(second.binding.restoreGeneration).toBe(baseId(80)); other.transport.stop();
	expect(second.check).toThrow("context changed");
});
function baseState(version: number): BaseContentState {
	return { path: "Planning.base", generation: baseId(9), content_version: baseId(version), record: {
		id: baseId(3), type: "file", version: 0, hash: String(version).padStart(64, "0"), mimetype: "application/yaml", synctime: version } };
}

test("a restore response cannot automatically rebase old changes; inventory, activity and later edits survive reopening", async () => {
	const before = { ...empty(), records: { "Old.md": note("one") } };
	fetchMock.mockResolvedValueOnce(response(200, before)); const s = setup(); await s.transport.flush();
	s.doc.transact(() => { s.records.delete("Old.md"); s.records.set("Local.md", note("one")); s.doc.getMap("docactivity_v0").set("one", "pending"); });
	fetchMock.mockResolvedValueOnce(response(409, { error: { message: { code: "restore_generation_changed" } } }));
	fetchMock.mockResolvedValueOnce(response(200, restored(before)));
	await expect(s.transport.flush()).rejects.toThrow("restored");
	expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "POST", "GET"]);
	expect(s.records.toJSON()).toEqual({ "Local.md": note("one") });
	expect(s.transport.restoreReview).toMatchObject({ before, observed: restored(before), local: { "Local.md": note("one") }, activity: { one: "pending" } });
	expect(s.doc.getMap("managed_base_v1").get("snapshot")).toEqual(before);
	expect(s.transport.owner).toBe(false); expect(s.transport.permissions).toEqual({}); expect(s.transport.snapshot.owner).toBe(false);
	expect(s.transport.isBlocked("Unrelated.md")).toBe(true); expect(s.transport.registered("Old.md", "one")).toBe(false);
	s.records.set("Later.md", note("later")); const review = s.transport.restoreReview;
	const reopened = setup(Y.encodeStateAsUpdate(s.doc));
	await expect(reopened.transport.flush()).rejects.toThrow("restored");
	await expect(reopened.transport.claim("New.md", note("new"))).rejects.toThrow("restored");
	await expect(reopened.transport.publishablePaths(["New.md"])).rejects.toThrow("restored");
	await expect(reopened.transport.resolve("unused", "local", {}, jest.fn())).rejects.toThrow("restored");
	expect(reopened.records.toJSON()).toEqual(s.records.toJSON()); expect(reopened.transport.restoreReview).toEqual(review);
	expect(fetchMock).toHaveBeenCalledTimes(3);
});

test("a clean old inventory also pauses across restore, retaining current files without applying remote deletions", async () => {
	const before = { ...empty(), records: { "Keep.md": note("one") } };
	fetchMock.mockResolvedValueOnce(response(200, before)); const s = setup(); await s.transport.flush();
	fetchMock.mockResolvedValueOnce(response(200, restored()));
	await expect(s.transport.flush()).rejects.toThrow("restored");
	expect(s.records.toJSON()).toEqual(before.records); expect(s.transport.restoreReview?.before).toEqual(before);
});

test("a fresh empty client can join a restored share and new metadata changes retain their binding outside the body", async () => {
	fetchMock.mockResolvedValueOnce(response(200, restored())); const s = setup(); await s.transport.flush();
	expect(s.transport.restoreReview).toBeUndefined(); expect(s.transport.snapshot.restore_generation).toBe(baseId(80));
	s.records.set("New.md", note("new"));
	fetchMock.mockResolvedValueOnce(response(200, restored()));
	fetchMock.mockResolvedValueOnce(response(200, restored({ ...empty(), records: s.records.toJSON() })));
	await s.transport.flush();
	expect(fetchMock.mock.calls[1][1]?.method).toBe("GET");
	const sent = fetchMock.mock.calls[2][1]!;
	expect(new Headers(sent.headers).get("X-Relay-Restore-Generation")).toBe(baseId(80));
	expect(JSON.parse(sent.body as string)).toEqual({ changes: [{ path: "New.md", previous: null, value: note("new") }], activity: {} });
});

test.each(["another restore", "guard downgrade"])("%s preflight pauses a bound outbox without a write", async kind => {
	fetchMock.mockResolvedValueOnce(response(200, restored())); const s = setup(); await s.transport.flush();
	s.records.set("New.md", note("new"));
	fetchMock.mockResolvedValueOnce(response(200, kind === "another restore" ? restored(empty(), baseId(81)) : empty()));
	await expect(s.transport.flush()).rejects.toThrow("restored");
	expect(fetchMock.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
	expect(s.records.get("New.md")).toEqual(note("new")); expect(s.transport.restoreReview).toBeDefined();
});

test("a nonempty unproven inventory cannot be silently adopted by a restored server", async () => {
	const s = setup(); s.records.set("Local.md", note("local"));
	fetchMock.mockResolvedValueOnce(response(409, {})); fetchMock.mockResolvedValueOnce(response(200, restored()));
	await expect(s.transport.flush()).rejects.toThrow("restored");
	expect(s.transport.restoreReview?.before).toBeUndefined(); expect(s.records.get("Local.md")).toEqual(note("local"));
});

test("file claim freezes its body and restore binding before waiting for another exchange", async () => {
	fetchMock.mockResolvedValueOnce(response(200, restored())); const s = setup(); await s.transport.flush();
	let finish!: (value: Response) => void; fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const refreshing = s.transport.flush(), candidate = note("new"), claiming = s.transport.claim("New.md", candidate); candidate.id = "changed";
	fetchMock.mockResolvedValueOnce(response(200, restored()));
	fetchMock.mockResolvedValueOnce(response(200, { won: true, record: note("new"), permission: "write", restore_guard: true, restore_generation: baseId(80) }));
	finish(response(200, restored())); await refreshing; expect(await claiming).toBe(true);
	const claim = fetchMock.mock.calls.find(call => String(call[0]).endsWith("/claim"))![1]!;
	expect(JSON.parse(claim.body as string)).toEqual({ path: "New.md", record: note("new") });
	expect(new Headers(claim.headers).get("X-Relay-Restore-Generation")).toBe(baseId(80));
});

test("a claim cannot adopt an accepted response with a different restore binding", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty())); const s = setup(); await s.transport.flush();
	fetchMock.mockResolvedValueOnce(response(200, { won: true, record: note("new"), permission: "write", restore_guard: true, restore_generation: baseId(80) }));
	await expect(s.transport.claim("New.md", note("new"))).rejects.toThrow("restored");
	expect(s.records.size).toBe(0);
});

test("disconnection during a rejected write cannot start an automatic refresh or retry", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty())); const s = setup(); await s.transport.flush(); s.records.set("New.md", note("new"));
	let finish!: (value: Response) => void; fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const sending = s.transport.flush(); s.transport.stop(); finish(response(409, {}));
	await expect(sending).rejects.toThrow("context changed"); expect(fetchMock).toHaveBeenCalledTimes(2); expect(s.records.get("New.md")).toEqual(note("new"));
});

test("late Bases metadata acknowledgement cannot cross an observed inventory restore", async () => {
	const before = baseState(10), accepted = baseState(11);
	fetchMock.mockResolvedValueOnce(response(200, restored(baseManifest(before)))); const s = setup(); await s.transport.flush();
	await expect(s.transport.acknowledgeBaseContent(before, accepted)).rejects.toThrow("restored");
	expect(s.records.get(before.path)).toEqual(before.record);
	await s.transport.acknowledgeBaseContent(before, accepted, { restoreGeneration: baseId(80) });
	expect(s.records.get(before.path)).toEqual(accepted.record);
});
const baseManifest = (state: BaseContentState): ManagedManifest => ({ ...empty(), records: { [state.path]: state.record as ItemRecord },
	base_content: { protocol_version: 1, enabled: true, recovery: true, versions: { [state.record.id]: state.content_version! } } });

test("accepted Bases metadata follows a pending local rename without publishing an obsolete hash", async () => {
	const before = baseState(10), accepted = baseState(11);
	fetchMock.mockResolvedValueOnce(response(200, baseManifest(before))); const { transport, records, doc } = setup(); await transport.flush();
	doc.transact(() => { records.delete(before.path); records.set("Moved.base", before.record as ItemRecord); });
	await transport.acknowledgeBaseContent(before, accepted);
	expect(records.get("Moved.base")).toEqual(accepted.record); expect(records.has(before.path)).toBe(false);
	expect(transport.snapshot.records[before.path]).toEqual(accepted.record);
	fetchMock.mockResolvedValueOnce(response(200, { ...baseManifest(accepted), records: { "Moved.base": accepted.record } }));
	await transport.flush();
	expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).changes).toEqual([
		{ path: "Planning.base", previous: accepted.record, value: null }, { path: "Moved.base", previous: null, value: accepted.record },
	]); expect(transport.conflicts).toEqual([]);
});

test("late accepted Bases receipts cannot roll back a newer inventory version", async () => {
	const old = baseState(10), accepted = baseState(11), newer = baseState(12);
	fetchMock.mockResolvedValueOnce(response(200, baseManifest(newer))); const { transport, records } = setup(); await transport.flush();
	await transport.acknowledgeBaseContent(old, accepted); expect(records.get(old.path)).toEqual(newer.record);
	expect(transport.snapshot.base_content?.versions[old.record.id]).toBe(newer.content_version);
});

test("Bases acknowledgement waits for an in-flight inventory read before advancing its exact snapshot", async () => {
	const before = baseState(10), accepted = baseState(11); let finish!: (value: Response) => void;
	fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); const { transport, records } = setup();
	const refreshing = transport.flush(), acknowledgement = transport.acknowledgeBaseContent(before, accepted);
	finish(response(200, baseManifest(before))); await Promise.all([refreshing, acknowledgement]);
	expect(records.get(before.path)).toEqual(accepted.record); expect(transport.snapshot.records[before.path]).toEqual(accepted.record);
});

test("a restart publishes only offline metadata changes, with the previous server value", async () => {
	const snapshot = { ...empty(), records: { "Note.md": note("a") } };
	fetchMock.mockResolvedValue(response(200, snapshot));
	const first = setup(); await first.transport.flush(); first.transport.stop();
	first.doc.transact(() => { first.records.delete("Note.md"); first.records.set("Moved.md", note("a")); });
	const restarted = setup(Y.encodeStateAsUpdate(first.doc));
	fetchMock.mockResolvedValue(response(200, { ...empty(), records: { "Moved.md": note("a") } }));
	await restarted.transport.flush();
	const sent = JSON.parse(fetchMock.mock.calls[1][1]!.body as string);
	expect(sent.changes).toEqual(expect.arrayContaining([
		{ path: "Note.md", previous: note("a"), value: null },
		{ path: "Moved.md", previous: null, value: note("a") },
	]));
});

test("a local change made while HTTP is in flight survives and is sent next", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty()));
	const { transport, records } = setup(); await transport.flush();
	records.set("One.md", note("one"));
	let finish!: (value: Response) => void;
	fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = transport.flush();
	records.set("Two.md", note("two"));
	finish(response(200, { ...empty(), records: { "One.md": note("one") } }));
	await pending;
	expect(records.get("Two.md")).toEqual(note("two"));
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: records.toJSON() }));
	await transport.flush();
	expect(JSON.parse(fetchMock.mock.calls[2][1]!.body as string).changes).toEqual([{ path: "Two.md", previous: null, value: note("two") }]);
});

test("a failed refresh after a structural rejection retains the outbox", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty()));
	const { transport, records, failed, doc } = setup(); await transport.flush();
	records.set("Local.md", note("local"));
	fetchMock.mockResolvedValueOnce(response(409, { detail: "changed" }));
	fetchMock.mockResolvedValueOnce(response(503, {}));
	await expect(transport.flush()).rejects.toThrow("retained");
	expect(records.get("Local.md")).toEqual(note("local"));
	expect(doc.getMap<ManagedManifest>("managed_base_v1").get("snapshot")!.records).toEqual({});
	expect(failed).toHaveBeenCalled();
});

test("a claim adopts the server's canonical id instead of creating a second document", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty()));
	const { transport, records } = setup(); await transport.flush();
	fetchMock.mockResolvedValueOnce(response(200, { won: false, record: note("winner"), permission: "read" }));
	expect(await transport.claim("Note.md", note("loser"))).toBe(false);
	expect(records.get("Note.md")?.id).toBe("winner");
	expect(transport.registered("Note.md", "winner")).toBe(true);
	expect(transport.permissions["Note.md"]).toBe("read");
});

test("equivalent property ordering does not create spurious metadata writes", async () => {
	fetchMock.mockResolvedValue(response(200, { ...empty(), records: { "Note.md": note("one") } }));
	const { transport, records } = setup(); await transport.flush();
	records.set("Note.md", { version: 0, id: "one", type: ItemKind.Document });
	await transport.flush();
	expect(fetchMock.mock.calls[1][1]?.method).toBe("GET");
});


test("an activity marker racing a write downgrade refreshes permissions without wedging the share", async () => {
	const snapshot = { ...empty(), owner: false, records: { "Note.md": note("one") }, permissions: { "Note.md": "write" } };
	fetchMock.mockResolvedValueOnce(response(200, snapshot));
	const { transport, doc } = setup(); await transport.flush();
	doc.getMap<string>("docactivity_v0").set("one", "updated");
	fetchMock.mockResolvedValueOnce(response(403, {}));
	fetchMock.mockResolvedValueOnce(response(200, { ...snapshot, permissions: { "Note.md": "read" } }));
	await transport.flush();
	expect(transport.permissions["Note.md"]).toBe("read");
	expect(doc.getMap("docactivity_v0").has("one")).toBe(false);
	expect(fetchMock.mock.calls[2][1]?.method).toBe("GET");
});

test("adoption leaves unauthorized local files alone and asks only about caller-known paths", async () => {
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), owner: false, records: { "Visible.md": note("one") } }));
	const { transport } = setup(); await transport.flush();
	fetchMock.mockResolvedValueOnce(response(200, { "Work/New.md": "write", "Private.md": "none" }));
	expect(await transport.publishablePaths(["Visible.md", "Work/New.md", "Private.md"]))
		.toEqual(new Set(["Visible.md", "Work/New.md"]));
	expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ paths: ["Work/New.md", "Private.md"] });
});

async function divergentRename() {
	const initial = { ...empty(), records: { "Old.md": note("a") } };
	fetchMock.mockResolvedValueOnce(response(200, initial));
	const peer = setup(); await peer.transport.flush();
	peer.doc.transact(() => { peer.records.delete("Old.md"); peer.records.set("Local.md", note("a")); });
	const remote = { ...empty(), records: { "Remote.md": note("a") } };
	fetchMock.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, remote));
	await peer.transport.flush();
	return { ...peer, remote };
}

test("a divergent rename is isolated, persists across restart, and permits unrelated work", async () => {
	const first = await divergentRename();
	expect(first.transport.conflicts).toHaveLength(1);
	expect(first.records.toJSON()).toEqual({ "Local.md": note("a") });
	first.transport.stop();
	const next = setup(Y.encodeStateAsUpdate(first.doc));
	next.records.set("Unrelated.md", note("b"));
	fetchMock.mockResolvedValueOnce(response(200, { ...first.remote, records: { ...first.remote.records, "Unrelated.md": note("b") } }));
	await next.transport.flush();
	expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string).changes).toEqual([{ path: "Unrelated.md", previous: null, value: note("b") }]);
	expect(next.records.toJSON()).toEqual({ "Local.md": note("a"), "Unrelated.md": note("b") });
	expect(next.transport.isBlocked("Remote.md")).toBe(true);
	await expect(next.transport.claim("Another.md", note("a"))).rejects.toThrow("conflict");
});

test("a rejected mixed batch automatically retries its independent unchanged group", async () => {
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "Old.md": note("a"), "Other.md": note("b") } }));
	const { doc, transport, records } = setup(); await transport.flush();
	doc.transact(() => { records.delete("Old.md"); records.set("Local.md", note("a")); records.delete("Other.md"); records.set("Safe.md", note("b")); });
	fetchMock.mockResolvedValueOnce(response(409, {}));
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "Remote.md": note("a"), "Other.md": note("b") } }));
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "Remote.md": note("a"), "Safe.md": note("b") } }));
	await transport.flush();
	expect(transport.conflicts).toHaveLength(1);
	expect(records.toJSON()).toEqual({ "Local.md": note("a"), "Safe.md": note("b") });
	expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string).changes.map((c: {path:string}) => c.path).sort()).toEqual(["Other.md", "Safe.md"]);
});

test("already achieved changes recover automatically without creating a conflict", async () => {
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "Old.md": note("a") } }));
	const { transport, records, doc } = setup(); await transport.flush();
	doc.transact(() => { records.delete("Old.md"); records.set("New.md", note("a")); records.set("NewFile.md", note("b")); });
	fetchMock.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, { ...empty(), records: { "New.md": note("a") } }));
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "New.md": note("a"), "NewFile.md": note("b") } }));
	await transport.flush(); expect(transport.conflicts).toEqual([]);
});

test("additional local moves during a recovery request survive without duplicate identities", async () => {
	const { transport, doc, records, remote } = await divergentRename();
	let finish!: (r: Response) => void;
	fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = transport.flush();
	doc.transact(() => { records.delete("Local.md"); records.set("Latest.md", note("a")); });
	finish(response(200, remote)); await pending;
	fetchMock.mockResolvedValueOnce(response(200, remote)); await transport.flush();
	expect(records.toJSON()).toEqual({ "Latest.md": note("a") });
	expect(transport.conflicts[0].local).toEqual({ "Latest.md": note("a") });
	expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe("GET");
});

test("a folder and all its children form one conflict, including a new remote child", async () => {
	const folder = { id: "folder", type: ItemKind.Folder, version: 0 } as ItemRecord;
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { Folder: folder, "Folder/A.md": note("a") } }));
	const { transport, doc, records } = setup(); await transport.flush();
	doc.transact(() => { records.delete("Folder"); records.delete("Folder/A.md"); records.set("Local", folder); records.set("Local/A.md", note("a")); });
	fetchMock.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, { ...empty(), records: { Remote: folder, "Remote/A.md": note("a"), "Remote/New.md": note("new") } }));
	await transport.flush();
	expect(transport.conflicts).toHaveLength(1);
	expect(records.toJSON()).toEqual({ Local: folder, "Local/A.md": note("a") });
	expect(transport.isBlocked("Remote/New.md")).toBe(true);
});

test("server layout resolution requires a backup and preserves unrelated unsent changes", async () => {
	const { transport, records, remote } = await divergentRename();
	records.set("Pending.md", note("pending"));
	const finish = jest.fn(async () => {}), prepare = jest.fn(async () => finish);
	fetchMock.mockResolvedValueOnce(response(200, remote));
	await transport.resolve(transport.conflicts[0].id, "server", remote.records, prepare);
	expect(finish).toHaveBeenCalledTimes(1); expect(transport.conflicts).toHaveLength(0);
	expect(records.toJSON()).toEqual({ ...remote.records, "Pending.md": note("pending") });
});

test.each(["backup", "archive", "local edit", "server changed"])("resolution fails closed on %s", async failure => {
	const { transport, records, remote } = await divergentRename();
	const conflict = transport.conflicts[0];
	records.set("Pending.md", note("pending"));
	fetchMock.mockResolvedValueOnce(response(200, failure === "server changed" ? { ...remote, records: { "Again.md": note("a") } } : remote));
	const finish = jest.fn(async () => { if (failure === "archive") throw Error("disk error"); });
	const prepare = jest.fn(async () => {
		if (failure === "backup") throw Error("disk full");
		if (failure === "local edit") records.set("Late.md", note("late"));
		return finish;
	});
	await expect(transport.resolve(conflict.id, "server", remote.records, prepare)).rejects.toThrow();
	expect(transport.conflicts).toHaveLength(1); expect(records.get("Local.md")).toEqual(note("a"));
	if (failure !== "archive") expect(finish).not.toHaveBeenCalled();
	expect(records.get("Pending.md")).toEqual(note("pending"));
	if (failure === "server changed") expect(prepare).not.toHaveBeenCalled();
});

test("keeping the local layout sends fresh preconditions for both rename endpoints", async () => {
	const { transport, records, remote } = await divergentRename();
	fetchMock.mockResolvedValueOnce(response(200, remote)).mockResolvedValueOnce(response(200, { ...empty(), records: { "Local.md": note("a") } }));
	await transport.resolve(transport.conflicts[0].id, "local", remote.records, async () => async () => {});
	expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string).changes).toEqual([
		{ path: "Remote.md", previous: note("a"), value: null }, { path: "Local.md", previous: null, value: note("a") },
	]);
	expect(transport.conflicts).toHaveLength(0); expect(records.toJSON()).toEqual({ "Local.md": note("a") });
});

test("a revoked write becomes a decision without continually retrying or losing local content metadata", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty()));
	const { transport, records } = setup(); await transport.flush();
	records.set("Private.md", note("a"));
	const revoked = { ...empty(), owner: false };
	fetchMock.mockResolvedValueOnce(response(403, {})).mockResolvedValueOnce(response(200, revoked)).mockResolvedValueOnce(response(403, {}));
	await transport.flush(); expect(transport.conflicts).toHaveLength(1);
	fetchMock.mockResolvedValueOnce(response(200, revoked)); await transport.flush();
	expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe("GET");
	expect(records.get("Private.md")).toEqual(note("a"));
});

test.each([true, false])("a missing deleted identity is acknowledged only with a visible tombstone: %s", async tombstone => {
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { "Old.md": note("a") } }));
	const { transport, records } = setup(); await transport.flush(); records.delete("Old.md");
	fetchMock.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, { ...empty(), deleted: tombstone ? { "Old.md": ["a"] } : {} }));
	await transport.flush(); expect(transport.conflicts).toHaveLength(tombstone ? 0 : 1);
});

test("a second server change during backup refuses the local decision without archiving files", async () => {
	const { transport, records, remote } = await divergentRename();
	fetchMock.mockResolvedValueOnce(response(200, remote)).mockResolvedValueOnce(response(409, {}));
	const finish = jest.fn(async () => {});
	await expect(transport.resolve(transport.conflicts[0].id, "local", remote.records, async () => finish)).rejects.toThrow("retained");
	expect(finish).not.toHaveBeenCalled(); expect(transport.conflicts).toHaveLength(1);
	expect(records.toJSON()).toEqual({ "Local.md": note("a") });
});

test("keeping a folder layout cannot delete a server child absent from the offline operation", async () => {
	const folder = { id: "folder", type: ItemKind.Folder, version: 0 } as ItemRecord;
	fetchMock.mockResolvedValueOnce(response(200, { ...empty(), records: { Folder: folder, "Folder/A.md": note("a") } }));
	const { transport, doc, records } = setup(); await transport.flush();
	doc.transact(() => { records.delete("Folder"); records.delete("Folder/A.md"); records.set("Local", folder); records.set("Local/A.md", note("a")); });
	const remote = { ...empty(), records: { Remote: folder, "Remote/A.md": note("a"), "Remote/New.md": note("new") } };
	fetchMock.mockResolvedValueOnce(response(409, {})).mockResolvedValueOnce(response(200, remote));
	await transport.flush();
	fetchMock.mockResolvedValueOnce(response(200, remote));
	const prepare = jest.fn(async () => async () => {});
	await expect(transport.resolve(transport.conflicts[0].id, "local", remote.records, prepare)).rejects.toThrow("New server files");
	expect(prepare).not.toHaveBeenCalled(); expect(transport.conflicts).toHaveLength(1);
	expect(fetchMock.mock.calls.at(-1)![1]?.method).toBe("GET");
});

test("JSON inventory refreshes preserve the local Yjs client identity", async () => {
 const {doc,transport}=setup();const originalClient=doc.clientID;
 fetchMock.mockResolvedValue(response(200,{...empty(),records:{'Note.md':note('one')}}));
 for(let i=0;i<4;i++) await transport.flush();
 expect(doc.clientID).toBe(originalClient);
 fetchMock.mockResolvedValueOnce(response(200,{won:true,record:note('two'),permission:'write'}));
 await transport.claim('Two.md',note('two'));
 expect(doc.clientID).toBe(originalClient);
});
