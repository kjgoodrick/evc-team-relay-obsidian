import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import type { DocumentGrant } from "../../src/relay/TokenShapes";
import { readManagedInventory } from "../../src/client/readManagedInventory";

const generation = "11111111-1111-4111-8111-111111111111";
const snapshot = { records: {}, permissions: {}, activity: {}, owner: true, restore_guard: true, restore_generation: generation };
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; };
function setup() {
	const state = { current: true }, check = () => { if (!state.current) throw new Error("account changed"); };
	const grant: DocumentGrant = { token: "synthetic-grant", docId: "folder", folder: "folder", url: "https://source.test/v1/managed/index", expiryTime: Date.now() + 60_000, authorization: "read-only", restoreGuard: true, restoreGeneration: generation };
	const inspect = jest.fn<ReturnType<RelayCredentialCache["requestInventoryInspectionToken"]>, Parameters<RelayCredentialCache["requestInventoryInspectionToken"]>>(async (...args) => { args[3]?.(); return { grant, check: () => { check(); args[3]?.(); } }; });
	const credentials = { captureDocumentSourceContext: () => ({ serverId: "source", controlPlaneUrl: "https://source.test", check }), requestInventoryInspectionToken: inspect } as unknown as RelayCredentialCache;
	const fetcher = jest.fn<Promise<Response>, [string, RequestInit]>(async () => new Response(JSON.stringify(snapshot)));
	const read = (options: Parameters<typeof readManagedInventory>[4] = {}) => readManagedInventory(credentials, "address", "source", { restoreGeneration: generation }, { fetcher, ...options });
	return { state, grant, inspect, credentials, fetcher, read };
}

test("fresh inventory inspection performs one read without creating or applying index state", async () => {
	const s = setup(); expect(await s.read()).toEqual(snapshot);
	expect(s.inspect).toHaveBeenCalledTimes(1); expect(s.fetcher).toHaveBeenCalledTimes(1);
	expect(s.fetcher.mock.calls[0]).toEqual(["https://source.test/v1/managed/index/folder", expect.objectContaining({ method: "GET", headers: { Authorization: "Bearer synthetic-grant" }, redirect: "error", credentials: "omit", cache: "no-store" })]);
	expect(s.fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
});

test.each([
	null, [], {}, { ...snapshot, records: [] }, { ...snapshot, owner: "true" },
	{ ...snapshot, restore_guard: false }, { ...snapshot, restore_generation: null },
	{ ...snapshot, restore_generation: "22222222-2222-4222-8222-222222222222" },
])("rejects invalid inventory or changed generation %j", async value => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value)));
	await expect(s.read()).rejects.toThrow();
});

test.each(["declared", "streamed"])("bounds %s response size", async mode => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { headers: mode === "declared" ? { "Content-Length": "10000" } : {} }));
	await expect(s.read({ maxBytes: 10 })).rejects.toThrow("download limit");
});

test("refuses credentials for another endpoint before sending them", async () => {
	const s = setup(); s.grant.url = "https://different.test/v1/managed/index";
	await expect(s.read()).rejects.toThrow("outside the selected source"); expect(s.fetcher).not.toHaveBeenCalled();
});

test("cancellation while authentication waits prevents a late network read", async () => {
	const s = setup(), wait = deferred<void>(), abort = new AbortController();
	s.inspect.mockImplementationOnce(async (...args) => { await wait.promise; args[3]?.(); return { grant: s.grant, check: () => {} }; });
	const pending = s.read({ signal: abort.signal }); abort.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" }); wait.resolve(); await Promise.resolve(); expect(s.fetcher).not.toHaveBeenCalled();
});

test("stalled and late responses are fenced after timeout", async () => {
	const s = setup(), wait = deferred<Response>(), cancel = jest.fn(); s.fetcher.mockReturnValueOnce(wait.promise);
	await expect(s.read({ timeoutMs: 20 })).rejects.toThrow("timed out");
	wait.resolve(new Response(new ReadableStream<Uint8Array>({ cancel })));
	await Promise.resolve(); await Promise.resolve(); expect(cancel).toHaveBeenCalledTimes(1);
});

test("a stalled body is released after timeout", async () => {
	const s = setup(), cancel = jest.fn(), body = new ReadableStream<Uint8Array>({ cancel });
	s.fetcher.mockResolvedValueOnce(new Response(body));
	await expect(s.read({ timeoutMs: 20 })).rejects.toThrow("timed out"); expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false);
});

test("account change after response arrival rejects the old inventory", async () => {
	const s = setup();
	s.fetcher.mockImplementationOnce(async () => { s.state.current = false; return new Response(JSON.stringify(snapshot)); });
	await expect(s.read()).rejects.toThrow("Refresh the source");
});

test("error bodies and network messages do not escape into the UI", async () => {
	const s = setup(); s.fetcher.mockRejectedValueOnce(new Error("synthetic-secret"));
	await expect(s.read()).rejects.not.toThrow("synthetic-secret");
	s.fetcher.mockResolvedValueOnce(new Response("synthetic-secret", { status: 403 }));
	await expect(s.read()).rejects.not.toThrow("synthetic-secret");
});
