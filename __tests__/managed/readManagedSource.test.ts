import * as Y from "yjs";
import { readManagedSource } from "../../src/client/readManagedSource";
import { YSweetProvider, type YSweetProviderParams } from "../../src/client/provider";
import type { RelayCredentialCache } from "../../src/RelayCredentialCache";
import type { DocumentGrant } from "../../src/relay/TokenShapes";

jest.mock("../../src/client/provider", () => ({ YSweetProvider: jest.fn() }));
const constructor = jest.mocked(YSweetProvider);
const grant: DocumentGrant = { token: "fixture-read-token", url: "ws://fixture.test/v1/managed/socket", docId: "document", folder: "share",
	authorization: "read-only", expiryTime: Date.now() + 600_000 };
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
class FakeProvider {
	listeners = new Map<string, ((...args: unknown[]) => void)[]>();
	awareness = { setLocalState: jest.fn() };
	connect = jest.fn();
	destroy = jest.fn(() => this.listeners.clear());
	constructor(readonly doc: Y.Doc, readonly options: YSweetProviderParams) {}
	on(name: string, listener: (...args: unknown[]) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
	emit(name: string, ...args: unknown[]) { this.listeners.get(name)?.forEach(listener => listener(...args)); }
}
let provider: FakeProvider;
beforeEach(() => {
	jest.clearAllMocks();
	constructor.mockImplementation((_url, _id, doc, options) => { provider = new FakeProvider(doc, options!); return provider as unknown as YSweetProvider; });
});
afterEach(() => jest.useRealTimers());
function credentials() {
	const check = jest.fn(), request = jest.fn(async () => ({ grant: { ...grant }, check }));
	return { cache: { requestSourceInspectionToken: request } as unknown as RelayCredentialCache, request, check };
}

test("a source preview starts empty and invisible, returns independent bytes, and closes its temporary document", async () => {
	const s = credentials(), pending = readManagedSource(s.cache, "source", "Note.md", "server", {}); await tick();
	expect(provider.doc.getText("contents").toString()).toBe(""); expect(provider.doc.gc).toBe(false);
	expect(provider.options).toMatchObject({ connect: false, disableBc: true, maxConnectionErrors: 1 });
	expect(provider.awareness.setLocalState).toHaveBeenCalledWith(null);
	provider.doc.getText("contents").insert(0, "server content"); provider.emit("sync", true);
	const preview = await pending, copy = new Y.Doc(); Y.applyUpdate(copy, preview.update);
	expect(copy.getText("contents").toString()).toBe("server content"); expect(preview.stateVector).toEqual(Y.encodeStateVector(copy)); copy.destroy();
	expect(provider.destroy).toHaveBeenCalledTimes(1); expect(provider.doc.isDestroyed).toBe(true);
	expect(() => preview.check()).not.toThrow(); expect(s.check).toHaveBeenCalled();
});

test("a timed-out authentication wait cannot create a socket when its late grant arrives", async () => {
	jest.useFakeTimers(); const s = credentials(); let finish!: (value: Awaited<ReturnType<typeof s.request>>) => void;
	s.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const pending = readManagedSource(s.cache, "source", "Note.md", "server", {}, { timeoutMs: 10 });
	const rejected = expect(pending).rejects.toThrow("timed out"); await jest.advanceTimersByTimeAsync(10); await rejected;
	finish({ grant, check: s.check }); await tick(); expect(constructor).not.toHaveBeenCalled();
});

test("aborting an active preview closes it and ignores later synchronization", async () => {
	const s = credentials(), controller = new AbortController();
	const pending = readManagedSource(s.cache, "source", "Note.md", "server", {}, { signal: controller.signal }); await tick();
	controller.abort(); await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	provider.emit("sync", true); expect(provider.destroy).toHaveBeenCalledTimes(1); expect(provider.doc.isDestroyed).toBe(true);
});

test("a changed review before the snapshot is returned rejects the preview", async () => {
	const s = credentials(); let invalid = false;
	const pending = readManagedSource(s.cache, "source", "Note.md", "server", {}, { check: () => { if (invalid) throw new Error("review changed"); } }); await tick();
	invalid = true; provider.emit("sync", true); await expect(pending).rejects.toThrow("review changed");
	expect(provider.doc.isDestroyed).toBe(true);
});

test.each(["insertion", "deletion"])("a missing %s dependency cannot be displayed as a complete restored source", async kind => {
	const source = new Y.Doc(), updates: Uint8Array[] = []; source.on("update", update => updates.push(update));
	source.getText("contents").insert(0, "base text");
	if (kind === "insertion") source.getText("contents").insert(9, " later text"); else source.getText("contents").delete(0, 9);
	const s = credentials(), pending = readManagedSource(s.cache, "source", "Note.md", "server", {}); await tick();
	Y.applyUpdate(provider.doc, updates[1]); provider.emit("sync", true);
	await expect(pending).rejects.toThrow("incomplete changes"); expect(provider.doc.isDestroyed).toBe(true); source.destroy();
});

test("the encoded update budget also bounds an unfinished incoming stream", async () => {
	const s = credentials(), pending = readManagedSource(s.cache, "source", "Note.md", "server", {}, { maxBytes: 16 }); await tick();
	provider.doc.getText("contents").insert(0, "a large source update that exceeds the preview budget");
	await expect(pending).rejects.toThrow("too large"); expect(provider.destroy).toHaveBeenCalledTimes(1);
});

test.each([4403, 4412])("source close %s rejects without retrying or leaving a temporary provider", async code => {
	const s = credentials(), pending = readManagedSource(s.cache, "source", "Note.md", "server", {}); await tick();
	provider.emit("connection-close", { code }); await expect(pending).rejects.toThrow(code === 4412 ? "restored again" : "closed");
	expect(provider.connect).toHaveBeenCalledTimes(1); expect(provider.destroy).toHaveBeenCalledTimes(1);
});
