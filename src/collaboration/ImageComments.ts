import { Component, MarkdownView, Menu, Notice, type Plugin, type TFile } from "obsidian";
import type { ShareRegistry } from "../VaultShare";
import type { DiscussionHost, ImageFileCommentContext } from "./DiscussionHost";
import type { ImageCommentContext } from "./CommentEditor";
import type { DiscussionSession } from "./DiscussionSession";
import { parseAnchor, wireTextAnchor, type ImageAnchor, type ImageFileAnchor } from "./DiscussionProtocol";
import { captureTextAnchor } from "./anchors/text";
import { imageAssetChanged, markdownImages, resolveImageOccurrence, type ImageOccurrence } from "./anchors/images";
import { ImageAssets, type ImagePreview } from "./ImageAssets";
import { ImageCommentModal } from "./ui/ImageCommentModal";
import { RenderedImagePlacement, type ImagePlacementSurface } from "./ui/RenderedImagePlacement";
import type { ImageAsset, ImageBasis, ImageGeometry } from "./anchors/imageGeometry";
import { RenderedImageComments } from "./RenderedImageComments";
import { ImageFileOverlays } from "./ImageFileOverlays";

export class ImageComments extends Component {
	private assets: ImageAssets;
	private modal?: ImageCommentModal | RenderedImagePlacement;
	private unobserve?: () => void;
	private request = 0;
	private stopped = false;
	constructor(private host: DiscussionHost, private plugin: Plugin, shares: ShareRegistry) { super(); this.assets = new ImageAssets(plugin.app, shares); }
	onload(): void {
		this.addChild(new RenderedImageComments(this.host, this.plugin, this.assets, (context, image, surface) => this.draft(context, image, surface)));
		this.addChild(new ImageFileOverlays(this.host, this.plugin, this.assets, (file, surface) => { void this.commentFile(file, surface); }));
		this.plugin.addCommand({ id: "comment-image", name: "Comment on image", checkCallback: checking => {
			const file = this.plugin.app.workspace.getActiveFile(), target = file ? this.host.targetFor(file) : undefined;
			if (file && target?.kind === "image" && target.session?.canAnchorImageFiles) {
				if (!checking) void this.commentFile(file); return true;
			}
			const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view?.file || !this.host.targetFor(view.file).session?.canAnchorImages) return false;
			if (!checking) this.comment(view); return true;
		} });
		this.register(this.host.onChange(() => this.modal?.validate()));
		const changed = () => this.modal?.validate();
		this.registerEvent(this.plugin.app.vault.on("modify", changed));
		this.registerEvent(this.plugin.app.vault.on("rename", changed));
		this.registerEvent(this.plugin.app.vault.on("delete", changed));
		this.registerEvent(this.plugin.app.workspace.on("layout-change", changed));
		this.registerEvent(this.plugin.app.workspace.on("file-open", changed));
	}
	comment(view: MarkdownView): void {
		this.request++;
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
	private mount(context: ImageCommentContext | ImageFileCommentContext, modal: ImageCommentModal | RenderedImagePlacement, retain?: () => void): void {
		this.modal?.close(); this.unobserve?.(); this.modal = modal;
		if ("text" in context) {
			const changed = () => modal.validate(); context.text.observe(changed); this.unobserve = () => { context.text.unobserve(changed); retain?.(); };
		} else this.unobserve = retain;
		modal.open();
	}
	private closed(): void { this.unobserve?.(); this.unobserve = undefined; this.modal = undefined; }
	private author(context: ImageCommentContext | ImageFileCommentContext, asset: ImageAsset, current: () => boolean,
		load: () => Promise<ImagePreview>, save: (basis: ImageBasis, geometry: ImageGeometry) => Promise<void>, surface?: ImagePlacementSurface): void {
		const show = (geometry?: ImageGeometry, basis?: ImageBasis, inline?: ImagePlacementSurface) => {
			const retain = "text" in context ? undefined : context.session.watch(context.entryId, () => this.modal?.validate(), "image");
			const modal = () => new ImageCommentModal(this.plugin.app, { title: "Comment on image", current, load, geometry, basis, closed: () => this.closed(),
				save: async (preview, measured, selected) => {
					if (!current() || !preview.valid() || imageAssetChanged(asset, preview.asset)) throw new Error("Image changed");
					await save(measured, selected);
				} });
			if (!inline) { this.mount(context, modal(), retain); return; }
			try {
				// The verified surface invalidates synchronously with source/version
				// changes. Repaint only needs that proof and current comment access;
				// resolving the relative source occurrence again belongs at Save.
				const canPlace = () => !this.stopped && !!context.session.permission(context.entryId)?.comment &&
					("text" in context ? context.session.canAnchorImages : context.session.canAnchorImageFiles);
				this.mount(context, new RenderedImagePlacement({ surface: inline, current: canPlace, external: asset.kind === "external", closed: () => this.closed(),
					save: async (measured, selected) => {
						if (!current() || !inline.current()) throw new Error("Image changed");
						await save(measured, selected);
					}, preview: (selected, measured) => show(selected, measured),
				}), retain);
			} catch {
				this.modal?.close(); // Unsupported transforms/preview decoding retain the full-size placement workflow.
				show(geometry, basis);
			}
		};
		show(undefined, undefined, surface);
	}
	private draft(context: ImageCommentContext, image: ImageOccurrence, surface?: ImagePlacementSurface): void {
		this.request++;
		try {
			const asset = this.assets.describe(context.file, image.destination);
			const frozen = { version: 1, type: "image", occurrence: wireTextAnchor(captureTextAnchor(context.text, context.entryId, context.generation, image.from, image.to)), asset,
				basis: { width: 1, height: 1, orientation: "display" }, geometry: { type: "whole" } } as ImageAnchor;
			const current = () => {
				if (!context.current() || !context.session.permission(context.entryId)?.comment) return false;
				const resolved = resolveImageOccurrence(context.text, context.entryId, context.generation, frozen);
				try { return resolved.status === "attached" && !imageAssetChanged(asset, this.assets.describe(context.file, resolved.image.destination)); } catch { return false; }
			};
			this.author(context, asset, current, () => this.assets.load(context.file, image.destination, current), async (basis, geometry) => {
				if (!current()) throw new Error("Image changed");
				const anchor = parseAnchor({ ...frozen, basis, geometry });
				if (!await this.host.saveCommentSelection({ ...context, anchor })) throw new Error("Draft not saved");
			}, surface);
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
	async commentFile(file: TFile, surface?: ImagePlacementSurface): Promise<void> {
		const serial = ++this.request, target = this.host.targetFor(file), session = target.session, entryId = target.entryId;
		if (!session || !entryId || target.kind !== "image" || !session.canAnchorImageFiles) return;
		let release: (() => void) | undefined;
		try {
			release = session.watch(entryId, () => this.modal?.validate(), "image"); await session.refresh();
			if (this.stopped || serial !== this.request) return;
			const context = this.host.imageFileContext(file), asset = this.assets.describeFile(file);
			const current = () => {
				try { return context.current() && !imageAssetChanged(asset, this.assets.describeFile(file)); } catch { return false; }
			};
			this.author(context, asset, current, () => this.assets.loadFile(file, current), async (basis, geometry) => {
				if (!current()) throw new Error("Image changed");
				const anchor = parseAnchor({ version: 1, type: "image_file", generation: context.generation, asset, basis, geometry });
				if (!await this.host.saveCommentSelection({ ...context, anchor })) throw new Error("Draft not saved");
			}, surface);
		} catch { if (!this.stopped && serial === this.request) new Notice("This image is not ready for comments. Check comment access and image synchronization, then try again."); }
		finally { release?.(); }
	}
	revealFile(file: TFile, session: DiscussionSession, entryId: string, anchor: ImageFileAnchor): void {
		this.request++;
		try {
			const context = this.host.imageFileContext(file, false), asset = this.assets.describeFile(file);
			if (context.session !== session || context.entryId !== entryId || anchor.asset.entry_id !== entryId) return;
			const current = () => {
				try { return context.current() && !imageAssetChanged(asset, this.assets.describeFile(file)); } catch { return false; }
			};
			this.mount(context, new ImageCommentModal(this.plugin.app, { title: "Image-file discussion target", current,
				geometry: anchor.geometry, basis: anchor.basis, changed: anchor.generation !== context.generation || imageAssetChanged(anchor.asset, asset),
				load: () => this.assets.loadFile(file, current), closed: () => this.closed() }));
		} catch { new Notice("This image is unavailable. The original target and discussion are retained."); }
	}
	onunload(): void { this.stopped = true; this.request++; this.modal?.close(); this.closed(); }
}
