import * as Y from "yjs";
import { ManagedIndexTransport, type ManagedManifest } from "../../src/client/ManagedIndexTransport";
import { platformFetch } from "../../src/platformFetch";
import { ItemKind, type ItemRecord } from "../../src/ItemKinds";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const fetchMock = platformFetch as jest.MockedFunction<typeof platformFetch>;
const response = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body) }) as Response;
const note = (id: string): ItemRecord => ({ id, type: ItemKind.Document, version: 0 });
const empty = (): ManagedManifest => ({ records: {}, permissions: {}, activity: {}, owner: true });
const transports: ManagedIndexTransport[] = [];
const documents: Y.Doc[] = [];
function setup(bytes?: Uint8Array) {
	const doc = new Y.Doc(); documents.push(doc);
	if (bytes) Y.applyUpdate(doc, bytes);
	const failed = jest.fn();
	const transport = new ManagedIndexTransport(doc, () => ({ endpoint: "https://cp.test/v1/managed/index/share", token: "grant" }), jest.fn(), failed);
	transports.push(transport);
	return { doc, transport, failed, records: doc.getMap<ItemRecord>("filemeta_v0") };
}
beforeEach(() => jest.resetAllMocks());
afterEach(() => { transports.splice(0).forEach(t => t.destroy()); documents.splice(0).forEach(d => d.destroy()); });

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

test("a refused structural change is retained locally and does not report successful sync", async () => {
	fetchMock.mockResolvedValueOnce(response(200, empty()));
	const { transport, records, failed, doc } = setup(); await transport.flush();
	records.set("Local.md", note("local"));
	fetchMock.mockResolvedValueOnce(response(409, { detail: "changed" }));
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
