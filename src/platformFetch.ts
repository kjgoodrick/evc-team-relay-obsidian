"use strict";
import { requestUrl } from "obsidian";
import { Platform } from "obsidian";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { namedLogger } from "./logging";
import { currentToggles } from "./featureToggleState";
import { RelayHttpError, isTransientRelayFailure, parseRetryAfterMs } from "./relayRequestErrors";

declare const GIT_TAG: string;

function polyfillFetchIfElectronBroken(): void {
	if (window.Response !== undefined && window.Headers !== undefined) return;
	// Certain Electron builds ship without a working global fetch/Response/Headers
	// https://github.com/electron/electron/pull/42419
	try {
		console.warn(
			"[Relay] Installing fetch/Response/Headers polyfill for a broken Electron build (electron/electron#42419)",
		);
		const windowRecord = window as unknown as Record<string, unknown>;
		if (windowRecord["blinkfetch"]) {
			window.fetch = windowRecord["blinkfetch"] as typeof window.fetch;
			for (const key of ["fetch", "Response", "FormData", "Request", "Headers"]) {
				windowRecord[key] = windowRecord[`blink${key}`];
			}
		}
	} catch (e: unknown) {
		console.error(e);
	}
}

function polyfillEventSourceIfMissing(): void {
	if ((window as unknown as Record<string, unknown>)["EventSource"] !== undefined) return;
	if (Platform.isMobile) {
		console.warn("[Relay] Polyfilling EventSource API required, but unable to polyfill on Mobile");
		return;
	}
	console.warn("[Relay] Installing EventSource polyfill");
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for optional polyfill
	(window as unknown as Record<string, unknown>)["EventSource"] = require("eventsource") as typeof EventSource;
}

polyfillFetchIfElectronBroken();
polyfillEventSourceIfMissing();

// Transient network errors (stale keep-alive connections, HTTP/2 RST_STREAM)
// worth a retry — but only for idempotent methods (see requestWithRetry).
const RETRYABLE_MESSAGE_SUBSTRINGS = [
	"net::ERR_FAILED",
	"net::ERR_HTTP2",
	"net::ERR_CONNECTION_RESET",
	"GOAWAY",
	"RST_STREAM",
];

function isRetryableFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return RETRYABLE_MESSAGE_SUBSTRINGS.some((substring) => message.includes(substring)) ||
		isTransientRelayFailure(error);
}

const RETRIES_EXHAUSTED = Symbol("retries-exhausted");

/**
 * Runs `requestUrl`, retrying transient network errors for idempotent
 * methods only. A mutating request (POST/PUT/PATCH/DELETE) may have already
 * been applied server-side before the connection reset (e.g. RST after the
 * record was written), so retrying it risks creating a duplicate —
 * those get zero retries.
 */
async function requestWithRetry(
	requestParams: RequestUrlParam,
	method: string,
): Promise<RequestUrlResponse | typeof RETRIES_EXHAUSTED> {
	const isIdempotentMethod = method === "GET" || method === "HEAD";
	const maxRetries = isIdempotentMethod ? 2 : 0;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const result = await requestUrl(requestParams);
			if (result.status < 500 || attempt >= maxRetries) return result;
		} catch (error: unknown) {
			const retryable = isRetryableFailure(error);

			if (retryable && attempt < maxRetries) {
				namedLogger("[PlatformFetch]", "warn")(
					`Retrying ${method} (attempt ${attempt + 2}/${maxRetries + 1}) after a transient transport failure`,
				);
			} else if (retryable) {
				return RETRIES_EXHAUSTED;
			} else {
				throw error;
			}
		}
		// At most three GET/HEAD attempts, separated by exponential delays with
		// jitter. Mutations always return/throw above without retrying.
		await new Promise<void>((resolve) => {
			window.setTimeout(resolve, 1000 * 2 ** attempt * (0.8 + Math.random() * 0.4));
		});
	}
	// Unreachable — the loop above always returns or throws — but keeps
	// TypeScript's control-flow analysis happy about the async function's
	// return type.
	throw new Error("Request failed after retries");
}

function logIfEnabled(response: RequestUrlResponse, method: string, urlString: string): void {
	if (!currentToggles().enableNetworkLogging) return;

	const level = response.status >= 500 ? "error" : response.status >= 400 ? "warn" : "debug";
	const contentType = response.headers["content-type"] || "";

	let parsedBody: unknown;
	if (contentType.includes("application/json")) {
		try {
			parsedBody = JSON.parse(response.text) as unknown;
		} catch {
			// pass — fall back to the raw text below
		}
	}

	namedLogger("[PlatformFetch]", level)(
		response.status.toString(),
		method,
		urlString,
		parsedBody ?? response.text,
	);
}

function toFetchResponse(response: RequestUrlResponse): Response {
	if (!response.arrayBuffer.byteLength) {
		return new Response(null, {
			status: response.status,
			statusText: response.status.toString(),
			headers: new Headers(response.headers),
		});
	}

	const fetchResponse = new Response(response.arrayBuffer, {
		status: response.status,
		statusText: response.status.toString(),
		headers: new Headers(response.headers),
	});

	// requestUrl() already decodes the body to text/json for us — reuse that
	// instead of making callers re-parse the ArrayBuffer via .json().
	Object.defineProperty(fetchResponse, "json", {
		value: () => Promise.resolve(JSON.parse(response.text)),
	});

	return fetchResponse;
}

export interface PlatformRequestInit extends RequestInit {
	/** Omit response content and URL from diagnostics (comments, replay cursors). */
	sensitive?: boolean;
}

export const platformFetch = async (
	url: RequestInfo | URL,
	config?: PlatformRequestInit,
): Promise<Response> => {
	const urlString = url instanceof URL ? url.toString() : (url as string);
	const method = config?.method || "GET";
	const headers = Object.assign({}, config?.headers, {
		"Relay-Version": GIT_TAG,
	}) as Record<string, string>;

	const requestParams: RequestUrlParam = {
		url: urlString,
		method,
		body: config?.body as string | ArrayBuffer,
		headers,
		throw: false,
	};

	const result = await requestWithRetry(requestParams, method);
	if (result === RETRIES_EXHAUSTED) {
		return new Response(JSON.stringify({ error: "Network request failed" }), {
			status: 503,
			statusText: "Service Unavailable",
			headers: new Headers({ "content-type": "application/json" }),
		});
	}

	if (!config?.sensitive) logIfEnabled(result, method, urlString);

	if (result.status >= 500) {
		throw new RelayHttpError(result.status, config?.sensitive ? "Relay request failed" : result.text,
			parseRetryAfterMs(result.headers["retry-after"] ?? result.headers["Retry-After"]));
	}

	return toFetchResponse(result);
};
