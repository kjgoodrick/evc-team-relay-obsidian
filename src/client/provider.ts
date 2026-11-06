import { ManagedIndexTransport } from "./ManagedIndexTransport";
/**
 * WebSocket provider for a Yjs doc.
 *
 * Written for Team Relay. Speaks the standard y-protocols framing over a
 * WebSocket: a varuint message type, then a payload that `y-protocols`
 * itself encodes and decodes. Nothing here invents a wire format.
 *
 * Two behaviours are ours and are load-bearing — do not "simplify" them:
 *
 *   Reconnects are unbounded by default. A relay-server
 *   restart otherwise left a document permanently offline, because a fixed
 *   attempt budget runs out and never refills.
 *
 *   Awareness is re-sent after connecting, up to a few times, and stops the
 *   moment the document reports itself synced. A single
 *   send races the server's room warm-up: it arrives, finds no room yet, and
 *   the user shows up to everyone else as absent. The stop condition is
 *   `synced`, not a timer — a timer would either give up too early on a slow
 *   link or keep talking to a room that is already listening.
 */

import * as Y from "yjs";
import * as bc from "lib0/broadcastchannel";
import * as time from "lib0/time";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import { ObservableV2 } from "lib0/observable";
import * as math from "lib0/math";
import * as url from "lib0/url";
import { tokenRequestClass } from "../auth/tokenRequestClass";
import {
	type ConnectTicket,
	enqueueConnect,
	handshakeTimeoutMs,
	MAX_HANDSHAKE_TIMEOUT_MS,
	recordHandshake,
	recordHandshakeTimeout,
} from "./connectGate";

export const messageSync = 0;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageQueryAwareness = 3;

/** How many times awareness is re-sent after connecting before giving up. */
export const MAX_AWARENESS_RESEND_ATTEMPTS = 5;

/** Drop a connection that has gone this long without a single message. */
const MESSAGE_RECONNECT_TIMEOUT = 30000;
/** How often the liveness check above runs. */
const LIVENESS_CHECK_INTERVAL = MESSAGE_RECONNECT_TIMEOUT / 10;
/** Base delay for the awareness re-send ladder. */
const AWARENESS_RESEND_BASE_MS = 250;
/** Base delay for the reconnect ladder. */
const RECONNECT_BASE_MS = 100;

export type HandlerFunction = (
	encoder: encoding.Encoder,
	decoder: decoding.Decoder,
	provider: YSweetProvider,
	emitSynced: boolean,
	messageType: number,
) => void;

export type YSweetProviderParams = {
	connect?: boolean;
	awareness?: awarenessProtocol.Awareness;
	params?: { [x: string]: string };
	WebSocketPolyfill?: typeof WebSocket;
	resyncInterval?: number;
	maxBackoffTime?: number;
	disableBc?: boolean;
	maxConnectionErrors?: number;
	/** Recheck credentials immediately before opening any socket. */
	beforeConnect?: () => boolean;
};

export type ConnectionStatus =
	| "connected"
	| "connecting"
	| "disconnected"
	| "unknown";

/** What the caller asked for, as opposed to what the socket is doing. */
export type ConnectionIntent = "connected" | "disconnected";

export type ConnectionState = {
	status: ConnectionStatus;
	intent: ConnectionIntent;
};

const messageHandlers: Array<HandlerFunction> = [];

messageHandlers[messageSync] = (encoder, decoder, provider, emitSynced) => {
	encoding.writeVarUint(encoder, messageSync);
	const syncMessageType = syncProtocol.readSyncMessage(
		decoder,
		encoder,
		provider.doc,
		provider,
	);
	if (
		emitSynced &&
		syncMessageType === syncProtocol.messageYjsSyncStep2 &&
		!provider.synced
	) {
		provider.synced = true;
	}
};

messageHandlers[messageQueryAwareness] = (encoder, _decoder, provider) => {
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(
		encoder,
		awarenessProtocol.encodeAwarenessUpdate(
			provider.awareness,
			[provider.doc.clientID],
		),
	);
};

messageHandlers[messageAwareness] = (_encoder, decoder, provider) => {
	awarenessProtocol.applyAwarenessUpdate(
		provider.awareness,
		decoding.readVarUint8Array(decoder),
		provider,
	);
};

messageHandlers[messageAuth] = (_encoder, decoder, provider) => {
	authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
		permissionDeniedHandler(provider, reason),
	);
};

const permissionDeniedHandler = (provider: YSweetProvider, reason: string) =>
	console.warn("Relay permission denied:", reason); // Never log the credential-bearing socket URL.

/**
 * Decode one incoming frame and hand it to the handler for its type. The
 * returned encoder is non-empty only when the peer expects an answer.
 */
const readMessage = (
	provider: YSweetProvider,
	buf: Uint8Array,
	emitSynced: boolean,
): encoding.Encoder => {
	const decoder = decoding.createDecoder(buf);
	const encoder = encoding.createEncoder();
	const messageType = decoding.readVarUint(decoder);
	const handler = messageHandlers[messageType];
	if (handler) {
		handler(encoder, decoder, provider, emitSynced, messageType);
	} else {
		console.error("Unable to compute message");
	}
	return encoder;
};

/** Send over the socket if it is open; otherwise the frame is dropped. */
const sendOverSocket = (provider: YSweetProvider, buf: Uint8Array): void => {
	const socket = provider.ws;
	if (!socket || socket.readyState !== WebSocket.OPEN) return;
	try {
		socket.send(buf);
	} catch {
		// A send can throw on a socket that is closing; the close handler
		// below is the single place a dead connection is dealt with.
		socket.close();
	}
};

/** Send to both channels — the socket and, when enabled, other local tabs. */
const broadcastMessage = (provider: YSweetProvider, buf: Uint8Array): void => {
	sendOverSocket(provider, buf);
	if (provider.bcconnected) {
		bc.publish(provider.bcChannel, buf, provider);
	}
};

const encodeSyncStep1 = (doc: Y.Doc): Uint8Array => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageSync);
	syncProtocol.writeSyncStep1(encoder, doc);
	return encoding.toUint8Array(encoder);
};

const encodeAwarenessOf = (
	awareness: awarenessProtocol.Awareness,
	clients: number[],
): Uint8Array => {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(
		encoder,
		awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
	);
	return encoding.toUint8Array(encoder);
};

/**
 * Queue a socket and wire it up once it is its turn (see connectGate). Every
 * exit path from a socket — error, close, or the liveness check — funnels back
 * here through a backoff timer, so this is the single place a connection is
 * born.
 */
const setupWS = (provider: YSweetProvider): void => {
	if (!provider.shouldConnect || provider.ws !== null || provider.connectTicket !== null) {
		provider.connectTrace.skipped = provider.shouldConnect ? "socket-present" : "not-wanted";
		return;
	}
	if (!provider.beforeConnect()) {
		provider.connectTrace.skipped = "before-connect";
		return;
	}

	provider.connectTrace.queuedAt = Date.now();
	provider.wsconnecting = true;
	const ticket = enqueueConnect(
		provider.url,
		() => tokenRequestClass(provider.roomname),
		(granted) => openWS(provider, granted),
	);
	// It may have started, and even finished, synchronously above.
	if (!ticket.released) provider.connectTicket = ticket;
};

/**
 * Start gently and back off, so a server that is merely restarting is not
 * hammered, and one that is down does not spin the client.
 */
const reconnectDelay = (provider: YSweetProvider): number =>
	math.min(math.pow(2, provider.wsUnsuccessfulReconnects) * RECONNECT_BASE_MS, provider.maxBackoffTime);

/** Frees `ticket`, and forgets it if it is still the provider's current one. */
const releaseTicket = (provider: YSweetProvider, ticket: ConnectTicket): void => {
	if (provider.connectTicket === ticket) provider.connectTicket = null;
	ticket.release();
};

const releaseConnectTicket = (provider: YSweetProvider): void => {
	if (provider.connectTicket !== null) releaseTicket(provider, provider.connectTicket);
};

const openWS = (provider: YSweetProvider, ticket: ConnectTicket): void => {
	provider.connectTicket = ticket;
	if (!provider.shouldConnect || provider.ws !== null) {
		releaseTicket(provider, ticket);
		provider.wsconnecting = false;
		return;
	}
	let websocket: WebSocket;
	try {
		websocket = new provider._WS(provider.url);
	} catch (error) {
		releaseTicket(provider, ticket);
		provider.wsconnecting = false;
		provider.wsUnsuccessfulReconnects++;
		provider.connectTrace.failedSockets++;
		provider.emit("connection-error", [error as Event, provider]);
		if (provider.canReconnect()) {
			window.setTimeout(setupWS, reconnectDelay(provider), provider);
		}
		return;
	}
	const startedAt = Date.now();
	provider.connectTrace.socketAt = startedAt;
	provider.connectTrace.skipped = undefined;
	websocket.binaryType = "arraybuffer";
	provider.ws = websocket;
	provider.wsconnecting = true;
	provider.wsconnected = false;
	provider.synced = false;

	// A handshake stuck this long would hold every other socket to this
	// server behind it: give up the turn and retry through onclose.
	const handshakeTimer = window.setTimeout(
		() => {
			if (provider.ws !== websocket || provider.wsconnected) return;
			recordHandshakeTimeout();
			provider.handshakeTimeoutsInRow++;
			releaseTicket(provider, ticket);
			websocket.close();
		},
		math.min(handshakeTimeoutMs() * math.pow(2, provider.handshakeTimeoutsInRow), MAX_HANDSHAKE_TIMEOUT_MS),
	);

	let awarenessResendTimer: number | null = null;
	const stopAwarenessResend = () => {
		if (awarenessResendTimer !== null) {
			window.clearTimeout(awarenessResendTimer);
			awarenessResendTimer = null;
		}
	};

	websocket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
		provider.wsLastMessageReceived = time.getUnixTime();
		const reply = readMessage(provider, new Uint8Array(event.data), true);
		if (encoding.length(reply) > 1) {
			sendOverSocket(provider, encoding.toUint8Array(reply));
		}
	};

	websocket.onerror = (event: Event) => {
		provider.emit("connection-error", [event, provider]);
	};

	websocket.onclose = (event: CloseEvent) => {
		window.clearTimeout(handshakeTimer);
		releaseTicket(provider, ticket);
		stopAwarenessResend();
		// A socket given up earlier (disconnect, timeout) closing after a newer
		// one was queued or opened: the newer one owns the provider's state.
		if (provider.ws !== websocket && (provider.ws !== null || provider.connectTicket !== null)) return;
		provider.emit("connection-close", [event, provider]);
		provider.ws = null;
		provider.wsconnecting = false;

		if (provider.wsconnected) {
			provider.wsconnected = false;
			provider.synced = false;
			// Everyone else's presence came over this socket; with it gone we
			// no longer know anything about them. Our own state stays.
			awarenessProtocol.removeAwarenessStates(
				provider.awareness,
				Array.from(provider.awareness.getStates().keys()).filter(
					(client) => client !== provider.doc.clientID,
				),
				provider,
			);
			provider.emit("status", [
				{ status: "disconnected", intent: provider.intent },
			]);
		} else {
			provider.wsUnsuccessfulReconnects++;
			provider.connectTrace.failedSockets++;
		}

		if (!provider.canReconnect()) return;
		window.setTimeout(setupWS, reconnectDelay(provider), provider);
	};

	websocket.onopen = () => {
		window.clearTimeout(handshakeTimer);
		releaseTicket(provider, ticket);
		provider.handshakeTimeoutsInRow = 0;
		provider.connectTrace.openAt = Date.now();
		recordHandshake(provider.connectTrace.openAt - startedAt);
		provider.wsLastMessageReceived = time.getUnixTime();
		provider.wsconnecting = false;
		provider.wsconnected = true;
		provider.wsUnsuccessfulReconnects = 0;
		provider.emit("status", [
			{ status: "connected", intent: provider.intent },
		]);

		sendOverSocket(provider, encodeSyncStep1(provider.doc));

		if (provider.awareness.getLocalState() === null) return;

		const localClients = [provider.doc.clientID];
		// Publish through the local update handler with a fresh clock. Otherwise
		// a reconnect can remain hidden behind the relay's disconnect tombstone
		// until the next heartbeat, despite the document already being synced.
		provider.awareness.setLocalState(provider.awareness.getLocalState());

		// the first send can land before the server has a room for this
		// document, and is then simply lost — the user appears absent to
		// everyone. Repeat a few times on a widening ladder.
		//
		// The stop condition is checked AFTER sending, not before: a resend
		// that is already in flight when the room comes up is the one that
		// actually gets through, and dropping it would leave the user invisible
		// in exactly the case this exists to cover. Once `synced` is true the
		// room is demonstrably listening, so nothing further is scheduled.
		const scheduleResend = (attempt: number) => {
			if (attempt > MAX_AWARENESS_RESEND_ATTEMPTS) return;
			const delay = math.min(
				math.pow(2, attempt) * AWARENESS_RESEND_BASE_MS,
				provider.maxBackoffTime,
			);
			awarenessResendTimer = window.setTimeout(() => {
				awarenessResendTimer = null;
				if (!provider.wsconnected || provider.ws !== websocket) return;
				sendOverSocket(
					provider,
					encodeAwarenessOf(provider.awareness, localClients),
				);
				if (provider.synced) return;
				scheduleResend(attempt + 1);
			}, delay);
		};
		scheduleResend(1);
	};

	provider.emit("status", [{ status: "connecting", intent: provider.intent }]);
};

export type YSweetProviderEvents = {
	status: (state: ConnectionState) => void;
	synced: (state: boolean) => void;
	sync: (state: boolean) => void;
	"connection-error": (event: Event, provider: YSweetProvider) => void;
	"connection-close": (event: CloseEvent, provider: YSweetProvider) => void;
};

/**
 * Wall-clock timings of the latest connect() call, for the relay probe: a
 * connect measured at 16s under load whose upgrade request reached the relay
 * just as late could have waited anywhere before the socket opened.
 */
export interface ConnectTrace {
	calledAt: number;
	/** Why no socket was opened at that call (a later retry may open one). */
	skipped?: "socket-present" | "not-wanted" | "before-connect";
	/** When the latest socket was queued for its turn (see connectGate). */
	queuedAt?: number;
	/** The latest socket created since the call. */
	socketAt?: number;
	openAt?: number;
	/** Sockets that closed before opening since the call. */
	failedSockets: number;
}

export class YSweetProvider extends ObservableV2<YSweetProviderEvents> {
	managedIndex?: ManagedIndexTransport;
	maxBackoffTime: number;
	bcChannel: string;
	url: string;
	roomname: string;
	doc: Y.Doc;
	_WS: typeof WebSocket;
	awareness: awarenessProtocol.Awareness;
	wsconnected = false;
	wsconnecting = false;
	bcconnected = false;
	disableBc: boolean;
	wsUnsuccessfulReconnects = 0;
	messageHandlers: Array<HandlerFunction> = messageHandlers.slice();
	/**
	 * The live socket. Read from outside (see `src/websocketFlush.ts`, which
	 * waits on `bufferedAmount`), so it must be the real object and must not
	 * be swapped out while a send is in flight.
	 */
	ws: WebSocket | null = null;
	/** Timings of the latest connect() (see ConnectTrace). */
	connectTrace: ConnectTrace = { calledAt: 0, failedSockets: 0 };
	/** Our place in connectGate while a socket waits for its turn or handshakes. */
	connectTicket: ConnectTicket | null = null;
	/** Handshakes given up in a row; each one doubles the next timeout. */
	handshakeTimeoutsInRow = 0;
	wsLastMessageReceived = 0;
	shouldConnect: boolean;
	maxConnectionErrors: number;
	beforeConnect: () => boolean;

	private _synced = false;
	private _resyncInterval: number = 0;
	private _checkInterval: number;
	private _bcSubscriber: (data: ArrayBuffer, origin: unknown) => void;
	private _updateHandler: (update: Uint8Array, origin: unknown) => void;
	private _awarenessUpdateHandler: (
		changed: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => void;
	private _unloadHandler: () => void;

	constructor(
		serverUrl: string,
		roomname: string,
		doc: Y.Doc,
		{
			connect = true,
			awareness = new awarenessProtocol.Awareness(doc),
			params = {},
			WebSocketPolyfill = WebSocket,
			resyncInterval = -1,
			maxBackoffTime = 2500,
			disableBc = false,
			// a fixed budget runs out during a server
			// restart and never refills, leaving the document offline for
			// good. Unbounded plus backoff is the safe default here.
			maxConnectionErrors = Infinity,
			beforeConnect = () => true,
		}: YSweetProviderParams = {},
	) {
		super();

		while (serverUrl[serverUrl.length - 1] === "/") {
			serverUrl = serverUrl.slice(0, serverUrl.length - 1);
		}

		this.maxBackoffTime = maxBackoffTime;
		this.beforeConnect = beforeConnect;
		this.bcChannel = serverUrl + "/" + roomname;
		this.url = serverUrl + "/" + roomname + "?" + url.encodeQueryParams(params);
		this.roomname = roomname;
		this.doc = doc;
		this._WS = WebSocketPolyfill;
		this.awareness = awareness;
		this.disableBc = disableBc;
		this.shouldConnect = connect;
		this.maxConnectionErrors = maxConnectionErrors;

		this._bcSubscriber = (data: ArrayBuffer, origin: unknown) => {
			if (origin === this) return;
			const reply = readMessage(this, new Uint8Array(data), false);
			if (encoding.length(reply) > 1) {
				bc.publish(this.bcChannel, encoding.toUint8Array(reply), this);
			}
		};

		this._updateHandler = (update: Uint8Array, origin: unknown) => {
			// Updates we applied ourselves came from a peer already.
			if (origin === this) return;
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeUpdate(encoder, update);
			broadcastMessage(this, encoding.toUint8Array(encoder));
		};
		this.doc.on("update", this._updateHandler);

		this._awarenessUpdateHandler = (changed, origin) => {
			if (origin === this) return;
			const changedClients = changed.added.concat(
				changed.updated,
				changed.removed,
			).filter(client => client === this.doc.clientID);
			// Timeout cleanup is local knowledge, not authority to disconnect peers.
			// Initial peer state comes from the relay, never from this client.
			if (!changedClients.length) return;
			broadcastMessage(this, encodeAwarenessOf(this.awareness, changedClients));
		};
		this.awareness.on("update", this._awarenessUpdateHandler);

		// Leaving without saying so leaves a ghost cursor behind for everyone
		// else until their own timeout expires.
		this._unloadHandler = () => {
			awarenessProtocol.removeAwarenessStates(
				this.awareness,
				[doc.clientID],
				"window unload",
			);
		};
		if (typeof activeWindow !== "undefined") {
			activeWindow.addEventListener("unload", this._unloadHandler);
		} else if (typeof process !== "undefined") {
			process.on("exit", this._unloadHandler);
		}

		if (resyncInterval > 0) {
			this._resyncInterval = window.setInterval(() => {
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					sendOverSocket(this, encodeSyncStep1(this.doc));
				}
			}, resyncInterval);
		}

		// A socket can stop delivering without ever closing. Nothing but
		// silence distinguishes that from an idle connection, so treat a long
		// enough silence as death and let the normal reconnect path handle it.
		this._checkInterval = window.setInterval(() => {
			if (
				this.wsconnected &&
				MESSAGE_RECONNECT_TIMEOUT <
					time.getUnixTime() - this.wsLastMessageReceived
			) {
				this.ws?.close();
			}
		}, LIVENESS_CHECK_INTERVAL);

		if (connect) this.connect();
	}

	get synced(): boolean {
		return this._synced;
	}

	set synced(state: boolean) {
		if (this._synced === state) return;
		this._synced = state;
		this.emit("synced", [state]);
		this.emit("sync", [state]);
	}

	get intent(): ConnectionIntent {
		return this.shouldConnect ? "connected" : "disconnected";
	}

	/**
	 * Reads the socket itself rather than our own flags: the flags are set at
	 * the edges of handlers and can lag a socket that just changed state.
	 */
	get connectionState(): ConnectionState {
		const intent = this.intent;
		if (this.managedIndex) return { status: this.wsconnected ? "connected" : "disconnected", intent };
		switch (this.ws?.readyState) {
			case WebSocket.OPEN:
				return { status: "connected", intent };
			case WebSocket.CONNECTING:
				return { status: "connecting", intent };
			default:
				return { status: "disconnected", intent };
		}
	}

	canReconnect(): boolean {
		return (
			!!this.url &&
			this.shouldConnect &&
			this.wsUnsuccessfulReconnects < this.maxConnectionErrors
		);
	}

	connect(): void {
		this.shouldConnect = true;
		if (this.isManagedIndexUrl()) {
			if (!this.managedIndex) this.managedIndex = new ManagedIndexTransport(this.doc,
				() => { const parsed = new URL(this.url); const token = parsed.searchParams.get("token") ?? ""; parsed.search = ""; return { endpoint: parsed.toString(), token }; },
				connected => { this.wsconnected = connected; this.synced = connected; this.emit("status", [this.connectionState]); },
				error => this.emit("connection-error", [error as unknown as Event, this]),
			);
			this.managedIndex.start();
			return;
		}
		if (!this.wsconnected && this.ws === null && this.connectTicket === null) {
			this.connectTrace = { calledAt: Date.now(), failedSockets: 0 };
			setupWS(this);
			this.connectBc();
		} else if (!this.wsconnected) {
			// Keep the in-flight socket's times and failures: they explain the wait.
			this.connectTrace.calledAt = Date.now();
			this.connectTrace.skipped = "socket-present";
		}
	}

	disconnect(): void {
		this.shouldConnect = false;
		this.managedIndex?.stop();
		this.disconnectBc();
		releaseConnectTicket(this);
		if (this.ws === null) this.wsconnecting = false;
		if (this.ws !== null) {
			this.ws.close();
			this.ws = null;
		}
	}

	connectBc(): void {
		if (this.disableBc || this.bcconnected) return;
		bc.subscribe(this.bcChannel, this._bcSubscriber);
		this.bcconnected = true;

		// Ask local peers for their state and offer ours, so a second tab is
		// current without waiting for a server round-trip.
		const stepOne = encoding.createEncoder();
		encoding.writeVarUint(stepOne, messageSync);
		syncProtocol.writeSyncStep1(stepOne, this.doc);
		bc.publish(this.bcChannel, encoding.toUint8Array(stepOne), this);

		const stepTwo = encoding.createEncoder();
		encoding.writeVarUint(stepTwo, messageSync);
		syncProtocol.writeSyncStep2(stepTwo, this.doc);
		bc.publish(this.bcChannel, encoding.toUint8Array(stepTwo), this);

		const queryAwareness = encoding.createEncoder();
		encoding.writeVarUint(queryAwareness, messageQueryAwareness);
		bc.publish(this.bcChannel, encoding.toUint8Array(queryAwareness), this);

		bc.publish(
			this.bcChannel,
			encodeAwarenessOf(this.awareness, [this.doc.clientID]),
			this,
		);
	}

	disconnectBc(): void {
		if (!this.bcconnected) return;
		// Announce our departure to local peers before unsubscribing.
		bc.publish(
			this.bcChannel,
			encodeAwarenessOf(this.awareness, [this.doc.clientID]),
			this,
		);
		bc.unsubscribe(this.bcChannel, this._bcSubscriber);
		this.bcconnected = false;
	}

	/**
	 * Point the provider at a freshly minted token. Returns whether the URL
	 * actually changed; when it did, the current socket is closed so the
	 * normal reconnect path picks up the new one.
	 */
	refreshToken(
		serverUrl: string,
		roomname: string,
		token: string,
	): { urlChanged: boolean; newUrl: string } {
		while (serverUrl[serverUrl.length - 1] === "/") {
			serverUrl = serverUrl.slice(0, serverUrl.length - 1);
		}
		const newUrl =
			serverUrl + "/" + roomname + "?" + url.encodeQueryParams({ token });
		const urlChanged = newUrl !== this.url;
		if (!urlChanged) return { urlChanged, newUrl };

		this.url = newUrl;
		this.roomname = roomname;
		this.bcChannel = serverUrl + "/" + roomname;
		// A new token is a fresh start, not a continuation of past failures.
		this.wsUnsuccessfulReconnects = 0;
		if (this.ws !== null) this.ws.close();
		return { urlChanged, newUrl };
	}

	hasUrl(expectedUrl: string): boolean {
		return this.url === expectedUrl;
	}

	private isManagedIndexUrl(): boolean {
		try { return new URL(this.url).pathname.includes("/v1/managed/index/"); }
		catch { return false; }
	}

	destroy(): void {
		this.managedIndex?.destroy();
		if (this._resyncInterval !== 0) window.clearInterval(this._resyncInterval);
		window.clearInterval(this._checkInterval);
		if (this.ws !== null) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.onmessage = null;
			this.ws.onopen = null;
			try {
				this.ws.close(1000, "Destroyed");
			} catch {
				// already closing or closed
			}
		}
		this.disconnect();
		if (typeof activeWindow !== "undefined") {
			activeWindow.removeEventListener("unload", this._unloadHandler);
		} else if (typeof process !== "undefined") {
			process.off("exit", this._unloadHandler);
		}
		this.awareness.off("update", this._awarenessUpdateHandler);
		this.doc.off("update", this._updateHandler);
		this.awareness.destroy();
		super.destroy();
	}
}
