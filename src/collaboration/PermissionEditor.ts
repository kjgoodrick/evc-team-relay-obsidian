import { parsePermissionRules, permissionPath, permissionRuleKey, type PermissionCommentRule, type PermissionFileRule, type PermissionPolicy, type PermissionRules } from "./PermissionPolicy";

export type PermissionScope = { user_id: string; path: string; recursive: boolean };
export type PermissionOverrides = PermissionScope & {
	file: "inherit" | PermissionFileRule["permission"];
	comment: "inherit" | "allow" | "deny";
};
export type PermissionChange = { id: string; kind: keyof PermissionRules; scope: PermissionScope; before?: PermissionFileRule | PermissionCommentRule; after?: PermissionFileRule | PermissionCommentRule };
export type PermissionConflict = PermissionChange & { current?: PermissionFileRule | PermissionCommentRule };
const kinds = ["file_rules", "comment_rules"] as const;
export const clonePermissionRules = (rules: PermissionRules): PermissionRules => parsePermissionRules(rules);

/** Only explicit opt-in removes narrower exceptions, and only for this member. */
export function narrowerPermissionScope(rule: PermissionScope, scope: PermissionScope): boolean {
	return scope.recursive && rule.user_id === scope.user_id &&
		((rule.path === scope.path && !rule.recursive) || rule.path !== scope.path && (scope.path === "" || rule.path.startsWith(scope.path + "/")));
}

export function applyPermissionOverrides(rules: PermissionRules, draft: PermissionOverrides, replaceNarrower = false): PermissionRules {
	if (!permissionPath(draft.path, draft.recursive)) throw new Error("Use a relative path without hidden segments; the whole share requires descendants.");
	const result = clonePermissionRules(rules), { user_id, path, recursive } = draft, scope = { user_id, path, recursive };
	const keep = (rule: PermissionScope) => permissionRuleKey(rule) !== permissionRuleKey(scope) && !(replaceNarrower && narrowerPermissionScope(rule, scope));
	result.file_rules = result.file_rules.filter(keep);
	result.comment_rules = result.comment_rules.filter(keep);
	if (draft.file !== "inherit") result.file_rules.push({ ...scope, permission: draft.file });
	if (draft.comment !== "inherit") result.comment_rules.push({ ...scope, allowed: draft.comment === "allow" });
	return parsePermissionRules(result);
}

export function permissionChanges(before: PermissionRules, after: PermissionRules): PermissionChange[] {
	const changes: PermissionChange[] = [];
	for (const kind of kinds) {
		const old = new Map(before[kind].map(r => [permissionRuleKey(r), r]));
		const next = new Map(after[kind].map(r => [permissionRuleKey(r), r]));
		for (const key of [...new Set([...old.keys(), ...next.keys()])].sort()) {
			const a = old.get(key), b = next.get(key);
			// Parsed rules have canonical field order, but callers need not.
			if (permissionValue(a) === permissionValue(b)) continue;
			const rule = b ?? a!;
			changes.push({ id: kind + key, kind, scope: { user_id: rule.user_id, path: rule.path, recursive: rule.recursive }, before: a, after: b });
		}
	}
	return changes;
}

export function permissionValue(rule?: PermissionFileRule | PermissionCommentRule): string {
	return !rule ? "Inherit" : "permission" in rule ? ({ none: "Hidden", read: "Read", write: "Edit" })[rule.permission] : rule.allowed ? "Allow comments" : "Deny comments";
}

/** Structural three-way merge. Always review the resulting effective policy:
 * independently edited parent/child rules can interact without sharing a key. */
export function mergePermissionRules(base: PermissionRules, proposed: PermissionRules, current: PermissionRules, choices: Map<string, "mine" | "current"> = new Map()): { rules: PermissionRules; conflicts: PermissionConflict[] } {
	const rules = clonePermissionRules(current), conflicts: PermissionConflict[] = [];
	for (const change of permissionChanges(base, proposed)) {
		const list = rules[change.kind] as (PermissionFileRule | PermissionCommentRule)[], key = permissionRuleKey(change.scope);
		const now = list.find(r => permissionRuleKey(r) === key);
		if (permissionValue(now) !== permissionValue(change.before) && permissionValue(now) !== permissionValue(change.after)) {
			conflicts.push({ ...change, current: now });
			if (choices.get(change.id) !== "mine") continue;
		}
		const index = list.findIndex(r => permissionRuleKey(r) === key);
		if (index >= 0) list.splice(index, 1);
		if (change.after) list.push({ ...change.after });
	}
	return { rules: parsePermissionRules(rules), conflicts };
}

export function effectivePermission(policy: PermissionPolicy, proposed: PermissionRules, userId: string, path: string): { read: boolean; edit: boolean; comment: boolean; explanation: string } {
	const member = policy.members.find(m => m.user_id === userId);
	const none = { read: false, edit: false, comment: false };
	if (!permissionPath(path, false)) return { ...none, explanation: "Enter an exact relative file path to preview access." };
	if (!member?.active) return { ...none, explanation: "This account is inactive or no longer a member. Rules cannot grant access." };
	if (member.administrator || userId === policy.owner_id) return { read: true, edit: true, comment: true, explanation: "Owners and server administrators keep full access." };
	const match = <T extends PermissionScope>(list: T[]): T | undefined => list.filter(r => r.user_id === userId && (r.path === path || r.recursive && (r.path === "" || path.startsWith(r.path + "/"))))
		.sort((a, b) => b.path.length - a.path.length || Number(a.recursive) - Number(b.recursive))[0];
	const file = match(proposed.file_rules), comment = match(proposed.comment_rules);
	const read = !!file && file.permission !== "none", edit = file?.permission === "write";
	const source = (r: PermissionScope) => `${r.path || "whole share"} (${r.recursive ? "with descendants" : "exact"})`;
	return { read, edit, comment: read && (comment ? comment.allowed : edit), explanation:
		`${file ? `File rule: ${source(file)}.` : "No file rule: hidden."} ${comment ? `Comment rule: ${source(comment)}.` : "No comment rule: editors may comment; readers may not."}${!read ? " Comment allowance cannot overcome hidden files." : ""}` };
}
