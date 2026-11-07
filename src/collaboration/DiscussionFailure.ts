export type FailureAction = "retry" | "authenticate" | "reject" | "pause";

/** Codes are safe diagnostics; never carry the server's raw response or token. */
export class DiscussionFailure extends Error {
	constructor(readonly action: FailureAction, readonly code: string, readonly status = 0,
		readonly retryAfterMs?: number) { super(code); this.name = "DiscussionFailure"; }
}
