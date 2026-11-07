import { applyPermissionOverrides, effectivePermission, mergePermissionRules, permissionChanges } from "../../src/collaboration/PermissionEditor";
import type { PermissionPolicy, PermissionRules } from "../../src/collaboration/PermissionPolicy";
jest.mock("../../src/platformFetch", () => ({ platformFetch: jest.fn() }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { user_id: id(3), path: "Projects", recursive: true };
const empty = (): PermissionRules => ({ file_rules: [], comment_rules: [] });
const policy = (): PermissionPolicy => ({ ...empty(), version: 1, share_id: id(1), actor_id: id(2), owner_id: id(2), revision: "a".repeat(64), comment_revision: 0,
	members: [{ user_id: id(3), email: "reviewer@example.test", active: true, administrator: false }] });

test("reviewer preset preserves explicit exceptions by default and only opt-in removes narrower rules for the chosen member", () => {
	const before = { file_rules: [{ ...scope, path: "Projects/Private", permission: "none" as const }, { ...scope, path: "Projects/A.md", recursive: false, permission: "write" as const }, { ...scope, user_id: id(4), path: "Projects/A.md", permission: "write" as const }],
		comment_rules: [{ ...scope, path: "Projects/Private", allowed: false }] };
	const retained = applyPermissionOverrides(before, { ...scope, file: "read", comment: "allow" });
	expect(effectivePermission(policy(), retained, id(3), "Projects/New.md")).toMatchObject({ read: true, edit: false, comment: true });
	expect(effectivePermission(policy(), retained, id(3), "Projects/A.md")).toMatchObject({ edit: true });
	expect(effectivePermission(policy(), retained, id(3), "Projects/Private/Secret.md")).toMatchObject({ read: false, comment: false });
	const replaced = applyPermissionOverrides(before, { ...scope, file: "read", comment: "allow" }, true);
	expect(replaced.file_rules).toHaveLength(2); expect(replaced.file_rules.find(r => r.user_id === id(4))).toEqual(before.file_rules[2]);
	expect(permissionChanges(before, replaced).filter(c => !c.after)).toHaveLength(3);
	expect(before.file_rules).toHaveLength(3); expect(before.comment_rules).toHaveLength(1);
});

test("independent precedence, exact ties, path boundaries, missing membership and inherit never manufacture access", () => {
	let rules = applyPermissionOverrides(empty(), { ...scope, path: "", file: "write", comment: "inherit" });
	rules = applyPermissionOverrides(rules, { ...scope, file: "read", comment: "deny" });
	rules = applyPermissionOverrides(rules, { ...scope, path: "Projects/A.md", file: "write", comment: "allow", recursive: true });
	rules = applyPermissionOverrides(rules, { ...scope, path: "Projects/A.md", file: "read", comment: "deny", recursive: false });
	expect(effectivePermission(policy(), rules, id(3), "Projects/A.md")).toMatchObject({ read: true, edit: false, comment: false });
	expect(effectivePermission(policy(), rules, id(3), "Projects-more/A.md")).toMatchObject({ read: true, edit: true, comment: true });
	rules = applyPermissionOverrides(rules, { ...scope, path: "Projects/A.md", file: "inherit", comment: "inherit", recursive: false });
	expect(effectivePermission(policy(), rules, id(3), "Projects/A.md")).toMatchObject({ read: true, edit: true, comment: true });
	expect(effectivePermission({ ...policy(), members: [] }, rules, id(3), "Projects/A.md")).toMatchObject({ read: false, comment: false });
	expect(() => applyPermissionOverrides(rules, { ...scope, path: "../alias", file: "read", comment: "allow" })).toThrow();
});

test("three-way merge preserves independent remote changes but requires a choice for different edits to the same key", () => {
	const base = applyPermissionOverrides(empty(), { ...scope, file: "read", comment: "deny" });
	const mine = applyPermissionOverrides(base, { ...scope, file: "write", comment: "allow" });
	let remote = applyPermissionOverrides(base, { ...scope, file: "none", comment: "deny" });
	remote = applyPermissionOverrides(remote, { ...scope, user_id: id(4), file: "read", comment: "allow" });
	const result = mergePermissionRules(base, mine, remote);
	expect(result.conflicts).toHaveLength(1); expect(result.rules.file_rules.find(r => r.user_id === id(3))?.permission).toBe("none");
	expect(result.rules.file_rules.find(r => r.user_id === id(4))?.permission).toBe("read");
	expect(result.rules.comment_rules.find(r => r.user_id === id(3))?.allowed).toBe(true);
	const chosen = mergePermissionRules(base, mine, remote, new Map([[result.conflicts[0].id, "mine"]]));
	expect(chosen.rules.file_rules.find(r => r.user_id === id(3))?.permission).toBe("write");
	expect(mergePermissionRules(base, mine, mine).conflicts).toHaveLength(0);
	const removed = applyPermissionOverrides(base, { ...scope, file: "inherit", comment: "inherit" });
	expect(mergePermissionRules(base, removed, remote).conflicts).toHaveLength(1);
	expect(remote.file_rules.find(r => r.user_id === id(3))?.permission).toBe("none");
});

test("independent parent and child edits remain visible for effective-access review even when there is no structural conflict", () => {
	const mine = applyPermissionOverrides(empty(), { ...scope, file: "read", comment: "allow" });
	const remote = applyPermissionOverrides(empty(), { ...scope, path: "Projects/Exception.md", recursive: false, file: "write", comment: "deny" });
	const result = mergePermissionRules(empty(), mine, remote);
	expect(result.conflicts).toHaveLength(0);
	expect(effectivePermission(policy(), result.rules, id(3), "Projects/Exception.md")).toMatchObject({ read: true, edit: true, comment: false });
	expect(permissionChanges(remote, result.rules)).toHaveLength(2);
});
