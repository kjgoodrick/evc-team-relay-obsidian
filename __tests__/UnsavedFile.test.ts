import { UnsavedFileStore } from "src/UnsavedFile";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { testGlobal } from "./mocks/testGlobal";

// Use real IndexedDB transaction scheduling and keyPath semantics, including
// late aborts after an individual request reports success.
function installFakeIndexedDB(): void {
	(testGlobal as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
}

describe("UnsavedFileStore (: guid wire-format guard)", () => {
	beforeEach(() => {
		installFakeIndexedDB();
	});

	it("round-trips a saved buffer by guid", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-1", "unsaved contents");

		const readBack = await store.readUnsaved("doc-guid-1");

		expect(readBack).toBe("unsaved contents");
	});

	it("a transient open failure can retry in the same store instance", async () => {
		const store = new UnsavedFileStore(), spy = jest.spyOn(indexedDB, "open").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
		try { await expect(store.persistUnsaved("retry", "retained")).rejects.toThrow("unavailable"); }
		finally { spy.mockRestore(); }
		await store.persistUnsaved("retry", "retained"); expect(await store.readUnsaved("retry")).toBe("retained");
	});

	it("stores the record under a field literally named 'guid', matching the on-disk keyPath", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-2", "other contents");

		// The only way readUnsaved() can find this record at all is if the
		// object persistUnsaved() wrote had a `guid` field equal to the key --
		// exactly the shorthand-object-literal behavior in persistUnsaved()
		// (`store.put({ guid, contents })`) that a renamed parameter would break.
		const readBack = await store.readUnsaved("doc-guid-2");
		expect(readBack).not.toBeNull();

		const missing = await store.readUnsaved("some-other-guid");
		expect(missing).toBeNull();
	});

	it("discardUnsaved removes the buffer so a later read returns null", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("doc-guid-3", "to be discarded");

		await store.discardUnsaved("doc-guid-3");

		expect(await store.readUnsaved("doc-guid-3")).toBeNull();
	});
});


describe("UnsavedFileStore transaction durability", () => {
	beforeEach(installFakeIndexedDB);
	afterEach(() => jest.restoreAllMocks());

	it.each(["put", "delete", "get", "count"] as const)("a late %s abort is reported and preserves the last committed buffer", async operation => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("retained", "COMMITTED TEXT");
		const original = IDBObjectStore.prototype[operation]; let succeeded = false;
		const spy = jest.spyOn(IDBObjectStore.prototype, operation).mockImplementation(function (this: globalThis.IDBObjectStore, ...args: unknown[]) {
			const request = Reflect.apply(original, this, args) as IDBRequest;
			const transaction = this.transaction;
			request.addEventListener("success", () => {
				succeeded = true;
				queueMicrotask(() => transaction.abort());
			}, { once: true });
			return request;
		});
		const action = operation === "put" ? store.persistUnsaved("retained", "UNCOMMITTED TEXT")
			: operation === "delete" ? store.discardUnsaved("retained") : operation === "get" ? store.readUnsaved("retained") : store.countSavedBuffers(["retained"], { check: () => {} });
		await expect(action).rejects.toThrow(); expect(succeeded).toBe(true);
		spy.mockRestore();
		expect(await store.readUnsaved("retained")).toBe("COMMITTED TEXT");
		await store.persistUnsaved("retained", "RETRIED TEXT");
		expect(await store.readUnsaved("retained")).toBe("RETRIED TEXT");
	});

	it("saved-buffer inspection counts exact unique keys without loading or changing text", async () => {
		const store = new UnsavedFileStore(); await store.persistUnsaved("selected", ""); await store.persistUnsaved("older-generation", "Retained text");
		const read = jest.spyOn(IDBObjectStore.prototype, "get"), all = jest.spyOn(IDBObjectStore.prototype, "getAll");
		expect(await store.countSavedBuffers(["selected", "selected", "missing"], { check: () => {} })).toBe(1);
		expect(read).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled(); read.mockRestore(); all.mockRestore();
		expect(await store.readUnsaved("older-generation")).toBe("Retained text"); expect(await store.readUnsaved("selected")).toBe("");
	});

	it("cancelled or oversized inspections do not open the buffer database", async () => {
		const store = new UnsavedFileStore(), controller = new AbortController(), open = jest.spyOn(indexedDB, "open"); controller.abort();
		await expect(store.countSavedBuffers(["selected"], { check: () => {}, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
		await expect(store.countSavedBuffers(Array(10_001).fill("selected"), { check: () => {} })).rejects.toThrow("keys");
		expect(open).not.toHaveBeenCalled();
	});

	it("an invalid record fails without stranding the next transaction", async () => {
		const store = new UnsavedFileStore();
		await expect(store.persistUnsaved(undefined as unknown as string, "invalid key")).rejects.toThrow();
		await store.persistUnsaved("valid", "retained");
		expect(await store.readUnsaved("valid")).toBe("retained");
	});

	it("conditional saves serialize competing sessions and conditional clear preserves a newer body", async () => {
		const first = new UnsavedFileStore(), second = new UnsavedFileStore();
		await first.persistUnsaved("shared", "initial");
		const results = await Promise.all([first.persistUnsavedIfContents("shared", "initial", "first"), second.persistUnsavedIfContents("shared", "initial", "second")]);
		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = await first.readUnsaved("shared"); expect(["first", "second"]).toContain(winner);
		expect(await second.discardUnsavedIfContents("shared", "initial")).toBe(false); expect(await first.readUnsaved("shared")).toBe(winner);
		expect(await first.discardUnsavedIfContents("shared", winner!)).toBe(true); expect(await first.readUnsaved("shared")).toBeNull();
		expect(await second.persistUnsavedIfContents("shared", null, "new")).toBe(true);
	});

	it("a malformed stored body cannot be mistaken for a missing buffer or overwritten conditionally", async () => {
		const store = new UnsavedFileStore();
		await store.persistUnsaved("corrupt", null as unknown as string);
		await expect(store.readUnsaved("corrupt")).rejects.toThrow("invalid");
		await expect(store.persistUnsavedIfContents("corrupt", null, "replacement")).rejects.toThrow();
		await expect(store.readUnsaved("corrupt")).rejects.toThrow("invalid");
	});

	it.each(["put", "delete"] as const)("conditional %s waits for commit and reports a late rollback", async operation => {
		const store = new UnsavedFileStore(); await store.persistUnsaved("conditional", "retained");
		const original = IDBObjectStore.prototype[operation];
		const spy = jest.spyOn(IDBObjectStore.prototype, operation).mockImplementation(function (this: globalThis.IDBObjectStore, ...args: unknown[]) {
			const request = Reflect.apply(original, this, args) as IDBRequest, transaction = this.transaction;
			request.addEventListener("success", () => queueMicrotask(() => transaction.abort()), { once: true }); return request;
		});
		const action = operation === "put" ? store.persistUnsavedIfContents("conditional", "retained", "new") : store.discardUnsavedIfContents("conditional", "retained");
		await expect(action).rejects.toThrow(); spy.mockRestore(); expect(await store.readUnsaved("conditional")).toBe("retained");
	});
});
