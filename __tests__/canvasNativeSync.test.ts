import { deliverCanvasNative, type CanvasNativeSyncHost } from "../src/CanvasNativeSync";

const canvas = (text: string) => JSON.stringify({ nodes: [{ id: "card", type: "text", text }], edges: [] });
function fixture(local: string | undefined = canvas("base"), base: string | undefined = canvas("base")) {
	const state: { local: string | undefined; base: string | undefined; remote: string; valid: boolean; saved: string[]; events: string[] }
		= { local, base, remote: canvas("remote"), valid: true, saved: [], events: [] };
	const host: CanvasNativeSyncHost = {
		readNative: async () => state.local, readBase: async () => state.base, remote: () => state.remote,
		check: () => { if (!state.valid) throw new Error("context changed"); },
		preserve: async value => { state.events.push("preserve"); state.saved.push(value); },
		writeNative: async value => { state.events.push("write"); state.local = value; },
		writeBase: async value => { state.events.push("base"); state.base = value; },
	};
	return { state, host };
}

test("an unchanged native base receives remote updates without extra copies", async () => {
	const { host, state } = fixture();
	expect(await deliverCanvasNative(host)).toBe("written");
	expect(state.events).toEqual(["write", "base"]); expect(state.local).toBe(state.remote); expect(state.base).toBe(state.remote);
});

test("formatting and object-key order do not create conflicts", async () => {
	const { host, state } = fixture('{ "edges": [], "nodes": [{"text":"base", "type":"text", "id":"card"}] }');
	await deliverCanvasNative(host); expect(state.saved).toEqual([]); expect(state.local).toBe(state.remote);
});

test.each(["local edit", "invalid JSON"])("preserves %s before adopting synchronized data", async kind => {
	const original = kind === "local edit" ? canvas("local") : "unfinished native JSON", { host, state } = fixture(original);
	await deliverCanvasNative(host);
	expect(state.saved).toEqual([original]); expect(state.events).toEqual(["preserve", "write", "base"]);
	expect(state.local).toBe(state.remote);
});

test("a legacy client without a baseline preserves a divergent native file once", async () => {
	const { host, state } = fixture(canvas("local")); state.base = undefined;
	await deliverCanvasNative(host); await deliverCanvasNative(host);
	expect(state.saved).toEqual([canvas("local")]); expect(state.events).toEqual(["preserve", "write", "base"]);
});

test("a matching native file establishes the base without rewriting it", async () => {
	const { host, state } = fixture(canvas("remote")); state.base = undefined;
	expect(await deliverCanvasNative(host)).toBe("unchanged"); expect(state.events).toEqual(["base"]);
});

test("a confirmed missing file is created without preserving a placeholder", async () => {
	const { host, state } = fixture(); state.local = undefined;
	await deliverCanvasNative(host); expect(state.events).toEqual(["write", "base"]);
});

test("a failed read is not treated as a missing file", async () => {
	const { host, state } = fixture(); host.readNative = async () => { throw new Error("disk unavailable"); };
	await expect(deliverCanvasNative(host)).rejects.toThrow("disk unavailable"); expect(state.events).toEqual([]);
});

test("failed preservation cannot overwrite local work or advance its baseline", async () => {
	const { host, state } = fixture(canvas("local")); host.preserve = async () => { throw new Error("backup failed"); };
	await expect(deliverCanvasNative(host)).rejects.toThrow("backup failed");
	expect(state.local).toBe(canvas("local")); expect(state.base).toBe(canvas("base")); expect(state.events).toEqual([]);
});

test("typing while preservation waits leaves the newer native edit untouched", async () => {
	const { host, state } = fixture(canvas("local"));
	host.preserve = async value => { state.saved.push(value); state.local = canvas("even newer local edit"); };
	expect(await deliverCanvasNative(host)).toBe("deferred");
	expect(state.local).toBe(canvas("even newer local edit")); expect(state.base).toBe(canvas("base"));
	expect(state.saved).toEqual([canvas("local")]); expect(state.events).toEqual([]);
});

test("an editor opening or source changing during preservation stops native delivery", async () => {
	const { host, state } = fixture(canvas("local")); host.preserve = async value => { state.saved.push(value); state.valid = false; };
	await expect(deliverCanvasNative(host)).rejects.toThrow("context changed");
	expect(state.local).toBe(canvas("local")); expect(state.events).toEqual([]);
});

test("a newer remote update during the native write cannot advance the base past delivered data", async () => {
	const { host, state } = fixture(), delivered = state.remote;
	host.writeNative = async value => { state.local = value; state.remote = canvas("later remote edit"); };
	await deliverCanvasNative(host); expect(state.local).toBe(delivered); expect(state.base).toBe(delivered);
	await deliverCanvasNative(host); expect(state.local).toBe(canvas("later remote edit")); expect(state.saved).toEqual([]);
});

test("a failed native write does not acknowledge delivery", async () => {
	const { host, state } = fixture(); host.writeNative = async () => { throw new Error("write failed"); };
	await expect(deliverCanvasNative(host)).rejects.toThrow("write failed"); expect(state.base).toBe(canvas("base"));
});
