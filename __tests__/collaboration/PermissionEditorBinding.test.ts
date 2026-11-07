import type TeamRelayPlugin from "../../src/main";
import { RelayOnPremShareClient } from "../../src/RelayOnPremShareClient";
import { permissionEditorBinding, canManagePermissionPolicy } from "../../src/ui/openPermissionEditor";
import type { ShareWithServer } from "../../src/RelayOnPremShareClientManager";
import { platformFetch } from "../../src/platformFetch";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
jest.mock("obsidian", () => ({ Modal: class {}, Component: class {}, Notice: jest.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
	let enabled = true, configured = true;
	let actor = id(2), endpoint = "https://relay.test", token: () => Promise<string> = async () => "synthetic";
	let provider = { getCurrentUser: () => ({ id: actor }) };
	let client: RelayOnPremShareClient | undefined = new RelayOnPremShareClient(endpoint, () => token());
	const authManager = { getProvider: () => provider };
	const plugin = { shareClient: new RelayOnPremShareClient("https://wrong-default.test", () => "wrong"),
		shareClientManager: { getClient: () => client }, authSession: { getMultiServerAuthManager: () => authManager },
		relayOnPremSettings: { readValue: () => ({ enabled, servers: configured ? [{ id: "selected", controlPlaneUrl: endpoint }] : [] }) } } as unknown as TeamRelayPlugin;
	return { plugin, disable: () => { enabled = false; }, removeConfig: () => { configured = false; }, replaceSession: () => { plugin.authSession = { ...plugin.authSession } as typeof plugin.authSession; }, setActor: () => { actor = id(8); }, setProvider: () => { provider = { getCurrentUser: () => ({ id: actor }) }; },
		setEndpoint: () => { endpoint = "https://changed.test"; }, setToken: (next: () => Promise<string>) => { token = next; }, removeClient: () => { client = undefined; } };
}
beforeEach(() => { jest.mocked(platformFetch).mockReset(); });
test.each(["setActor", "setProvider", "setEndpoint", "removeClient", "disable", "removeConfig", "replaceSession"] as const)("the selected account/server binding expires on %s", change => {
	const f = fixture(), binding = permissionEditorBinding(f.plugin, "selected", id(1))!;
	expect(binding.current()).toBe(true); f[change](); expect(binding.current()).toBe(false);
	if (change === "removeClient" || change === "removeConfig") expect(permissionEditorBinding(f.plugin, "selected", id(1))).toBeUndefined();
});
test("closing while credentials refresh prevents a later dispatch", async () => {
	const f = fixture(); let resolve!: (value: string) => void; f.setToken(() => new Promise(done => { resolve = done; }));
	const binding = permissionEditorBinding(f.plugin, "selected", id(1))!;
	const pending = binding.client.read(); binding.dispose(); resolve("synthetic");
	await expect(pending).rejects.toMatchObject({ code: "account_changed" }); expect(platformFetch).not.toHaveBeenCalled();
});
test("admin entry discovery requires an actual current authorized policy; nonmembers and legacy shares get no privilege hint", async () => {
	const f = fixture(), share = { managed: true, serverId: "selected", id: id(1) } as ShareWithServer;
	const snapshot = { version: 1, share_id: id(1), actor_id: id(2), owner_id: id(4), revision: "a".repeat(64), comment_revision: 0, file_rules: [], comment_rules: [], members: [] };
	jest.mocked(platformFetch).mockResolvedValueOnce(new Response(JSON.stringify(snapshot)));
	expect(await canManagePermissionPolicy(f.plugin, share)).toBe(true);
	jest.mocked(platformFetch).mockResolvedValueOnce(new Response("{}", { status: 403 }));
	expect(await canManagePermissionPolicy(f.plugin, share)).toBe(false);
	expect(await canManagePermissionPolicy(f.plugin, { ...share, managed: false })).toBe(false);
	expect(platformFetch).toHaveBeenCalledTimes(2);
});
