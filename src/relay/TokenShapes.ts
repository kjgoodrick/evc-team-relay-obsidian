/**
 * Shapes of the short-lived tokens the relay hands out.
 *
 * These describe our own wire format, and they are the authority on it: a field
 * renamed here is a field renamed on the wire and in every stored settings blob
 * that carries one. Change them only alongside the server.
 */

/** How much the bearer of a token may do with the document it names. */
export type TokenAuthorization = "full" | "read-only";

/**
 * Credentials for one document connection.
 *
 * The optional members are absent on a plain document token and populated on a
 * file token — see {@link FileGrant}, which is the same payload with those
 * members promised rather than hoped for.
 */
export interface DocumentGrant {
	/** Bare WebSocket endpoint. The document id is appended to it when connecting. */
	url: string;

	/** Origin for document-level HTTP calls, when it differs from `url`. */
	baseUrl?: string;

	/** Identifies the document this token admits the bearer to. */
	docId: string;

	/** Shared folder the document belongs to. */
	folder: string;

	/** The bearer credential itself. */
	token: string;

	authorization?: TokenAuthorization;

	/** Expiry as epoch milliseconds. */
	expiryTime?: number;

	/** MIME type, e.g. `image/png` — a string, despite the `content*` siblings below. */
	contentType?: string;

	contentLength?: number;

	/** sha256 of the content, hex-encoded — a string, not a number. */
	fileHash?: string;
}

/**
 * A token for a stored file rather than a live doc.
 *
 * Every member the server always sends for a file is required here, so callers
 * reading size or hash off one do not have to re-check what the transport
 * already guaranteed.
 */
export interface FileGrant extends DocumentGrant {
	authorization: TokenAuthorization;
	docId: string;
	folder: string;
	token: string;
	expiryTime: number;
	contentType: string;
	contentLength: number;
	fileHash: string;
	/** Current server context, separate from the request's immutable write binding. */
	restoreGuard?: boolean;
	restoreGeneration?: string | null;
}
