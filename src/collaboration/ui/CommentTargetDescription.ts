import type { LocalDiscussionAnchor } from "../LocalDiscussionAnchor";

export function commentTargetDescription(anchor: LocalDiscussionAnchor): string {
	if (anchor.type === "note") return "Entire note";
	if (anchor.type === "text") return (anchor.structure ? "Selected blocks: " : "Selected text: ") + (anchor.context.quote || "Saved position");
	if (anchor.type === "image" || anchor.type === "image_file") return `Image ${anchor.geometry.type === "whole" ? "discussion" : anchor.geometry.type}`;
	if (anchor.type === "base_group_pending") return "Selected group or timeline lane";
	return "Saved view: " + anchor.target.type.replace(/_/g, " ");
}
