import { DiscussionFailure } from "../DiscussionFailure";
import type { CommandStatus } from "../DiscussionTransport";

export function commandReceiptMessage(result: CommandStatus): string {
	if (result.status === "accepted") return "The server recorded this request as accepted. Your saved copy is unchanged.";
	if (result.status === "withdrawn") return "The server recorded this request as cancelled. Your saved copy is unchanged.";
	return "No matching receipt was found. This does not prove the change was never accepted. Your saved copy is unchanged; nothing was resent.";
}
export function commandReceiptError(error: unknown): string {
	if (error instanceof DiscussionFailure && error.action === "authenticate") return "Sign in again before checking this request.";
	if (error instanceof DiscussionFailure && [403, 404].includes(error.status)) return "This request's target or receipt cannot be accessed. Keep the saved copy for recovery.";
	if (error instanceof DiscussionFailure && error.code === "operation_id_conflict") return "This request does not match the server's saved receipt. Keep the original recovery copy for review.";
	return "The receipt could not be checked. Keep the saved copy and try again when connected. Nothing was resent.";
}
