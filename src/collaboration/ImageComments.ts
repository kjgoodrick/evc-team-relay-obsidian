import { Component, MarkdownView, Menu, Notice, type Plugin } from "obsidian";
import type { ShareRegistry } from "../VaultShare";
import type { DiscussionHost } from "./DiscussionHost";
import type { ImageCommentContext } from "./CommentEditor";
import type { DiscussionSession } from "./DiscussionSession";
import { parseAnchor, wireTextAnchor, type ImageAnchor } from "./DiscussionProtocol";
import { captureTextAnchor } from "./anchors/text";
import { imageAssetChanged, markdownImages, resolveImageOccurrence, type ImageOccurrence } from "./anchors/images";
import { ImageAssets } from "./ImageAssets";
import { ImageCommentModal } from "./ui/ImageCommentModal";

export class ImageComments extends Component {
	private assets: ImageAssets;
	private modal?: ImageCommentModal;
	private unobserve?: () => void;
	constructor(private host: DiscussionHost, private plugin: Plugin, shares: ShareRegistry) { super(); this.assets = new ImageAssets(plugin.app, shares); }
	onload(): void {
		this.plugin.addCommand({ id: "comment-image", name: "Comment on image", checkCallback: checking => {
			const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file || !this.host.targetFor(view.file).session?.canAnchorImages) return false;
			if (!checking) this.comment(view); return true;
		} });
		this.register(this.host.onChange(() => this.modal?.validate()));
		const changed = () => this.modal?.validate();
		this.registerEvent(this.plugin.app.vault.on("modify", changed));
		this.registerEvent(this.plugin.app.vault.on("rename", changed));
		this.registerEvent(this.plugin.app.vault.on("delete", changed));
	}
	comment(view: MarkdownView): void {
		try {
			const context = this.host.imageContext(view), source = context.text.toString();
			const images = markdownImages(source).filter(image => { try { this.assets.describe(context.file, image.destination); return true; } catch { return false; } });
			if (!images.length) { new Notice("No available shared or external image was found in this note. Wait for image synchronization, then try again."); return; }
			const selected = images.find(image => context.position !== undefined && image.from <= context.position && image.to >= context.position);
			const open = (image: ImageOccurrence) => {
				if (!context.current() || context.text.toString() !== source) { new Notice("The note changed. Choose the image again."); return; }
				this.draft(context, image);
			};
			if (selected || images.length === 1) { open(selected ?? images[0]); return; }
			const menu = new Menu();
			for (const [index, image] of images.entries()) menu.addItem(item => item.setTitle(`Image ${index + 1} · ${source.slice(image.from, image.to).slice(0, 100)}`).onClick(() => open(image)));
			const box = view.contentEl.getBoundingClientRect(); menu.showAtPosition({ x: box.left + 24, y: box.top + 48 });
		} catch { new Notice("Wait for the shared note and comment access to finish synchronizing, then try again."); }
	}
	private mount(context: ImageCommentContext, modal: ImageCommentModal): void {
		this.modal?.close(); this.unobserve?.(); this.modal = modal;
		const changed = () => modal.validate(); context.text.observe(changed); this.unobserve = () => context.text.unobserve(changed);
		modal.open();
	}
	private closed(): void { this.unobserve?.(); this.unobserve = undefined; this.modal = undefined; }
	private draft(context: ImageCommentContext, image: ImageOccurrence): void {
		try {
			const asset = this.assets.describe(context.file, image.destination);
			const frozen = { version: 1, type: "image", occurrence: wireTextAnchor(captureTextAnchor(context.text, context.entryId, context.generation, image.from, image.to)), asset,
				basis: { width: 1, height: 1, orientation: "display" }, geometry: { type: "whole" } } as ImageAnchor;
			const current = () => {
				if (!context.current() || !context.session.permission(context.entryId)?.comment) return false;
				const resolved = resolveImageOccurrence(context.text, context.entryId, context.generation, frozen);
				try { return resolved.status === "attached" && !imageAssetChanged(asset, this.assets.describe(context.file, resolved.image.destination)); } catch { return false; }
			};
			this.mount(context, new ImageCommentModal(this.plugin.app, { title: "Comment on image", current,
				load: () => this.assets.load(context.file, image.destination, current), closed: () => this.closed(),
				save: async (preview, basis, geometry) => {
					if (!current() || !preview.valid() || imageAssetChanged(asset, preview.asset)) throw new Error("Image changed");
					const anchor = parseAnchor({ ...frozen, asset: preview.asset, basis, geometry });
					if (!await this.host.saveCommentSelection({ ...context, anchor })) throw new Error("Draft not saved");
				},
			}));
		} catch { new Notice("This image could not be selected. Check access and synchronization, then try again."); }
	}
	reveal(view: MarkdownView, session: DiscussionSession, entryId: string, anchor: ImageAnchor): boolean {
		let context: ImageCommentContext;
		try { context = this.host.imageContext(view, false); } catch { return false; }
		if (context.session !== session || context.entryId !== entryId) return false;
		const resolved = resolveImageOccurrence(context.text, entryId, context.generation, anchor);
		if (resolved.status !== "attached") { new Notice("This image occurrence is unavailable or changed. The original target remains with its discussion."); return true; }
		try {
			const asset = this.assets.describe(context.file, resolved.image.destination);
			const current = () => {
				if (!context.current()) return false;
				const now = resolveImageOccurrence(context.text, entryId, context.generation, anchor);
				try { return now.status === "attached" && !imageAssetChanged(asset, this.assets.describe(context.file, now.image.destination)); } catch { return false; }
			};
			this.mount(context, new ImageCommentModal(this.plugin.app, { title: "Image discussion target", current, geometry: anchor.geometry, basis: anchor.basis,
				changed: imageAssetChanged(anchor.asset, asset), load: () => this.assets.load(context.file, resolved.image.destination, current), closed: () => this.closed() }));
		} catch { new Notice("This image is unavailable. The original target and discussion are retained."); }
		return true;
	}
	onunload(): void { this.modal?.close(); this.closed(); }
}
