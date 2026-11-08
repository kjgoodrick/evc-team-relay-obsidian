import { platformFetch, type PlatformRequestInit } from "../platformFetch";
import { isId, isRecord, isSequence } from "./DiscussionProtocol";
import { restoreContext } from "./RestoreGeneration";

export type PermissionFileRule = { user_id: string; path: string; recursive: boolean; permission: "none" | "read" | "write" };
export type PermissionCommentRule = { user_id: string; path: string; recursive: boolean; allowed: boolean };
export type PermissionRules = { file_rules: PermissionFileRule[]; comment_rules: PermissionCommentRule[] };
export type PermissionPolicy = PermissionRules & {
	version: 1; share_id: string; actor_id: string; owner_id: string; revision: string; comment_revision: number;
	restore_guard?: boolean; restore_generation?: string | null;
	members: { user_id: string; email: string; active: boolean; administrator: boolean }[];
};
export type PermissionIdentity = { shareId: string; actorId: string };
const responseLimit = 8 * 1024 * 1024;

export class PermissionPolicyError extends Error {
	constructor(readonly code: "account_changed" | "authentication_required" | "forbidden" | "unavailable" | "changed" | "restore_changed" | "member_changed" | "invalid" | "unconfirmed", readonly status = 0) {
		super(code); this.name = "PermissionPolicyError";
	}
}

export function permissionPath(path: unknown, recursive: boolean): path is string {
	return typeof path === "string" && [...path].length <= 512 && path.normalize("NFC") === path &&
		// eslint-disable-next-line no-control-regex -- ACL paths must reject ASCII control characters, matching the server.
		(path === "" ? recursive : !/[\u0000-\u001f\\:]/.test(path) && path.split("/").every(part => !!part && !part.startsWith(".")));
}

export function permissionRuleKey(rule: { user_id: string; path: string; recursive: boolean }): string {
	return JSON.stringify([rule.user_id, rule.path, rule.recursive]);
}

export function parsePermissionRules(value: unknown): PermissionRules {
	if (!isRecord(value) || !Array.isArray(value.file_rules) || !Array.isArray(value.comment_rules) || value.file_rules.length > 1000 || value.comment_rules.length > 1000) throw new PermissionPolicyError("invalid");
	const common = (input: unknown) => {
		if (!isRecord(input) || !isId(input.user_id) || typeof input.recursive !== "boolean" || !permissionPath(input.path, input.recursive)) throw new PermissionPolicyError("invalid");
		return { user_id: input.user_id, path: input.path, recursive: input.recursive };
	};
	const file_rules = value.file_rules.map(input => {
		const rule = common(input);
		if (!isRecord(input) || typeof input.permission !== "string" || !["none", "read", "write"].includes(input.permission)) throw new PermissionPolicyError("invalid");
		return { ...rule, permission: input.permission as PermissionFileRule["permission"] };
	});
	const comment_rules = value.comment_rules.map(input => {
		const rule = common(input);
		if (!isRecord(input) || typeof input.allowed !== "boolean") throw new PermissionPolicyError("invalid");
		return { ...rule, allowed: input.allowed };
	});
	for (const rules of [file_rules, comment_rules]) if (new Set(rules.map(permissionRuleKey)).size !== rules.length) throw new PermissionPolicyError("invalid");
	return { file_rules, comment_rules };
}

export function parsePermissionPolicy(value: unknown, identity: PermissionIdentity): PermissionPolicy {
	if (!isRecord(value) || value.version !== 1 || value.actor_id !== identity.actorId || value.share_id !== identity.shareId || !isId(value.owner_id) ||
		typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || !isSequence(value.comment_revision) || !Array.isArray(value.members) || value.members.length > 10_000) throw new PermissionPolicyError("invalid");
	const members = value.members.map(member => {
		if (!isRecord(member) || !isId(member.user_id) || typeof member.email !== "string" || member.email.length > 512 || typeof member.active !== "boolean" || typeof member.administrator !== "boolean") throw new PermissionPolicyError("invalid");
		return { user_id: member.user_id, email: member.email, active: member.active, administrator: member.administrator };
	});
	if (new Set(members.map(m => m.user_id)).size !== members.length) throw new PermissionPolicyError("invalid");
	let restore;
	try { restore = restoreContext(value.restore_guard, value.restore_generation); } catch { throw new PermissionPolicyError("invalid"); }
	if (restore?.generation !== null && restore?.generation !== undefined && !restore.supported) throw new PermissionPolicyError("invalid");
	return { version: 1, share_id: identity.shareId, actor_id: identity.actorId, owner_id: value.owner_id, revision: value.revision, comment_revision: value.comment_revision, members, ...parsePermissionRules(value),
		...(restore ? { restore_guard: restore.supported, restore_generation: restore.generation } : {}) };
}

/** Online-only administrative transport. A failed/expired request is never
 * retried automatically: after an uncertain save, read and review current state. */
export class PermissionPolicyClient {
	readonly identity: Readonly<PermissionIdentity>;
	private readonly endpoint: string;
	constructor(base: string, identity: PermissionIdentity, private token: () => string | undefined | Promise<string | undefined>,
		private current: () => boolean, private fetcher: (url: string, init: PlatformRequestInit) => Promise<Response> = platformFetch) {
		if (!isId(identity.shareId) || !isId(identity.actorId)) throw new PermissionPolicyError("invalid");
		this.identity = Object.freeze({ ...identity });
		this.endpoint = base.replace(/\/+$/, "") + "/v1/collaboration/shares/" + identity.shareId + "/permissions";
	}
	read(): Promise<PermissionPolicy> { return this.request(); }
	save(observed: PermissionPolicy, proposed: PermissionRules): Promise<PermissionPolicy> {
		const snapshot = parsePermissionPolicy(observed, this.identity), rules = parsePermissionRules(proposed);
		return this.request(JSON.stringify({ version: 1, actor_id: this.identity.actorId, expected_revision: snapshot.revision, ...rules }), snapshot.restore_generation ?? null, snapshot.restore_guard === true);
	}
	private async request(body?: string, restoreGeneration: string | null = null, guarded = false): Promise<PermissionPolicy> {
		let expired = false, timer: number | undefined;
		const controller = new AbortController();
		const live = () => { if (expired) throw new PermissionPolicyError("unconfirmed"); if (!this.current()) throw new PermissionPolicyError("account_changed"); };
		const attempt = async () => {
			live(); let token: string | undefined;
			try { token = await this.token(); } catch { throw new PermissionPolicyError("authentication_required", 401); }
			live(); if (!token) throw new PermissionPolicyError("authentication_required", 401);
			let response: Response;
			try { response = await this.fetcher(body === undefined ? this.endpoint + "?actor_id=" + this.identity.actorId : this.endpoint,
				{ method: body === undefined ? "GET" : "PUT", sensitive: true, signal: controller.signal, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json",
					...(body !== undefined && restoreGeneration !== null ? { "X-Relay-Restore-Generation": restoreGeneration } : {}) }, body }); }
			catch { live(); throw new PermissionPolicyError("unconfirmed"); }
			live();
			let raw: string;
			try {
				const stated = response.headers.get("Content-Length");
				if (stated && Number(stated) > responseLimit) throw new PermissionPolicyError("invalid");
				if (response.body) {
					const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0; raw = "";
					try { for (;;) { const chunk = await reader.read(); live(); if (chunk.done) break;
						bytes += chunk.value.byteLength; if (bytes > responseLimit) throw new PermissionPolicyError("invalid"); raw += decoder.decode(chunk.value, { stream: true });
					} raw += decoder.decode(); } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
				} else { raw = await response.text(); if (new TextEncoder().encode(raw).byteLength > responseLimit) throw new PermissionPolicyError("invalid"); }
			} catch (error) { live(); if (error instanceof PermissionPolicyError) throw error; throw new PermissionPolicyError("unconfirmed"); }
			live(); let value: unknown;
			try { value = JSON.parse(raw); } catch { if (response.ok) throw new PermissionPolicyError("invalid"); }
			if (!response.ok) {
				const message = isRecord(value) && isRecord(value.error) ? value.error.message : undefined;
				if (response.status === 409 && isRecord(message) && message.code === "restore_generation_changed") throw new PermissionPolicyError("restore_changed", 409);
				throw new PermissionPolicyError(response.status === 401 ? "authentication_required" : response.status === 403 ? (message === "permission_editor_account_changed" ? "account_changed" : "forbidden") :
					response.status === 404 ? "unavailable" : response.status === 409 ? (message === "permission_member_changed" ? "member_changed" : "changed") :
					response.status === 400 || response.status === 422 ? "invalid" : "unconfirmed", response.status);
			}
			const result = parsePermissionPolicy(value, this.identity);
			if (body !== undefined && ((result.restore_generation ?? null) !== restoreGeneration || guarded && result.restore_guard !== true)) throw new PermissionPolicyError("unconfirmed");
			return result;
		};
		try { return await Promise.race([attempt(), new Promise<never>((_, reject) => {
			timer = window.setTimeout(() => { expired = true; reject(new PermissionPolicyError("unconfirmed")); }, 15_000);
		})]); } finally { if (timer !== undefined) window.clearTimeout(timer); expired = true; controller.abort(); }
	}
}
