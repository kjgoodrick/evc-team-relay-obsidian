import { setIcon } from "obsidian";

/** Compact actions retain native button semantics and accessible tooltips. */
export function commentButton(parent: HTMLElement, options: DomElementInfo): HTMLButtonElement {
 const button = parent.createEl("button", options);
 const label = typeof options.text === "string" ? options.text : "";
 const icons: Record<string, string> = {
 "Bold": "bold", "Italic": "italic", "Strikethrough": "strikethrough", "Inline code": "code", "Code block": "square-code", "Bulleted list": "list", "Numbered list": "list-ordered", "Link": "link", "Undo": "undo", "Redo": "redo",
 "More comment actions": "ellipsis", "Filter comments": "list-filter", "Add reaction": "smile-plus",
 "Copy discussion link": "link", "Copy comment link": "link", "Show selected text": "text-cursor-input",
 "Show selected blocks": "focus", "Show selected position": "focus", "Show image pin": "locate",
 "Show image region": "scan", "Show image discussion": "image", "Show Bases target": "locate",
 "Show summary": "locate", "Move target": "crosshair", "Resolve": "check", "Reopen": "rotate-ccw",
 "Show replies": "chevron-right", "Hide replies": "chevron-down", "History": "history", "Edit": "pencil",
 "Remove": "trash-2", "Comment inbox": "inbox", "Search and filter comments": "search",
 "Follow discussion": "bell-plus", "Unfollow discussion": "bell-minus", "Mute discussion": "bell-off",
 "Unmute discussion": "bell", "Send": "send", "Discard draft": "trash-2", "Format comment": "text-cursor-input",
 "Target history": "history", "Show captured marker position": "locate", "Compare marker positions": "git-compare", "Review unconfirmed move": "crosshair", "Target details": "info", "Refresh picture uploads": "refresh-cw", "Check delivery and edit": "mail-check", "Remove picture": "image-minus", "Move picture up": "arrow-up", "Move picture down": "arrow-down", "Apply link": "check", "Remove link": "unlink", "Cancel link": "x",
 "Send and reopen": "send", "Show selection": "focus"
 };
 const icon = icons[label];
 if (icon) { button.setAttribute("aria-label", label); button.title = button.title || label; button.classList.add("relay-comment-icon"); setIcon(button, icon); }
 return button;
}
