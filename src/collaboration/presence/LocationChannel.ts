import { BASE_REGISTRY_RESPONSE_LIMIT, parseBaseRegistry } from "../../bases/BaseRegistryProtocol";
import type { InlineBaseSourceRequest } from "../../bases/InlineBaseAnchors";
import { decodeJwt } from "jose";
import { v4 as uuid } from "uuid";
import { platformFetch, type PlatformRequestInit } from "../../platformFetch";
import { parseRetryAfterMs, RelayHttpError } from "../../relayRequestErrors";
import { isRecord } from "../DiscussionProtocol";
import { parseBasePresenceContext, type BasePresenceContext } from "./BasePresenceProtocol";
import { baseStateForVersion, parseBaseState, parseBasePeers, parseBaseRecordContext, type BaseRecordContext, type BasePresenceState, type BaseStatesEvent } from "./BasePositionProtocol";
import { parseEmbeddedImage, parseEmbeddedPeers, type EmbeddedImage, type EmbeddedImagesEvent } from "./EmbeddedImageProtocol";
import { parseImageState, parseImagePeers, type ImagePresenceState, type ImageStatesEvent } from "./LocationProtocol";
import { exactFields, locationId, parseLocationTarget, parseNoteLocation, parseSurfaceLocation, parseSurfacePeers, publicSessionId, type ImageLocation, type LocationEvent, type LocationTarget, type NonNoteLocation, type SurfaceLocation, type SurfaceRosterEvent } from "./LocationProtocol";

export type LocationChannelStatus = "idle" | "connecting" | "ready" | "reconnecting" | "unsupported" | "authentication" | "unavailable";
export type LocationIdentity = Readonly<{ serverUrl: string; accountId: string; loginSessionId: string; instanceId: string }>;
export type ObservationEvent =
	| ({ type: "roster" } & SurfaceRosterEvent)
	| ({ type: "image_states" } & ImageStatesEvent)
	| ({ type: "image_embeds" } & EmbeddedImagesEvent)
	| ({ type: "base_states" } & BaseStatesEvent)
	| { type: "reset"; scope: SurfaceLocation | null };
type Observation = { scope: SurfaceLocation; id?: string; denied: boolean };
const MAX_OBSERVATIONS = 8;
type Credential = { accountId: string; accessToken: string };
type Options = {
	credential: () => Promise<Credential | undefined>;
	status?: (status: LocationChannelStatus) => void;
	location?: (event: LocationEvent) => void;
	followStopped?: () => void;
	/** Enable only when the host has adapters for the extended location model. */
	surfaceLocations?: boolean;
	roster?: (event: SurfaceRosterEvent) => void;
	imageStates?: (event: ImageStatesEvent) => void;
	imageEmbeds?: (event: EmbeddedImagesEvent) => void;
	baseStates?: (event: BaseStatesEvent) => void;
	observation?: (event: ObservationEvent) => void;
	fetcher?: (url: string, init: PlatformRequestInit) => Promise<Response>;
	socket?: (url: string) => WebSocket;
	random?: () => number;
};
class ChannelFailure extends Error {
	constructor(readonly status: Exclude<LocationChannelStatus, "idle" | "connecting" | "ready">, readonly retryAfter = 0) { super(status); }
}
const expiry = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > Date.now() / 1000;

/** One ephemeral connection per foreground instance/account. No activity history,
 * durable outbox, raw diagnostics or extra note synchronization sockets. */
export class LocationChannel {
	readonly identity: LocationIdentity;
	status: LocationChannelStatus = "idle";
	private active = false;
	private version = 0;
	private shareId?: string;
	private desired: SurfaceLocation | null = null;
	private protocolVersion: 1 | 2 = 1;
	private rosterSupported = false;
	private imageContextSupported = false;
	private baseContextSupported = false;
	private baseStatesSupported = false;
	private baseTargetsV2Supported = false;
	private baseTargetsV3Supported = false;
	private desiredBaseState: BasePresenceState | null = null;
	private imageStatesSupported = false;
	private embedsSupported = false;
	private desiredEmbed: EmbeddedImage | null = null;
	private desiredImageState: ImagePresenceState | null = null;
	private sentImageState?: string;
	private imageTimer?: number;
	private lastImageSent = 0;
	private multiWatchSupported = false;
	private observations = new Map<string, Observation>();
	private desiredWatch: SurfaceLocation | null = null;
	private watching?: { id: string; scope: SurfaceLocation };
	private sentWatch?: string;
	private sent?: string;
	private ws?: WebSocket;
	private subscription?: string;
	private retryTimer?: number;
	private heartbeat?: number;
	private refreshTimer?: number;
	private deadline?: number;
	private publishTimer?: number;
	private watchTimer?: number;
	private requests = new Set<() => void>();
	private attempts = 0;
	private lastReceived = 0;
	private renewing = false;
	private fetcher: NonNullable<Options["fetcher"]>;
	private makeSocket: NonNullable<Options["socket"]>;

	constructor(identity: LocationIdentity, private options: Options) {
		const url = new URL(identity.serverUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
			![identity.accountId, identity.loginSessionId, identity.instanceId].every(locationId)) throw new Error("Invalid location channel configuration");
		this.identity = Object.freeze({ ...identity, serverUrl: url.toString().replace(/\/+$/, "") });
		this.fetcher = options.fetcher ?? platformFetch;
		this.makeSocket = options.socket ?? (url => new WebSocket(url));
	}
	get ready(): boolean { return this.active && this.status === "ready"; }
	get supportsSurfaceLocations(): boolean { return this.ready && this.protocolVersion === 2; }
	get supportsSurfaceRoster(): boolean { return this.supportsSurfaceLocations && this.rosterSupported; }
	get supportsImageContext(): boolean { return this.supportsSurfaceLocations && this.imageContextSupported; }
	get supportsBaseContext(): boolean { return this.supportsSurfaceLocations && this.baseContextSupported; }
	get supportsBaseStates(): boolean { return this.supportsSurfaceRoster && this.supportsBaseContext && this.baseStatesSupported; }
	get supportsBaseTargetsV2(): boolean { return this.supportsBaseStates && this.baseTargetsV2Supported; }
	get supportsBaseTargetsV3(): boolean { return this.supportsBaseTargetsV2 && this.baseTargetsV3Supported; }
	get supportsImageStates(): boolean { return this.supportsSurfaceRoster && this.imageStatesSupported; }
	get supportsMultiWatch(): boolean { return this.supportsSurfaceLocations && this.multiWatchSupported; }
	get supportsEmbeddedImages(): boolean { return this.supportsSurfaceLocations && this.embedsSupported; }
	publishBaseState(state: BasePresenceState | null): void {
		const next = state === null ? null : parseBaseState(state);
		if (JSON.stringify(next) === JSON.stringify(this.desiredBaseState)) return;
		this.desiredBaseState = next;
		if (this.supportsBaseStates && this.desired?.kind === "base") this.queueImageMovement(next === null);
	}
	publishEmbeddedImage(embed: EmbeddedImage | null): void {
		const next = embed === null ? null : parseEmbeddedImage(embed);
		if (JSON.stringify(next) === JSON.stringify(this.desiredEmbed)) return;
		this.desiredEmbed = next;
		if (this.supportsEmbeddedImages && this.desired?.kind === "note") this.queueImageMovement(next === null);
	}
	/** Latest state only; never persisted or replayed after reconnect. */
	publishImageState(state: ImagePresenceState | null): void {
		const next = state === null ? null : parseImageState(state);
		if (JSON.stringify(next) === JSON.stringify(this.desiredImageState)) return;
		this.desiredImageState = next;
		if (!this.supportsImageStates || this.desired?.kind !== "image") return;
		this.queueImageMovement(next === null);
	}
	private queueImageMovement(clear: boolean): void {
		if (clear) { if (this.imageTimer !== undefined) window.clearTimeout(this.imageTimer); this.imageTimer = undefined; this.flushImageState(); }
		else if (this.imageTimer === undefined) {
			const delay = Math.max(0, 125 - (Date.now() - this.lastImageSent));
			if (!delay) this.flushImageState();
			else this.imageTimer = window.setTimeout(() => { this.imageTimer = undefined; this.flushImageState(); }, delay);
		}
	}
	async readImageLocation(shareId: string, entryId: string): Promise<ImageLocation> {
		if (!this.supportsImageContext || !locationId(shareId) || !locationId(entryId)) throw new Error("Image presence unavailable");
		const version = this.version, value = await this.request(`/image-location?share_id=${shareId}&entry_id=${entryId}`, version);
		if (!this.current(version) || !this.ready || !isRecord(value) || !exactFields(value, ["protocol_version", "location"]) || value.protocol_version !== 1) throw new Error("Image presence unavailable");
		const location = parseSurfaceLocation(value.location);
		if (location.kind !== "image" || location.share_id !== shareId || location.entry_id !== entryId) throw new Error("Invalid image location");
		return location;
	}
	async readBaseContext(shareId: string, entryId: string, definitionId?: string): Promise<BasePresenceContext> {
		if (!this.supportsBaseContext || !locationId(shareId) || !locationId(entryId) || definitionId !== undefined && !locationId(definitionId)) throw new Error("Bases presence unavailable");
		const version = this.version, value = await this.request(`/base-context?share_id=${shareId}&entry_id=${entryId}${this.supportsBaseTargetsV3 ? "&base_target_version=3" : ""}${definitionId ? "&definition_id=" + definitionId : ""}`, version, false, 192 * 1024);
		if (!this.current(version) || !this.supportsBaseContext) throw new Error("Bases presence unavailable");
		const context = parseBasePresenceContext(value, shareId, entryId);
		if (definitionId && context.definition_id !== definitionId) throw new Error("Inline Bases definition changed");
		return context;
	}
	async readInlineBaseContext(shareId: string, entryId: string, source: InlineBaseSourceRequest, current: () => boolean): Promise<BasePresenceContext> {
		if (!this.supportsBaseContext || ![shareId, entryId].every(locationId) || !current()) throw new Error("Inline Bases presence unavailable");
		const version = this.version;
		const value = await this.request(`/shares/${shareId}/entries/${entryId}/anchor-context`, version);
		if (!this.current(version) || !current() || !isRecord(value) || value.protocol_version !== 1 || value.entry_id !== entryId || !locationId(value.generation)) throw new Error("Inline Bases presence unavailable");
		const registry = await this.inspectInlineBase(shareId, entryId, value.generation, source, current);
		const context = await this.readBaseContext(shareId, entryId, registry.definition_id);
		if (!current() || !this.current(version) || context.generation !== registry.generation || context.registry_revision !== registry.revision || context.content_sha256 !== registry.content_sha256) throw new Error("Inline Bases presence changed");
		return context;
	}
	/** Register the verified fence identity with read permission only. Presence
	 * must not depend on a discussion session or on comments being enabled. */
	async inspectInlineBase(shareId: string, entryId: string, generation: string, source: InlineBaseSourceRequest, current: () => boolean) {
		if (!this.supportsBaseContext || ![shareId, entryId, generation].every(locationId) || !current()) throw new Error("Inline Bases presence unavailable");
		const version = this.version;
		const value = await this.request(`/shares/${shareId}/entries/${entryId}/bases/inline-inspect`, version, true, BASE_REGISTRY_RESPONSE_LIMIT,
			{ generation, source });
		if (!this.current(version) || !this.supportsBaseContext || !current()) throw new Error("Inline Bases presence unavailable");
		return parseBaseRegistry(value, entryId, undefined, generation);
	}
	async readBaseRecordContext(shareId: string, entryId: string): Promise<BaseRecordContext> {
		if (!this.supportsBaseStates || !locationId(shareId) || !locationId(entryId)) throw new Error("Bases position unavailable");
		const version = this.version, value = await this.request(`/base-record-context?share_id=${shareId}&entry_id=${entryId}`, version);
		if (!this.current(version) || !this.supportsBaseStates) throw new Error("Bases position unavailable");
		return parseBaseRecordContext(value, shareId, entryId);
	}
	/** The caller supplies a currently authorized foreground share for discovery. */
	start(shareId: string, location: SurfaceLocation | null): void {
		if (!locationId(shareId)) throw new Error("Invalid location context");
		this.shareId = shareId;
		this.publish(location);
		if (this.active) return;
		this.active = true; this.attempts = 0; void this.connect();
	}
	publish(location: SurfaceLocation | null): void {
		const next = location === null ? null : this.options.surfaceLocations ? parseSurfaceLocation(location) : parseNoteLocation(location);
		if (JSON.stringify(this.desired) === JSON.stringify(next)) return;
		this.desiredImageState = null; this.desiredEmbed = null; this.desiredBaseState = null; this.sentImageState = undefined; this.lastImageSent = 0;
		if (this.imageTimer !== undefined) window.clearTimeout(this.imageTimer); this.imageTimer = undefined;
		this.desired = next;
		if (this.publishTimer !== undefined) window.clearTimeout(this.publishTimer);
		this.publishTimer = undefined;
		if (this.status !== "ready") return;
		if (next === null) this.flushPresence();
		else this.publishTimer = window.setTimeout(() => { this.publishTimer = undefined; this.flushPresence(); }, 120);
	}
	follow(target: LocationTarget, from: SurfaceLocation): string | undefined {
		const person = parseLocationTarget(target), source = this.options.surfaceLocations ? parseSurfaceLocation(from) : parseNoteLocation(from);
		if (!this.active || this.status !== "ready" || source.kind !== "note" && this.protocolVersion !== 2) return;
		this.unfollow();
		const id = this.subscription = uuid();
		if (!this.send({ type: "follow", subscription_id: id, target: person, from: source })) return;
		return id;
	}
	/** Observe one authorized foreground non-note context. Observation does not
	 * publish this user's presence and is retained across transport reconnects. */
	watch(location: NonNoteLocation | null): void {
		const next = location === null ? null : parseSurfaceLocation(location);
		if (next && (!this.options.surfaceLocations || next.kind === "note")) throw new Error("Unsupported presence scope");
		this.setWatch(next);
	}
	watchEmbeds(location: import("./LocationProtocol").NoteLocation | null): void {
		if (!this.options.surfaceLocations) throw new Error("Unsupported presence scope");
		this.setWatch(location === null ? null : parseNoteLocation(location));
	}
	/** Up to eight additional scopes share the existing connection. Ordinary
	 * refreshes preserve denied subscriptions until explicit retry/reconnect. */
	observe(locations: readonly SurfaceLocation[]): void {
		if (!this.options.surfaceLocations || !this.options.observation) throw new Error("Unsupported presence observations");
		const wanted = new Map<string, SurfaceLocation>();
		for (const value of locations) {
			const parsed = parseSurfaceLocation(value);
			const scope = parsed.kind === "note" ? { ...parsed, surface: "reading" as const } : parsed;
			wanted.set(JSON.stringify(scope), scope);
		}
		if (wanted.size > MAX_OBSERVATIONS) throw new Error("Too many presence observations");
		for (const [key, observation] of this.observations) if (!wanted.has(key)) {
			this.observations.delete(key);
			if (observation.id && this.ready) this.send({ type: "unobserve", subscription_id: observation.id });
			this.emitObservation({ type: "reset", scope: observation.scope });
		}
		for (const [key, scope] of wanted) if (!this.observations.has(key)) this.observations.set(key, { scope, denied: false });
		this.scheduleWatches();
	}
	/** Pane and mode transitions can synchronously replace several scopes.
	 * Withdraw obsolete subscriptions immediately, but subscribe only to the
	 * settled desired set so transient views do not exhaust the server budget. */
	private scheduleWatches(): void {
		if (!this.ready || this.watchTimer !== undefined) return;
		this.watchTimer = window.setTimeout(() => {
			this.watchTimer = undefined; this.flushWatch(); this.flushObservations();
		}, 120);
	}
	private emitObservation(event: ObservationEvent): void {
		try { this.options.observation?.(event); } catch { /* Isolate UI. */ }
	}
	private flushObservations(): void {
		if (!this.supportsMultiWatch) return;
		for (const observation of this.observations.values()) {
			if (observation.id || observation.denied) continue;
			const scope = observation.scope;
			if (scope.kind === "note" ? !this.supportsEmbeddedImages : !this.supportsSurfaceRoster) continue;
			const id = uuid(); observation.id = id;
			if (!this.send({ type: "observe", subscription_id: id, location: scope,
				...(scope.kind === "image" && this.supportsImageStates ? { image_states: true } : {}),
				...(scope.kind === "base" && this.supportsBaseStates ? { base_states: true, ...(this.supportsBaseTargetsV2 ? { base_target_version: this.supportsBaseTargetsV3 ? 3 : 2 } : {}) } : {}) })) return;
		}
	}
	private setWatch(next: SurfaceLocation | null): void {
		if (JSON.stringify(next) === JSON.stringify(this.desiredWatch)) return;
		this.desiredWatch = next;
		const previous = this.watching; this.watching = undefined;
		this.emitRoster(null, "unavailable");
		if (previous && this.ready) this.send({ type: "unwatch", subscription_id: previous.id });
		this.sentWatch = undefined;
		this.scheduleWatches();
	}
	unfollow(): void {
		const id = this.subscription; this.subscription = undefined;
		if (id && this.status === "ready") this.send({ type: "unfollow", subscription_id: id });
	}
	/** Explicit retry or an authentication lifecycle event, never ordinary cursor updates. */
	retry(): void {
		if (this.ready) {
			if (this.desiredWatch && !this.watching) { this.sentWatch = undefined; this.flushWatch(); }
			for (const observation of this.observations.values()) observation.denied = false;
			this.flushObservations(); return;
		}
		if (!this.active || this.status === "connecting" || this.status === "ready") return;
		if (this.retryTimer !== undefined) window.clearTimeout(this.retryTimer);
		this.retryTimer = undefined; this.attempts = 0; void this.connect();
	}
	credentialsChanged(): void {
		if (this.status === "ready") void this.renew(this.version);
		else if (this.status === "authentication") this.retry();
	}
	stop(): void {
		this.active = false; this.version++;
		this.drop(); this.observations.clear(); this.desired = null; this.desiredWatch = null; this.shareId = undefined; this.setStatus("idle");
	}
	private setStatus(status: LocationChannelStatus): void {
		if (this.status === status) return;
		this.status = status; try { this.options.status?.(status); } catch { /* Isolate UI. */ }
	}
	private current(version: number): boolean { return this.active && version === this.version; }
	private drop(): void {
		for (const timer of [this.retryTimer, this.heartbeat, this.refreshTimer, this.deadline, this.publishTimer, this.imageTimer, this.watchTimer]) if (timer !== undefined) window.clearTimeout(timer);
		this.imageTimer = undefined; this.desiredImageState = null; this.desiredEmbed = null; this.sentImageState = undefined; this.imageStatesSupported = false; this.embedsSupported = false; this.lastImageSent = 0;
		this.desiredBaseState = null; this.baseStatesSupported = false; this.baseTargetsV2Supported = false; this.baseTargetsV3Supported = false;
		this.retryTimer = this.heartbeat = this.refreshTimer = this.deadline = this.publishTimer = this.watchTimer = undefined;
		for (const cancel of this.requests) cancel(); this.requests.clear();
		// Native HTTP may finish independently; generation checks fence every late
		// credential, response and callback. Do not retain timers or a live socket.
		this.renewing = false; this.sent = undefined;
		this.watching = undefined; this.sentWatch = undefined; this.protocolVersion = 1; this.rosterSupported = false; this.imageContextSupported = false; this.baseContextSupported = false;
		this.multiWatchSupported = false;
		for (const observation of this.observations.values()) { observation.id = undefined; observation.denied = false; }
		this.emitObservation({ type: "reset", scope: null });
		this.emitRoster(null, "unavailable");
		const ws = this.ws; this.ws = undefined;
		if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* Already closed. */ } }
		if (this.subscription) { this.subscription = undefined; try { this.options.followStopped?.(); } catch { /* Isolate UI. */ } }
	}
	private fail(status: LocationChannelStatus = "reconnecting", retryAfter = 0): void {
		if (!this.active) return;
		this.version++; this.drop(); this.setStatus(status);
		if (this.active && status === "reconnecting") {
			const jitter = 0.8 + (this.options.random?.() ?? Math.random()) * 0.4;
			const delay = Math.max(Math.min(120_000, retryAfter), Math.min(30_000, 1000 * 2 ** Math.min(5, this.attempts++)) * jitter);
			this.retryTimer = window.setTimeout(() => { this.retryTimer = undefined; void this.connect(); }, delay);
		}
	}
	private async request(path: string, version: number, post = false, limit = 65_536, inlineSource?: { generation: string; source: InlineBaseSourceRequest }): Promise<unknown> {
		let timer: number | undefined, ended = false, cancel: (() => void) | undefined;
		const current = () => !ended && this.current(version);
		const attempt = async () => {
			let credential: Credential | undefined;
			try { credential = await this.options.credential(); } catch { throw new ChannelFailure("authentication"); }
			if (!current()) throw new ChannelFailure("unavailable");
			try {
				const claims = credential && decodeJwt(credential.accessToken);
				if (!credential || credential.accountId !== this.identity.accountId || claims?.sub !== this.identity.accountId ||
					claims.session_id !== this.identity.loginSessionId || claims.scope !== undefined || !expiry(claims.exp)) throw new Error();
			} catch { throw new ChannelFailure("authentication"); }
			let response: Response;
			try { response = await this.fetcher(this.identity.serverUrl + "/v1/collaboration" + path, {
				method: post ? "POST" : "GET", sensitive: true, headers: { Authorization: "Bearer " + credential.accessToken, ...(inlineSource ? { "Content-Type": "application/json" } : {}) },
				...(inlineSource ? { body: JSON.stringify(inlineSource) } : {}),
			}); } catch (error) { throw new ChannelFailure("reconnecting", error instanceof RelayHttpError ? error.retryAfterMs : 0); }
			if (!current()) throw new ChannelFailure("unavailable");
			if ([401, 403].includes(response.status)) throw new ChannelFailure("authentication");
			if (response.status === 404) throw new ChannelFailure("unsupported");
			if (response.status === 408 || response.status === 429 || response.status >= 500) throw new ChannelFailure("reconnecting", parseRetryAfterMs(response.headers.get("Retry-After")));
			if (!response.ok) throw new ChannelFailure("unavailable");
			const raw = await response.text();
			if (!current() || raw.length > limit || new TextEncoder().encode(raw).length > limit) throw new ChannelFailure("unavailable");
			try { return JSON.parse(raw) as unknown; } catch { throw new ChannelFailure("unavailable"); }
		};
		try {
			return await Promise.race([attempt(), new Promise<never>((_, reject) => {
				timer = window.setTimeout(() => reject(new ChannelFailure("reconnecting")), 20_000);
				cancel = () => { ended = true; if (timer !== undefined) window.clearTimeout(timer); reject(new ChannelFailure("unavailable")); };
				this.requests.add(cancel);
			})]);
		} finally { ended = true; if (timer !== undefined) window.clearTimeout(timer); if (cancel) this.requests.delete(cancel); }
	}
	private async ticket(version: number): Promise<string> {
		const value = await this.request("/socket-ticket", version, true);
		if (!isRecord(value) || value.protocol_version !== 1 || value.socket_path !== "/v1/collaboration/events" ||
			value.expires_in !== 30 || typeof value.ticket !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.ticket)) throw new ChannelFailure("unavailable");
		return value.ticket;
	}
	private async connect(): Promise<void> {
		if (!this.active || !this.shareId) return;
		const version = ++this.version; this.drop(); this.setStatus("connecting");
		try {
			const capability = await this.request("/capabilities?share_id=" + this.shareId, version);
			if (!this.current(version)) return;
			if (!isRecord(capability) || capability.protocol_version !== 1 || !isRecord(capability.features)) throw new ChannelFailure("unavailable");
			const enabled = capability.features.presence_locations_preview;
			if (enabled === false || enabled === undefined) throw new ChannelFailure("unsupported");
			if (enabled !== true) throw new ChannelFailure("unavailable");
			if (this.options.surfaceLocations) {
				const extended = capability.features.presence_surface_locations_preview, roster = capability.features.presence_surface_roster_preview, image = capability.features.presence_image_context_preview, states = capability.features.presence_image_states_preview, embeds = capability.features.presence_embedded_images_preview;
				const base = capability.features.presence_base_context_preview, baseStates = capability.features.presence_base_states_preview;
				const formulaTargets = capability.features.presence_base_targets_v3_preview;
				const baseTargets = capability.features.presence_base_targets_v2_preview, multiWatch = capability.features.presence_multi_watch_preview;
				if (multiWatch !== undefined && typeof multiWatch !== "boolean" || multiWatch === true && extended !== true) throw new ChannelFailure("unavailable");
				if (formulaTargets !== undefined && typeof formulaTargets !== "boolean" || formulaTargets === true && baseTargets !== true) throw new ChannelFailure("unavailable");
				if (baseTargets !== undefined && typeof baseTargets !== "boolean" || baseTargets === true && baseStates !== true) throw new ChannelFailure("unavailable");
				if ([extended, roster, image, states, embeds, base, baseStates].some(value => value !== undefined && typeof value !== "boolean") || (roster === true || image === true || states === true || embeds === true || base === true || baseStates === true) && extended !== true || (states === true || baseStates === true) && roster !== true || baseStates === true && base !== true) throw new ChannelFailure("unavailable");
				this.protocolVersion = extended === true ? 2 : 1;
				this.rosterSupported = roster === true;
				this.imageContextSupported = image === true;
				this.baseContextSupported = base === true;
				this.baseStatesSupported = baseStates === true;
				this.baseTargetsV2Supported = baseTargets === true; this.baseTargetsV3Supported = formulaTargets === true;
				this.imageStatesSupported = states === true;
				this.embedsSupported = embeds === true;
				this.multiWatchSupported = multiWatch === true;
			}
			const ticket = await this.ticket(version);
			if (!this.current(version)) return;
			const url = new URL(this.identity.serverUrl + "/v1/collaboration/events"); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const ws = this.ws = this.makeSocket(url.toString());
			this.deadline = window.setTimeout(() => { if (this.current(version)) this.fail(); }, 10_000);
			ws.onopen = () => { if (this.current(version)) this.send({ type: "authenticate", ticket, instance_id: this.identity.instanceId, ...(this.protocolVersion === 2 ? { protocol_version: 2 } : {}) }); };
			ws.onmessage = event => { if (this.current(version)) this.receive(event.data); };
			ws.onerror = () => { if (this.current(version)) this.fail(); };
			ws.onclose = event => { if (this.current(version)) this.fail(event.code === 4400 ? "unavailable" : event.code === 4403 ? "authentication" : "reconnecting", event.code === 4429 ? 30_000 : 0); };
		} catch (error) { if (this.current(version)) this.fail(error instanceof ChannelFailure ? error.status : "reconnecting", error instanceof ChannelFailure ? error.retryAfter : 0); }
	}
	private send(value: object): boolean {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) return false;
		if (ws.bufferedAmount > 8192) { this.fail(); return false; }
		try { ws.send(JSON.stringify(value)); return true; } catch { this.fail(); return false; }
	}
	private flushPresence(): void {
		if (this.status !== "ready") return;
		const location = this.protocolVersion === 1 && this.desired?.kind !== "note" ? null : this.desired;
		const encoded = JSON.stringify(location);
		if (encoded !== this.sent && this.send({ type: "presence", location })) this.sent = encoded;
		this.flushImageState();
	}
	private flushImageState(): void {
		if (this.sent !== JSON.stringify(this.desired) || !(this.supportsImageStates && this.desired?.kind === "image" || this.supportsEmbeddedImages && this.desired?.kind === "note" || this.supportsBaseStates && this.desired?.kind === "base")) return;
		const embedded = this.desired?.kind === "note", base = this.desired?.kind === "base";
		const baseState = this.desiredBaseState && baseStateForVersion(this.desiredBaseState, this.supportsBaseTargetsV3 ? 3 : this.supportsBaseTargetsV2 ? 2 : 1);
		const state = embedded ? this.desiredEmbed : base ? baseState : this.desiredImageState;
		const encoded = JSON.stringify(state);
		// A new publication starts with no state on the server.
		if (this.sentImageState === undefined && state === null) { this.sentImageState = encoded; return; }
		if (encoded !== this.sentImageState && this.send(embedded ? { type: "image_embed", location: this.desired, embed: state } : { type: base ? "base_state" : "image_state", location: this.desired, state })) { this.sentImageState = encoded; this.lastImageSent = Date.now(); }
	}
	private emitRoster(scope: NonNoteLocation | null, status: SurfaceRosterEvent["status"], peers: SurfaceRosterEvent["peers"] = []): void {
		if (status === "unavailable") { this.emitImageStates(null, "unavailable"); this.emitEmbeddedImages(null, "unavailable"); this.emitBaseStates(null, "unavailable"); }
		try { this.options.roster?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private emitImageStates(scope: ImageLocation | null, status: ImageStatesEvent["status"], peers: ImageStatesEvent["peers"] = []): void {
		try { this.options.imageStates?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private emitEmbeddedImages(scope: EmbeddedImagesEvent["scope"], status: EmbeddedImagesEvent["status"], peers: EmbeddedImagesEvent["peers"] = []): void {
		try { this.options.imageEmbeds?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private emitBaseStates(scope: BaseStatesEvent["scope"], status: BaseStatesEvent["status"], peers: BaseStatesEvent["peers"] = []): void {
		try { this.options.baseStates?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private flushWatch(): void {
		if (!this.desiredWatch || this.sentWatch === JSON.stringify(this.desiredWatch)) return;
		if (this.desiredWatch.kind === "note" ? !this.supportsEmbeddedImages || !this.options.imageEmbeds : !this.supportsSurfaceRoster) return;
		const scope = this.desiredWatch, id = uuid(); this.watching = { id, scope };
		if (this.send({ type: scope.kind === "note" ? "watch_embeds" : "watch", subscription_id: id, location: scope, ...(scope.kind === "image" && this.supportsImageStates && this.options.imageStates ? { image_states: true } : {}), ...(scope.kind === "base" && this.supportsBaseStates && this.options.baseStates ? { base_states: true, ...(this.supportsBaseTargetsV2 ? { base_target_version: this.supportsBaseTargetsV3 ? 3 : 2 } : {}) } : {}) })) this.sentWatch = JSON.stringify(scope);
	}
	private receive(raw: unknown): void {
		try {
			const limit = this.supportsBaseTargetsV2 ? 512 * 1024 : this.rosterSupported || this.embedsSupported ? 192 * 1024 : 4096;
			if (typeof raw !== "string" || raw.length > limit) throw new Error();
			const bytes = new TextEncoder().encode(raw).length;
			if (bytes > limit) throw new Error();
			const value: unknown = JSON.parse(raw);
			if (isRecord(value) && value.type !== "base_states" && bytes > 192 * 1024) throw new Error();
			if (!isRecord(value) || !["roster", "image_states", "image_embeds", "base_states"].includes(String(value.type)) && bytes > 4096) throw new Error();
			if (value.type === "ready") {
				if (this.status !== "connecting" || !exactFields(value, ["type", "protocol_version", "session_id", "instance_id", "expires_at"]) ||
					value.protocol_version !== this.protocolVersion || value.instance_id !== this.identity.instanceId || !publicSessionId(value.session_id) || !expiry(value.expires_at)) throw new Error();
				if (this.deadline !== undefined) window.clearTimeout(this.deadline); this.deadline = undefined;
				this.lastReceived = Date.now(); this.attempts = 0; this.setStatus("ready"); this.flushPresence();
				this.flushWatch(); this.flushObservations();
				if (!this.ready) return;
				this.armRefresh(value.expires_at); this.beat();
			} else {
				if (this.status !== "ready") throw new Error();
				const observed = [...this.observations.values()].find(observation => observation.id !== undefined && observation.id === value.subscription_id);
				if (value.type === "authenticated") {
					if (!this.renewing || !exactFields(value, ["type", "expires_at"]) || !expiry(value.expires_at)) throw new Error();
					this.renewing = false; if (this.deadline !== undefined) window.clearTimeout(this.deadline); this.deadline = undefined; this.armRefresh(value.expires_at);
				} else if (value.type === "pong") { if (!exactFields(value, ["type"])) throw new Error(); }
				else if (value.type === "following") { if (!exactFields(value, ["type", "subscription_id"]) || !locationId(value.subscription_id)) throw new Error(); }
				else if (value.type === "location") {
					const available = value.status === "available";
					if (!locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "location"] : ["type", "subscription_id", "status"])) throw new Error();
					const location = available ? (this.protocolVersion === 2 ? parseSurfaceLocation(value.location) : parseNoteLocation(value.location)) : null;
					if (value.subscription_id === this.subscription) {
						if (!available) this.subscription = undefined;
						try { this.options.location?.({ subscriptionId: value.subscription_id, location }); } catch { /* Isolate UI. */ }
					}
				} else if (value.type === "image_embeds") {
					const available = value.status === "available";
					if (!this.supportsEmbeddedImages || (!this.options.imageEmbeds && !this.options.observation) || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseEmbeddedPeers(value.peers) : [];
					if (observed) {
						if (observed.scope.kind !== "note") throw new Error();
						if (!available) { observed.id = undefined; observed.denied = true; }
						this.emitObservation({ type: "image_embeds", scope: observed.scope, status: available ? "available" : "unavailable", peers });
					} else if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope; if (scope.kind !== "note") throw new Error();
						if (!available) this.watching = undefined;
						this.emitEmbeddedImages(scope, available ? "available" : "unavailable", peers);
					}
				} else if (value.type === "base_states") {
					const available = value.status === "available";
					if (!this.supportsBaseStates || (!this.options.baseStates && !this.options.observation) || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseBasePeers(value.peers) : [];
					if (peers.some(peer => peer.state.version > (this.supportsBaseTargetsV3 ? 3 : this.supportsBaseTargetsV2 ? 2 : 1))) throw new Error();
					if (observed) {
						if (observed.scope.kind !== "base") throw new Error();
						if (!available) { observed.id = undefined; observed.denied = true; }
						this.emitObservation({ type: "base_states", scope: observed.scope, status: available ? "available" : "unavailable", peers });
					} else if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope; if (scope.kind !== "base") throw new Error();
						if (!available) { this.watching = undefined; this.emitRoster(scope, "unavailable"); }
						this.emitBaseStates(scope, available ? "available" : "unavailable", peers);
					}
				} else if (value.type === "image_states") {
					const available = value.status === "available";
					if (!this.supportsImageStates || (!this.options.imageStates && !this.options.observation) || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseImagePeers(value.peers) : [];
					if (observed) {
						if (observed.scope.kind !== "image") throw new Error();
						if (!available) { observed.id = undefined; observed.denied = true; }
						this.emitObservation({ type: "image_states", scope: observed.scope, status: available ? "available" : "unavailable", peers });
					} else if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope; if (scope.kind !== "image") throw new Error();
						if (!available) { this.watching = undefined; this.emitRoster(scope, "unavailable"); }
						this.emitImageStates(scope, available ? "available" : "unavailable", peers);
					}
				} else if (value.type === "roster") {
					const available = value.status === "available";
					if (!this.supportsSurfaceRoster || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseSurfacePeers(value.peers) : [];
					if (observed) {
						if (observed.scope.kind === "note") throw new Error();
						if (!available) { observed.id = undefined; observed.denied = true; }
						this.emitObservation({ type: "roster", scope: observed.scope, status: available ? "available" : "unavailable", peers });
					} else if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope;
						if (scope.kind === "note") throw new Error();
						if (!available) this.watching = undefined;
						this.emitRoster(scope, available ? "available" : "unavailable", peers);
					}
				} else throw new Error();
				this.lastReceived = Date.now();
			}
		} catch { this.fail("unavailable"); }
	}
	private beat(): void {
		if (this.heartbeat !== undefined) window.clearTimeout(this.heartbeat);
		this.heartbeat = window.setTimeout(() => {
			this.heartbeat = undefined;
			if (this.status !== "ready") return;
			if (Date.now() - this.lastReceived > 25_000) { this.fail(); return; }
			this.send({ type: "ping" }); if (this.status === "ready") this.beat();
		}, 10_000);
	}
	private armRefresh(expiresAt: number): void {
		if (this.refreshTimer !== undefined) window.clearTimeout(this.refreshTimer);
		// getValidToken() refreshes inside the native provider's five-minute
		// safety window. Bound repeated unchanged/short-lived token responses.
		this.refreshTimer = window.setTimeout(() => { this.refreshTimer = undefined; void this.renew(this.version); }, Math.max(10_000, expiresAt * 1000 - Date.now() - 60_000));
	}
	private async renew(version: number): Promise<void> {
		if (this.renewing || !this.current(version) || this.status !== "ready") return;
		this.renewing = true;
		try {
			const ticket = await this.ticket(version);
			if (!this.current(version) || this.status !== "ready") return;
			if (!this.send({ type: "authenticate", ticket, instance_id: this.identity.instanceId })) return;
			this.deadline = window.setTimeout(() => { if (this.current(version)) this.fail(); }, 10_000);
		} catch (error) { if (this.current(version)) this.fail(error instanceof ChannelFailure ? error.status : "reconnecting", error instanceof ChannelFailure ? error.retryAfter : 0); }
	}
}
