import { setIcon } from "obsidian";
import { EMOJI_CATALOG } from "../DiscussionProtocol";
import groups from "../EmojiGroups.json";

const icons = ["smile", "hand", "leaf", "apple", "plane", "trophy", "lightbulb", "hash", "flag"];
const starts = groups.map(group => EMOJI_CATALOG.findIndex(([, glyph]) => glyph === group.first));
let nextId = 0;
const opened = new WeakMap<Document, ReactionPicker>();

/** Anchored, bounded picker. Search includes every category and system-keyboard emoji. */
export class ReactionPicker {
 readonly contentEl: HTMLDivElement;
 private cleanup: (() => void)[] = [];
 constructor(private anchor: HTMLElement, private expanded: boolean, private choose: (key: string) => void) {
  this.contentEl = anchor.ownerDocument.createElement("div");
 }
 open(): void {
  const doc = this.anchor.ownerDocument, win = doc.defaultView!;
  opened.get(doc)?.close(false); opened.set(doc, this);
  const root = this.contentEl; root.empty();
  root.className = "relay-reaction-picker relay-reaction-popover";
  root.id = `relay-reactions-${++nextId}`;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Choose a reaction");
  this.anchor.setAttribute("aria-expanded", "true"); this.anchor.setAttribute("aria-controls", root.id);
  this.anchor.setAttribute("aria-haspopup", "dialog"); doc.body.append(root);
  const input = root.createEl("input", { attr: { type: "text", placeholder: "Search emoji…", "aria-label": "Search reactions or insert an emoji" } });
  const tabs = root.createDiv({ cls: "relay-reaction-tabs", attr: { role: "tablist", "aria-label": "Emoji categories" } });
  const grid = root.createDiv({ cls: "relay-reaction-grid", attr: { role: "tabpanel", id: root.id + "-grid" } });
  const more = root.createEl("button", { text: "More emoji" });
  let limit = 80, category = 0;
  const catalog = this.expanded ? EMOJI_CATALOG : EMOJI_CATALOG.filter(([key]) => /^[a-z_]+$/.test(key));
  const matches = () => {
   const query = input.value.trim().toLocaleLowerCase(), normalized = query.replace(/\uFE0F/g, "");
   if (query) return catalog.filter(([key, glyph, name]) => glyph.replace(/\uFE0F/g, "") === normalized || name.includes(query) || key.includes(query));
   return this.expanded ? EMOJI_CATALOG.slice(starts[category], starts[category + 1] ?? EMOJI_CATALOG.length) : catalog;
  };
  const select = (key: string) => { if (this.anchor.isConnected) this.choose(key); this.close(); };
  const render = () => {
   grid.empty(); grid.scrollTop = 0;
   const results = matches();
   for (const [key, glyph, name] of results.slice(0, limit)) {
    const button = grid.createEl("button", { text: glyph, attr: { "aria-label": name } });
    button.onclick = () => select(key);
   }
   if (!results.length) grid.createEl("p", { text: "No matching emoji" });
   more.hidden = results.length <= limit;
  };
  const buttons = groups.map((group, index) => {
   const tab = tabs.createEl("button", { attr: { role: "tab", id: root.id + "-tab-" + index, "aria-label": group.name, "aria-controls": grid.id } });
   setIcon(tab, icons[index]);
   tab.onclick = () => { category = index; input.value = ""; limit = 80; updateTabs(); render(); position(); };
   tab.onkeydown = event => {
    let to = index;
    if (event.key === "ArrowRight") to = (index + 1) % groups.length;
    else if (event.key === "ArrowLeft") to = (index + groups.length - 1) % groups.length;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = groups.length - 1;
    else return;
    event.preventDefault(); buttons[to].click(); buttons[to].focus();
   };
   return tab;
  });
  const updateTabs = () => {
   buttons.forEach((tab, index) => { tab.setAttribute("aria-selected", String(index === category)); tab.tabIndex = index === category ? 0 : -1; });
   grid.setAttribute("aria-labelledby", buttons[category].id);
  };
  tabs.hidden = !this.expanded;
  input.oninput = () => { limit = 80; render(); position(); };
  input.onkeydown = event => { if (event.key === "Enter" && !event.isComposing) { const results = matches(); if (results.length === 1) { event.preventDefault(); select(results[0][0]); } } };
  more.onclick = () => { const scroll = grid.scrollTop; limit += 80; render(); grid.scrollTop = scroll; position(); };
  const position = () => {
   if (!this.anchor.isConnected) { this.close(false); return; }
   const rect = this.anchor.getBoundingClientRect();
   const width = root.offsetWidth, height = root.offsetHeight;
   const left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, win.innerWidth - width - 8));
   const above = win.innerHeight - rect.bottom < height + 16 && rect.top > height + 16;
   root.dataset.side = above ? "above" : "below";
   root.style.left = `${left}px`;
   root.style.top = `${Math.max(8, Math.min(above ? rect.top - height - 10 : rect.bottom + 10, win.innerHeight - height - 8))}px`;
   root.style.setProperty("--relay-arrow-x", `${Math.max(12, Math.min(rect.left + rect.width / 2 - left - 5, width - 22))}px`);
  };
  const outside = (event: Event) => { if (!root.contains(event.target as Node)) this.close(false); };
  const keydown = (event: KeyboardEvent) => {
   if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
   else if (event.key === "Tab") {
    const focusable = Array.from(root.querySelectorAll<HTMLElement>('input,button')).filter(el => !el.hidden && !el.closest('[hidden]') && el.tabIndex >= 0);
    const index = focusable.indexOf(doc.activeElement as HTMLElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1)?.focus(); }
    else if (!event.shiftKey && index === focusable.length - 1) { event.preventDefault(); input.focus(); }
   }
  };
  doc.addEventListener("pointerdown", outside, true); root.addEventListener("keydown", keydown);
  win.addEventListener("resize", position); doc.addEventListener("scroll", position, true);
  const observer = new MutationObserver(() => { if (!this.anchor.isConnected) this.close(false); });
  observer.observe(doc.body, { childList: true, subtree: true });
  this.cleanup.push(() => { doc.removeEventListener("pointerdown", outside, true); root.removeEventListener("keydown", keydown); win.removeEventListener("resize", position); doc.removeEventListener("scroll", position, true); observer.disconnect(); });
  updateTabs(); render(); position(); input.focus();
 }
 close(focus = true): void {
  this.cleanup.splice(0).forEach(stop => stop()); this.contentEl.remove();
  this.anchor.setAttribute("aria-expanded", "false"); this.anchor.removeAttribute("aria-controls");
  if (opened.get(this.anchor.ownerDocument) === this) opened.delete(this.anchor.ownerDocument);
  if (focus && this.anchor.isConnected) this.anchor.focus();
 }
}
