import { readManagedAttachment } from "../../src/client/readManagedAttachment";
import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import type { FileGrant } from "../../src/relay/TokenShapes";
import { sha256Hex } from "../../src/contentDigest";

const bytes = new TextEncoder().encode("captured image revision");
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; };
function setup() {
	const state = { current: true };
	const check = () => { if (!state.current) throw new Error("Source account changed"); };
	const grant: FileGrant = { token: "synthetic-inspection-secret", baseUrl: "https://source.test/shares/folder/files/file", url: "https://source.test/shares/folder/files/file",
		docId: "file", folder: "folder", expiryTime: Date.now() + 60_000, authorization: "read-only", fileHash: "", contentType: "application/octet-stream", contentLength: 0, restoreGuard: true, restoreGeneration: null };
	const inspection = jest.fn<ReturnType<RelayCredentialCache["requestFileInspectionToken"]>, Parameters<RelayCredentialCache["requestFileInspectionToken"]>>(async (...args) => {
		args[5]?.(); return { grant, check: () => { check(); args[5]?.(); } };
	});
	const credentials = { captureDocumentSourceContext: () => ({ serverId: "source", controlPlaneUrl: "https://source.test", check }), requestFileInspectionToken: inspection } as unknown as RelayCredentialCache;
	const fetcher = jest.fn<Promise<Response>, [string, RequestInit]>(async () => new Response(bytes, { headers: { "Content-Length": String(bytes.length) } }));
	const read = async (options: Parameters<typeof readManagedAttachment>[5] = {}) => readManagedAttachment(credentials, "address", await sha256Hex(bytes.buffer), "source", {}, { fetcher, ...options });
	return { state, grant, inspection, fetcher, read, credentials };
}

test("reads the exact captured revision without uploads, caches or buffered fallback", async () => {
	const s = setup(), preview = await s.read();
	expect(new Uint8Array(preview.content)).toEqual(bytes); preview.check();
	expect(s.inspection).toHaveBeenCalledTimes(1); expect(s.fetcher).toHaveBeenCalledTimes(1);
	expect(s.fetcher.mock.calls[0][0]).toBe(s.grant.baseUrl + "/content?token=synthetic-inspection-secret");
	expect(s.fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
	expect(s.fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
	s.state.current = false; expect(preview.check).toThrow("Source account changed");
});

test.each(["https://elsewhere.test/shares/folder/files/file", "https://source.test/other", "https://source.test/shares/folder/files/file?token=other"])("rejects a grant at an unexpected endpoint %s", async baseUrl => {
	const s = setup(); s.grant.baseUrl = baseUrl;
	await expect(s.read()).rejects.toThrow("outside the selected source"); expect(s.fetcher).not.toHaveBeenCalled();
});

const invalidHeaders: Record<string, string>[] = [
	{ "Content-Length": "-1" }, { "Content-Length": "1.2" }, { "Content-Length": "01" },
	{ "Content-Length": "999999999999999999999" },
];
test.each(invalidHeaders)("rejects invalid lengths %j", async headers => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(bytes, { headers }));
	await expect(s.read()).rejects.toThrow("unsupported size");
});

test.each(["chunked", "compressed"])("checks decoded bytes when size is not declared: %s", async mode => {
	const s = setup(), headers = new Headers();
	if (mode === "compressed") { headers.set("Content-Encoding", "gzip"); headers.set("Content-Length", "3"); }
	s.fetcher.mockResolvedValueOnce(new Response(bytes, { headers }));
	expect(new Uint8Array((await s.read()).content)).toEqual(bytes);
	s.fetcher.mockResolvedValueOnce(new Response(bytes, { headers }));
	await expect(s.read({ maxBytes: 3 })).rejects.toThrow("download limit");
});

test("accumulates a larger unknown-length stream within its decoded-byte budget", async () => {
	const s = setup(), content = new Uint8Array(150_001).fill(71);
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({ pull(controller) {
		if (offset === content.length) { controller.close(); return; }
		const next = Math.min(content.length, offset + 501);
		controller.enqueue(content.slice(offset, next)); offset = next;
	} });
	s.fetcher.mockResolvedValueOnce(new Response(body));
	const result = await readManagedAttachment(s.credentials, "address", await sha256Hex(content.buffer), "source", {}, { fetcher: s.fetcher, maxBytes: content.length });
	expect(new Uint8Array(result.content)).toEqual(content); expect(body.locked).toBe(false);
});

test.each([0, 1, bytes.length + 1])("rejects a body that differs from declared length %i", async length => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Length": String(length) } }));
	await expect(s.read()).rejects.toThrow(length < bytes.length ? "declared size" : "captured revision");
});

test("rejects a different digest despite a matching length", async () => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(new Uint8Array(bytes.length), { headers: { "Content-Length": String(bytes.length) } }));
	await expect(s.read()).rejects.toThrow("captured revision");
});

test("supports an empty attachment only when its digest agrees", async () => {
	const s = setup(); s.fetcher.mockResolvedValueOnce(new Response(null, { headers: { "Content-Length": "0" } }));
	const hash = await sha256Hex(new ArrayBuffer(0));
	const credentials = { captureDocumentSourceContext: () => ({ serverId: "source", controlPlaneUrl: "https://source.test", check: () => {} }), requestFileInspectionToken: s.inspection } as unknown as RelayCredentialCache;
	const result = await readManagedAttachment(credentials, "address", hash, "source", {}, { fetcher: s.fetcher });
	expect(result.content.byteLength).toBe(0); result.check();
});

test("an expired grant is refused before downloading", async () => {
	const s = setup(); s.grant.expiryTime = 1;
	await expect(s.read()).rejects.toThrow("expired"); expect(s.fetcher).not.toHaveBeenCalled();
});

test("a buffered-only response cannot use an arrayBuffer fallback", async () => {
	const s = setup(), arrayBuffer = jest.fn();
	s.fetcher.mockResolvedValueOnce({ status: 200, redirected: false, url: "", body: null, arrayBuffer,
		headers: new Headers({ "Content-Length": "5" }) } as unknown as Response);
	await expect(s.read()).rejects.toThrow("cannot stream"); expect(arrayBuffer).not.toHaveBeenCalled();
});

test("refuses oversized content before reading any bytes", async () => {
	const s = setup(), cancel = jest.fn(), pull = jest.fn();
	const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
	s.fetcher.mockResolvedValueOnce(new Response(body, { headers: { "Content-Length": "101" } }));
	await expect(s.read({ maxBytes: 100 })).rejects.toThrow("unsupported size");
	expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
});

test("cancellation during authentication prevents a late request", async () => {
	const s = setup(), signal = new AbortController(), wait = deferred<void>();
	s.inspection.mockImplementationOnce(async (...args) => { await wait.promise; args[5]?.(); return { grant: s.grant, check: () => {} }; });
	const pending = s.read({ signal: signal.signal }); await Promise.resolve(); await Promise.resolve(); signal.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" }); wait.resolve();
	await Promise.resolve(); expect(s.fetcher).not.toHaveBeenCalled();
});

test("a stalled stream times out, aborts its request and releases the reader", async () => {
	const s = setup(), cancel = jest.fn(), stream = new ReadableStream<Uint8Array>({ cancel });
	s.fetcher.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Length": "5" } }));
	await expect(s.read({ timeoutMs: 20 })).rejects.toThrow("timed out");
	expect(s.fetcher.mock.calls[0][1].signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1); expect(stream.locked).toBe(false);
});

test("a late fetch after timeout is cancelled and cannot return content", async () => {
	const s = setup(), wait = deferred<Response>(), cancel = jest.fn(); s.fetcher.mockReturnValueOnce(wait.promise);
	await expect(s.read({ timeoutMs: 20 })).rejects.toThrow("timed out");
	wait.resolve(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Length": "5" } }));
	await Promise.resolve(); await Promise.resolve(); expect(cancel).toHaveBeenCalledTimes(1);
});

test("account changes and expiry during streaming cannot deliver bytes", async () => {
	for (const change of ["account", "expiry"]) {
		const s = setup();
		const stream = new ReadableStream<Uint8Array>({ pull(controller) {
			if (change === "account") s.state.current = false; else s.grant.expiryTime = 1;
			controller.enqueue(bytes); controller.close();
		} }, { highWaterMark: 0 });
		s.fetcher.mockResolvedValueOnce(new Response(stream, { headers: { "Content-Length": String(bytes.length) } }));
		await expect(s.read()).rejects.toThrow(change === "account" ? "Refresh the source" : "expired"); expect(stream.locked).toBe(false);
	}
});

test("transport errors and redirected URLs do not expose the credential", async () => {
	const s = setup(); s.fetcher.mockRejectedValueOnce(new Error("Failed https://host.test?token=synthetic-inspection-secret"));
	await expect(s.read()).rejects.not.toThrow("synthetic-inspection-secret");
	const response = new Response(bytes, { headers: { "Content-Length": String(bytes.length) } });
	Object.defineProperty(response, "redirected", { value: true }); s.fetcher.mockResolvedValueOnce(response);
	await expect(s.read()).rejects.toThrow("refused or redirected");
});

test.each([0, -1, Infinity, 60_001])("rejects invalid timeout before authentication %s", async timeoutMs => {
	const s = setup(); await expect(s.read({ timeoutMs })).rejects.toThrow("Invalid attachment inspection limits"); expect(s.inspection).not.toHaveBeenCalled();
});
