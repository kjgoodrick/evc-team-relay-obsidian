import type { DiscussionSession } from "../DiscussionSession";
import { PictureOfflineError, type PictureBlock, type PictureVariant } from "../PictureProtocol";

/** Owns one displayed blob URL; disposal, scrolling offscreen and account/access
 * loss remove both decoded pixels and the URL, including late HTTP responses.
 */
export class CommentPicture {
	readonly el: HTMLElement;
	private image: HTMLImageElement;
	private frame: HTMLElement;
	private status: HTMLElement;
	private button: HTMLButtonElement;
	private observer?: IntersectionObserver;
	private stopWatching: () => void;
	private url?: string;
	private serial = 0;
	private disposed = false;
	private visible = true;
	private variant: PictureVariant = "thumbnail";
	private localContent?: boolean;
	constructor(parent: HTMLElement, private session: DiscussionSession, private entryId: string, private picture: PictureBlock, private local = false) {
		this.el = parent.createEl("figure", { cls: "relay-comment-picture" });
		this.frame = this.el.createDiv({ cls: "relay-comment-picture-frame" });
		this.image = this.frame.createEl("img", { attr: { alt: picture.alt || "Picture attached to comment", decoding: "async" } });
		this.image.hidden = true;
		this.status = this.el.createEl("figcaption", { text: "Picture", attr: { role: "status" } });
		this.button = this.el.createEl("button", { text: "Load picture", attr: { type: "button" } });
		this.button.onclick = () => { if (this.url && !this.local) this.variant = "content"; void this.load(); };
		this.stopWatching = session.onChange(() => {
			if (!this.allowed()) { this.clear(); this.status.setText("Picture unavailable. Reconnect or check access."); this.button.disabled = true; }
			else if (!this.url) this.button.disabled = false;
		});
		const Observer = this.el.ownerDocument.defaultView?.IntersectionObserver;
		if (Observer) {
			this.visible = false;
			this.observer = new Observer(entries => {
				this.visible = entries.some(entry => entry.isIntersecting);
				if (this.visible) void this.load(); else this.clear();
			});
			this.observer.observe(this.el);
		} else void this.load();
	}
	setAlt(alt: string): void { this.image.alt = alt || "Picture attached to comment"; }
	private allowed(): boolean {
		return !this.disposed && this.session.status !== "closed" && (this.local && this.localContent !== false ||
			!!this.session.permission(this.entryId)?.read && !["authentication_required", "unavailable", "error"].includes(this.session.status));
	}
	private clear(): void {
		this.serial++; this.image.removeAttribute("src"); this.image.hidden = true;
		if (this.url) { this.el.ownerDocument.defaultView!.URL.revokeObjectURL(this.url); this.url = undefined; }
		this.button.hidden = false; this.button.disabled = false; this.button.setText("Load picture");
	}
	private async load(): Promise<void> {
		if (!this.allowed() || !this.visible) return;
		const serial = ++this.serial;
		this.button.disabled = true; this.status.setText("Loading picture…");
		try {
			const content = await this.session.pictures.load(this.entryId, this.picture.picture_id, this.variant, this.local);
			this.localContent = content.local;
			if (serial !== this.serial || !this.allowed() || !this.visible) return;
			const view = this.el.ownerDocument.defaultView!;
			const url = view.URL.createObjectURL(new view.Blob([content.bytes], { type: content.mime }));
			if (this.url) view.URL.revokeObjectURL(this.url); this.url = url;
			this.image.onerror = () => { if (serial === this.serial) { this.clear(); this.status.setText("This picture could not be displayed. Retry to load it again."); } };
			this.image.src = url; this.image.hidden = false;
			this.image.width = content.width; this.image.height = content.height;
			// Preserve layout after releasing offscreen decoded pixels. Collapsing
			// the image would move other images into view and cause a load/unload loop.
			this.frame.style.aspectRatio = `${content.width} / ${content.height}`;
			this.frame.style.maxWidth = `${content.width}px`;
			this.status.setText(content.local ? "Saved on this device" : content.offline ? "Saved copy · offline" : "");
			this.button.setText("Load full size"); this.button.disabled = false;
			this.button.hidden = content.local || this.variant === "content";
		} catch (error) {
			if (serial !== this.serial || this.disposed) return;
			if (this.url && this.allowed() && error instanceof PictureOfflineError) {
				this.variant = "thumbnail"; this.button.hidden = false; this.button.disabled = false; this.button.setText("Retry full size");
				this.status.setText("Full size could not be loaded. The saved preview is shown."); return;
			}
			this.clear(); this.status.setText("Picture unavailable. Reconnect or check access, then retry.");
		}
	}
	dispose(): void { this.disposed = true; this.observer?.disconnect(); this.stopWatching(); this.clear(); this.el.remove(); }
}
