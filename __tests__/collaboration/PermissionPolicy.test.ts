import { PermissionPolicyClient, parsePermissionPolicy, parsePermissionRules, permissionPath, type PermissionPolicy } from "../../src/collaboration/PermissionPolicy";
import type { PlatformRequestInit } from "../../src/platformFetch";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { shareId: id(1), actorId: id(2) };
const snapshot = (): PermissionPolicy => ({ version: 1, share_id: id(1), actor_id: id(2), owner_id: id(2), revision: "a".repeat(64), comment_revision: 0,
	file_rules: [{ user_id: id(3), path: "", recursive: true, permission: "read" }], comment_rules: [], members: [{ user_id: id(3), email: "member@example.test", active: true, administrator: false }] });
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test("parsing enforces identities, strict rules and exact canonical paths", () => {
	expect(parsePermissionPolicy(snapshot(), identity)).toEqual(snapshot());
	for (const value of [{ ...snapshot(), actor_id: id(4) }, { ...snapshot(), share_id: id(4) }, { ...snapshot(), revision: "old" },
		{ ...snapshot(), version: 2 }, { ...snapshot(), comment_revision: -1 }, { ...snapshot(), members: [...snapshot().members, ...snapshot().members] }]) expect(() => parsePermissionPolicy(value, identity)).toThrow();
	for (const path of ["../Note.md", ".secret", "a/./b", "a//b", "a\\b", "/absolute", "a:", "Cafe\u0301", "a\n"]) expect(permissionPath(path, true)).toBe(false);
	expect(permissionPath("", true)).toBe(true); expect(permissionPath("", false)).toBe(false); expect(permissionPath("Café/Note.md", false)).toBe(true);
	expect(() => parsePermissionRules({ file_rules: [...snapshot().file_rules, ...snapshot().file_rules], comment_rules: [] })).toThrow();
	expect(() => parsePermissionRules({ ...snapshot(), comment_rules: [{ user_id: id(3), path: "", recursive: true, allowed: "yes" }] })).toThrow();
	expect(() => parsePermissionRules({ ...snapshot(), file_rules: Array(1001).fill(snapshot().file_rules[0]) })).toThrow();
});

test("read and save bind the actor and serialize an immutable conditional update before awaiting credentials", async () => {
	let resume!: (value: string) => void;
	const token = jest.fn(() => new Promise<string>(resolve => { resume = resolve; }));
	const fetcher = jest.fn(async (_url: string, _init: PlatformRequestInit) => reply(snapshot()));
	const client = new PermissionPolicyClient("https://relay.test/", identity, token, () => true, fetcher);
	const proposed = { file_rules: snapshot().file_rules, comment_rules: [{ user_id: id(3), path: "", recursive: true, allowed: true }] };
	const saved = client.save(snapshot(), proposed); proposed.file_rules[0].permission = "write"; proposed.comment_rules[0].allowed = false; resume("synthetic-token"); await saved;
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0][0]).toBe("https://relay.test/v1/collaboration/shares/" + id(1) + "/permissions");
	const init = fetcher.mock.calls[0][1]; expect(init).toMatchObject({ method: "PUT", sensitive: true });
	expect(JSON.parse(init.body as string)).toMatchObject({ actor_id: id(2), expected_revision: "a".repeat(64), file_rules: [{ permission: "read" }], comment_rules: [{ allowed: true }] });
	const reading = client.read(); resume("synthetic-token"); await reading;
	expect(fetcher.mock.calls[1][0]).toContain("?actor_id=" + id(2));
});

test("account changes before dispatch and after a response reject stale administrative state", async () => {
	let current = true, resume!: (value: string) => void;
	const fetcher = jest.fn(async () => reply(snapshot()));
	const client = new PermissionPolicyClient("https://relay.test", identity, () => new Promise<string>(resolve => { resume = resolve; }), () => current, fetcher);
	const reading = client.read(); current = false; resume("new-account-token"); await expect(reading).rejects.toMatchObject({ code: "account_changed" }); expect(fetcher).not.toHaveBeenCalled();
	current = true;
	const late = new PermissionPolicyClient("https://relay.test", identity, () => "synthetic", () => current, async () => { current = false; return reply(snapshot()); });
	await expect(late.read()).rejects.toMatchObject({ code: "account_changed" });
});

test.each([[401, "anything", "authentication_required"], [403, "permission_editor_account_changed", "account_changed"], [403, "private error", "forbidden"], [404, "disabled", "unavailable"], [409, "permission_policy_changed", "changed"], [409, "permission_member_changed", "member_changed"], [500, "private details", "unconfirmed"]])("maps HTTP %s without exposing server diagnostics or automatically retrying", async (status, message, code) => {
	const fetcher = jest.fn(async () => reply({ error: { message } }, status as number));
	const client = new PermissionPolicyClient("https://relay.test", identity, () => "synthetic", () => true, fetcher);
	await expect(client.read()).rejects.toMatchObject({ code, message: code }); expect(fetcher).toHaveBeenCalledTimes(1);
});

test("oversized and wrong-identity responses cannot enter an administrative form", async () => {
	const values = [reply({ ...snapshot(), actor_id: id(9) }), new Response("x", { headers: { "Content-Length": String(9 * 1024 * 1024) } }), new Response("x".repeat(8 * 1024 * 1024 + 1))];
	for (const value of values) await expect(new PermissionPolicyClient("https://relay.test", identity, () => "synthetic", () => true, async () => value).read()).rejects.toMatchObject({ code: "invalid" });
});

test("timeout aborts transport and cannot dispatch later credentials or automatically retry a save", async () => {
	jest.useFakeTimers();
	try {
		let token!: (value: string) => void;
		const fetcher = jest.fn(async () => reply(snapshot()));
		const client = new PermissionPolicyClient("https://relay.test", identity, () => new Promise<string>(resolve => { token = resolve; }), () => true, fetcher);
		const result = client.save(snapshot(), snapshot()); const rejected = expect(result).rejects.toMatchObject({ code: "unconfirmed" });
		jest.advanceTimersByTime(15_000); await rejected; token("synthetic"); await tick(); expect(fetcher).not.toHaveBeenCalled();
		let signal: AbortSignal | undefined;
		const stalled = new PermissionPolicyClient("https://relay.test", identity, () => "synthetic", () => true, async (_url, init) => { signal = init.signal as AbortSignal; return new Promise<Response>(() => {}); });
		const pending = stalled.read(), checked = expect(pending).rejects.toMatchObject({ code: "unconfirmed" }); await tick();
		jest.advanceTimersByTime(15_000); await checked; expect(signal?.aborted).toBe(true);
	} finally { jest.useRealTimers(); }
});

test("restore snapshots reject malformed or unsupported generations and retain legacy compatibility", () => {
	for (const fields of [{ restore_guard: true }, { restore_generation: null }, { restore_guard: "yes", restore_generation: null },
		{ restore_guard: true, restore_generation: "bad" }, { restore_guard: false, restore_generation: id(8) }]) {
		expect(() => parsePermissionPolicy({ ...snapshot(), ...fields }, identity)).toThrow();
	}
	expect(parsePermissionPolicy({ ...snapshot(), restore_guard: true, restore_generation: id(8) }, identity)).toMatchObject({ restore_guard: true, restore_generation: id(8) });
});

test("save freezes its observed restore header before credentials and read never carries a mutation header", async () => {
	let resume!: (token: string) => void;
	const observed = { ...snapshot(), restore_guard: true, restore_generation: id(8) };
	const fetcher = jest.fn(async (_url: string, _init: PlatformRequestInit) => reply({ ...snapshot(), restore_guard: true, restore_generation: id(8) }));
	const client = new PermissionPolicyClient("https://relay.test", identity, () => new Promise<string>(resolve => { resume = resolve; }), () => true, fetcher);
	const saving = client.save(observed, observed); observed.restore_generation = id(9); resume("synthetic"); await saving;
	expect(new Headers(fetcher.mock.calls[0][1].headers).get("X-Relay-Restore-Generation")).toBe(id(8));
	expect(JSON.parse(fetcher.mock.calls[0][1].body as string)).not.toHaveProperty("restore_generation");
	const reading = client.read(); resume("synthetic"); await reading;
	expect(new Headers(fetcher.mock.calls[1][1].headers).has("X-Relay-Restore-Generation")).toBe(false);
});

test("restore rejection is explicit and a mismatched successful save stays unconfirmed without retry", async () => {
	const observed = { ...snapshot(), restore_guard: true, restore_generation: id(8) };
	for (const response of [reply({ error: { message: { code: "restore_generation_changed" } } }, 409),
		reply({ ...observed, restore_generation: id(9) }), reply(snapshot())]) {
		const fetcher = jest.fn(async () => response);
		const client = new PermissionPolicyClient("https://relay.test", identity, () => "synthetic", () => true, fetcher);
		await expect(client.save(observed, observed)).rejects.toMatchObject({ code: response.status === 409 ? "restore_changed" : "unconfirmed" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	}
});
