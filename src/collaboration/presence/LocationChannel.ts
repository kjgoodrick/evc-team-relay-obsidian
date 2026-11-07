import { decodeJwt } from "jose";
import { v4 as uuid } from "uuid";
import { platformFetch, type PlatformRequestInit } from "../../platformFetch";
import { parseRetryAfterMs, RelayHttpError } from "../../relayRequestErrors";
import { isRecord } from "../DiscussionProtocol";
import { parseEmbeddedImage, parseEmbeddedPeers, type EmbeddedImage, type EmbeddedImagesEvent } from "./EmbeddedImageProtocol";
import { parseImageState, parseImagePeers, type ImagePresenceState, type ImageStatesEvent } from "./LocationProtocol";
import { exactFields, locationId, parseLocationTarget, parseNoteLocation, parseSurfaceLocation, parseSurfacePeers, publicSessionId, type ImageLocation, type LocationEvent, type LocationTarget, type NonNoteLocation, type SurfaceLocation, type SurfaceRosterEvent } from "./LocationProtocol";

export type LocationChannelStatus = "idle" | "connecting" | "ready" | "reconnecting" | "unsupported" | "authentication" | "unavailable";
export type LocationIdentity = Readonly<{ serverUrl: string; accountId: string; loginSessionId: string; instanceId: string }>;
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
	private imageStatesSupported = false;
	private embedsSupported = false;
	private desiredEmbed: EmbeddedImage | null = null;
	private desiredImageState: ImagePresenceState | null = null;
	private sentImageState?: string;
	private imageTimer?: number;
	private lastImageSent = 0;
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
	get supportsImageStates(): boolean { return this.supportsSurfaceRoster && this.imageStatesSupported; }
	get supportsEmbeddedImages(): boolean { return this.supportsSurfaceLocations && this.embedsSupported; }
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
		this.desiredImageState = null; this.desiredEmbed = null; this.sentImageState = undefined; this.lastImageSent = 0;
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
	private setWatch(next: SurfaceLocation | null): void {
		if (JSON.stringify(next) === JSON.stringify(this.desiredWatch)) return;
		this.desiredWatch = next;
		const previous = this.watching; this.watching = undefined;
		this.emitRoster(null, "unavailable");
		if (previous && this.ready) this.send({ type: "unwatch", subscription_id: previous.id });
		this.sentWatch = undefined;
		this.flushWatch();
	}
	unfollow(): void {
		const id = this.subscription; this.subscription = undefined;
		if (id && this.status === "ready") this.send({ type: "unfollow", subscription_id: id });
	}
	/** Explicit retry or an authentication lifecycle event, never ordinary cursor updates. */
	retry(): void {
		if (this.ready && this.desiredWatch && !this.watching) { this.sentWatch = undefined; this.flushWatch(); return; }
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
		this.drop(); this.desired = null; this.desiredWatch = null; this.shareId = undefined; this.setStatus("idle");
	}
	private setStatus(status: LocationChannelStatus): void {
		if (this.status === status) return;
		this.status = status; try { this.options.status?.(status); } catch { /* Isolate UI. */ }
	}
	private current(version: number): boolean { return this.active && version === this.version; }
	private drop(): void {
		for (const timer of [this.retryTimer, this.heartbeat, this.refreshTimer, this.deadline, this.publishTimer, this.imageTimer]) if (timer !== undefined) window.clearTimeout(timer);
		this.imageTimer = undefined; this.desiredImageState = null; this.desiredEmbed = null; this.sentImageState = undefined; this.imageStatesSupported = false; this.embedsSupported = false; this.lastImageSent = 0;
		this.retryTimer = this.heartbeat = this.refreshTimer = this.deadline = this.publishTimer = undefined;
		for (const cancel of this.requests) cancel(); this.requests.clear();
		// Native HTTP may finish independently; generation checks fence every late
		// credential, response and callback. Do not retain timers or a live socket.
		this.renewing = false; this.sent = undefined;
		this.watching = undefined; this.sentWatch = undefined; this.protocolVersion = 1; this.rosterSupported = false; this.imageContextSupported = false;
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
	private async request(path: string, version: number, post = false): Promise<unknown> {
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
				method: post ? "POST" : "GET", sensitive: true, headers: { Authorization: "Bearer " + credential.accessToken },
			}); } catch (error) { throw new ChannelFailure("reconnecting", error instanceof RelayHttpError ? error.retryAfterMs : 0); }
			if (!current()) throw new ChannelFailure("unavailable");
			if ([401, 403].includes(response.status)) throw new ChannelFailure("authentication");
			if (response.status === 404) throw new ChannelFailure("unsupported");
			if (response.status === 408 || response.status === 429 || response.status >= 500) throw new ChannelFailure("reconnecting", parseRetryAfterMs(response.headers.get("Retry-After")));
			if (!response.ok) throw new ChannelFailure("unavailable");
			const raw = await response.text();
			if (!current() || raw.length > 65_536 || new TextEncoder().encode(raw).length > 65_536) throw new ChannelFailure("unavailable");
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
				if ([extended, roster, image, states, embeds].some(value => value !== undefined && typeof value !== "boolean") || (roster === true || image === true || states === true || embeds === true) && extended !== true || states === true && roster !== true) throw new ChannelFailure("unavailable");
				this.protocolVersion = extended === true ? 2 : 1;
				this.rosterSupported = roster === true;
				this.imageContextSupported = image === true;
				this.imageStatesSupported = states === true;
				this.embedsSupported = embeds === true;
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
		if (this.sent !== JSON.stringify(this.desired) || !(this.supportsImageStates && this.desired?.kind === "image" || this.supportsEmbeddedImages && this.desired?.kind === "note")) return;
		const embedded = this.desired?.kind === "note", state = embedded ? this.desiredEmbed : this.desiredImageState;
		const encoded = JSON.stringify(state);
		// A new publication starts with no state on the server.
		if (this.sentImageState === undefined && state === null) { this.sentImageState = encoded; return; }
		if (encoded !== this.sentImageState && this.send(embedded ? { type: "image_embed", location: this.desired, embed: state } : { type: "image_state", location: this.desired, state })) { this.sentImageState = encoded; this.lastImageSent = Date.now(); }
	}
	private emitRoster(scope: NonNoteLocation | null, status: SurfaceRosterEvent["status"], peers: SurfaceRosterEvent["peers"] = []): void {
		if (status === "unavailable") { this.emitImageStates(null, "unavailable"); this.emitEmbeddedImages(null, "unavailable"); }
		try { this.options.roster?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private emitImageStates(scope: ImageLocation | null, status: ImageStatesEvent["status"], peers: ImageStatesEvent["peers"] = []): void {
		try { this.options.imageStates?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private emitEmbeddedImages(scope: EmbeddedImagesEvent["scope"], status: EmbeddedImagesEvent["status"], peers: EmbeddedImagesEvent["peers"] = []): void {
		try { this.options.imageEmbeds?.({ scope, status, peers }); } catch { /* Isolate UI. */ }
	}
	private flushWatch(): void {
		if (!this.desiredWatch || this.sentWatch === JSON.stringify(this.desiredWatch)) return;
		if (this.desiredWatch.kind === "note" ? !this.supportsEmbeddedImages || !this.options.imageEmbeds : !this.supportsSurfaceRoster) return;
		const scope = this.desiredWatch, id = uuid(); this.watching = { id, scope };
		if (this.send({ type: scope.kind === "note" ? "watch_embeds" : "watch", subscription_id: id, location: scope, ...(scope.kind === "image" && this.supportsImageStates && this.options.imageStates ? { image_states: true } : {}) })) this.sentWatch = JSON.stringify(scope);
	}
	private receive(raw: unknown): void {
		try {
			const limit = this.rosterSupported || this.embedsSupported ? 192 * 1024 : 4096;
			if (typeof raw !== "string" || raw.length > limit) throw new Error();
			const bytes = new TextEncoder().encode(raw).length;
			if (bytes > limit) throw new Error();
			const value: unknown = JSON.parse(raw);
			if (!isRecord(value) || !["roster", "image_states", "image_embeds"].includes(String(value.type)) && bytes > 4096) throw new Error();
			if (value.type === "ready") {
				if (this.status !== "connecting" || !exactFields(value, ["type", "protocol_version", "session_id", "instance_id", "expires_at"]) ||
					value.protocol_version !== this.protocolVersion || value.instance_id !== this.identity.instanceId || !publicSessionId(value.session_id) || !expiry(value.expires_at)) throw new Error();
				if (this.deadline !== undefined) window.clearTimeout(this.deadline); this.deadline = undefined;
				this.lastReceived = Date.now(); this.attempts = 0; this.setStatus("ready"); this.flushPresence();
				this.flushWatch();
				if (!this.ready) return;
				this.armRefresh(value.expires_at); this.beat();
			} else {
				if (this.status !== "ready") throw new Error();
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
					if (!this.supportsEmbeddedImages || !this.options.imageEmbeds || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseEmbeddedPeers(value.peers) : [];
					if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope; if (scope.kind !== "note") throw new Error();
						if (!available) this.watching = undefined;
						this.emitEmbeddedImages(scope, available ? "available" : "unavailable", peers);
					}
				} else if (value.type === "image_states") {
					const available = value.status === "available";
					if (!this.supportsImageStates || !this.options.imageStates || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseImagePeers(value.peers) : [];
					if (this.watching?.id === value.subscription_id) {
						const scope = this.watching.scope; if (scope.kind !== "image") throw new Error();
						if (!available) { this.watching = undefined; this.emitRoster(scope, "unavailable"); }
						this.emitImageStates(scope, available ? "available" : "unavailable", peers);
					}
				} else if (value.type === "roster") {
					const available = value.status === "available";
					if (!this.supportsSurfaceRoster || !locationId(value.subscription_id) || !["available", "unavailable"].includes(String(value.status)) ||
						!exactFields(value, available ? ["type", "subscription_id", "status", "peers"] : ["type", "subscription_id", "status"])) throw new Error();
					const peers = available ? parseSurfacePeers(value.peers) : [];
					if (this.watching?.id === value.subscription_id) {
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
