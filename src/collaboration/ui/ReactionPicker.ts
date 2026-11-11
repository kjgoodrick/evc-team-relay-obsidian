import { Modal, type App } from "obsidian";
import { EMOJI_CATALOG } from "../DiscussionProtocol";

/** Bounded rendering; the text input accepts the operating system's emoji keyboard. */
export class ReactionPicker extends Modal {
 constructor(app: App, private expanded: boolean, private choose: (key: string) => void) { super(app); }
 onOpen(): void {
  this.setTitle("Choose a reaction");
  this.contentEl.addClass("relay-reaction-picker");
  const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: "Search or insert an emoji…", "aria-label": "Search reactions or insert an emoji" } });
  this.contentEl.createEl("p", { cls: "relay-comment-muted", text: "You can also insert an emoji using your device’s emoji keyboard." });
  if (!this.expanded) this.contentEl.createEl("p", { text: "Update the Team Relay server to enable all emoji." });
  const grid = this.contentEl.createDiv({ cls: "relay-reaction-grid" });
  const more = this.contentEl.createEl("button", { text: "More emoji" });
  let limit = 80;
  const catalog = this.expanded ? EMOJI_CATALOG : EMOJI_CATALOG.filter(([key]) => /^[a-z_]+$/.test(key));
  const matches = () => {
   const query = input.value.trim().toLocaleLowerCase();
   const normalized = query.replace(/\uFE0F/g, "");
   return catalog.filter(([key, glyph, name]) => !query || glyph.replace(/\uFE0F/g, "") === normalized || name.includes(query) || key.includes(query));
  };
  const select = (key: string) => { this.choose(key); this.close(); };
  const render = () => {
   grid.empty();
   const results = matches();
   for (const [key, glyph, name] of results.slice(0, limit)) {
    const button = grid.createEl("button", { text: glyph, attr: { "aria-label": name } });
    button.onclick = () => select(key);
   }
   if (!results.length) grid.createEl("p", { text: "No matching emoji" });
   more.hidden = results.length <= limit;
  };
  input.oninput = () => { limit = 80; render(); };
  input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { const results = matches(); if (results.length === 1) { event.preventDefault(); select(results[0][0]); } } };
  more.onclick = () => { limit += 80; render(); };
  render(); input.focus();
 }
 onClose(): void { this.contentEl.empty(); }
}
