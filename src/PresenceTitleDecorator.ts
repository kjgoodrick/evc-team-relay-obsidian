import { Loggable } from "./logging";
import { MarkdownView } from "obsidian";
import { Document } from "./Document";
import { type DocumentViewBinding } from "./ViewBindings";
import CollaboratorAwareness from "./components/CollaboratorAwareness.svelte";
import { mountComponent, type MountedComponent } from "./svelteMount";

const WRAPPER_CLASS = "title-with-awareness";

/**
 * Splice a wrapper `<div>` in around the note's inline-title element and
 * return an (always-created) sibling container for the awareness avatars, or
 * `null` if there's no inline-title element to anchor to at all.
 *
 * NB: the wrapper/avatar-container elements are still built and returned
 * even if `inlineTitle` unexpectedly has no `parentNode` to splice into —
 * matching the pre-rewrite shape, which only bailed on a missing
 * inline-title, not a detached one. In practice `inlineTitle` is found via
 * `containerEl.querySelector`, so it's always attached and this is dead.
 */
function wrapInlineTitle(containerEl: HTMLElement): HTMLElement | null {
	const inlineTitle = containerEl.querySelector<HTMLElement>(".inline-title");
	if (!inlineTitle) {
		return null;
	}

	const wrapper = createDiv({
		cls: [WRAPPER_CLASS, "evc-flex", "evc-align-center", "evc-justify-between", "evc-w-full"],
	});

	const avatarContainer = createDiv({ cls: "evc-user-awareness-container" });

	if (inlineTitle.parentNode) {
		inlineTitle.parentNode.insertBefore(wrapper, inlineTitle);
		wrapper.appendChild(inlineTitle);
		wrapper.appendChild(avatarContainer);
	}

	return avatarContainer;
}

/** Undo wrapInlineTitle(): pull the inline-title back out and drop the wrapper. */
function unwrapInlineTitle(avatarContainer: HTMLElement): void {
	const wrapper = avatarContainer.parentElement;
	if (!wrapper?.classList.contains(WRAPPER_CLASS)) {
		avatarContainer.remove();
		return;
	}
	// NB: if the wrapper's there but the inline-title isn't found inside it
	// (foreign DOM mutation), neither side is torn down here — matches the
	// pre-rewrite behavior, which also silently no-ops in that case rather
	// than removing a wrapper that might still be load-bearing.
	const inlineTitle = wrapper.querySelector(".inline-title");
	if (inlineTitle && wrapper.parentNode) {
		wrapper.parentNode.insertBefore(inlineTitle, wrapper);
		wrapper.remove();
	}
}

export class PresenceTitleDecorator extends Loggable {
	documentBinding: DocumentViewBinding<MarkdownView>;
	liveDocument: Document;
	private dismantled = false;
	private generation = 0;
	private stopAuth?: () => void;
	private avatarsComponent?: MountedComponent<Record<string, unknown>>;
	private avatarsContainerEl?: HTMLElement;

	constructor(view: DocumentViewBinding<MarkdownView>) {
		super();
		this.documentBinding = view;
		this.liveDocument = view.boundDocument;
		this.setLoggers(`[AwarenessView](${this.liveDocument.entryPath})`);
		this.stopAuth = this.liveDocument.authSession.on(() => this.updateIdentity());
		void this.attachAwareness();
	}

	rebind(view: DocumentViewBinding<MarkdownView>): void {
		this.documentBinding = view; this.liveDocument = view.boundDocument;
		this.generation++;
		// Obsidian can replace the inline-title host when switching view modes.
		// Move the existing image tree rather than remounting it in that case.
		const title = view.hostView.containerEl.querySelector(".inline-title");
		if (this.avatarsContainerEl && title && title.parentElement !== this.avatarsContainerEl.parentElement) {
			const slot = wrapInlineTitle(view.hostView.containerEl);
			if (slot) { unwrapInlineTitle(this.avatarsContainerEl); slot.replaceWith(this.avatarsContainerEl); }
		}
		// Never carry another note's remote participants into the destination.
		this.updateIdentity();
		void this.attachAwareness();
	}

	private identityProps() {
		const user = this.liveDocument.authSession.getCurrentUserForServer(this.liveDocument.onpremServerId);
		return { authorized: !!user, fallbackSelf: user ? { id: user.accountId, name: user.fullName, avatarUrl: user.avatarUrl } : undefined };
	}
	private updateIdentity(): void {
		if (!this.dismantled) this.avatarsComponent?.update({ collabAwareness: this.liveDocument._liveProvider.awareness, ...this.identityProps() });
	}

	private async attachAwareness() {
		if (!this.documentBinding || this.dismantled) return;

		this.log("Installing awareness component for", this.documentBinding.hostView.file?.path);

		// Wait for the document to be ready
		const generation = this.generation;
		await this.liveDocument.awaitFullyConnected();
		if (this.dismantled || generation !== this.generation) return;
		if (this.avatarsComponent && this.avatarsContainerEl?.isConnected) {
			this.updateIdentity(); return;
		}

		// Set up the awareness component immediately - it will handle connection states
		this.setupAwarenessComponent();
	}

	private setupAwarenessComponent() {
		if (!this.documentBinding.hostView.containerEl || this.dismantled) return;

		const avatarContainer = wrapInlineTitle(this.documentBinding.hostView.containerEl);
		if (!avatarContainer) {
			this.warn("Could not find inline-title element to position awareness component");
			return;
		}
		this.avatarsContainerEl = avatarContainer;

		const awareness = this.liveDocument._liveProvider?.awareness;
		if (!awareness) {
			this.warn("No awareness provider available");
			return;
		}

		try {
			this.avatarsComponent = mountComponent(CollaboratorAwareness, {
				target: avatarContainer,
				props: {
					collabAwareness: awareness,
					...this.identityProps(),
				},
			});
			this.log("Awareness component successfully mounted");
		} catch (error: unknown) {
			this.warn("Failed to create awareness component:", error);
		}
	}

	private teardownAwarenessComponent(): void {
		if (!this.avatarsComponent) return;
		try {
			this.avatarsComponent.destroy();
			this.avatarsComponent = undefined;
			this.log("Awareness component destroyed");
		} catch (error: unknown) {
			this.warn("Error destroying awareness component:", error);
		}
	}

	dismantle() {
		this.dismantled = true;
		this.stopAuth?.(); this.stopAuth = undefined;

		this.teardownAwarenessComponent();

		if (this.avatarsContainerEl) {
			unwrapInlineTitle(this.avatarsContainerEl);
			this.avatarsContainerEl = undefined;
		}

		this.documentBinding = null as unknown as DocumentViewBinding<MarkdownView>;
		this.liveDocument = null as unknown as Document;
	}
}
