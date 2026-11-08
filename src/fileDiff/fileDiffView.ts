import { structuredPatch } from "diff";
import { trackNativeDocumentWrite } from "../storage/native-document-writes";
import {
	Workspace,
	ItemView,
	TFile,
	type ViewStateResult,
	WorkspaceLeaf,
} from "obsidian";
import { namedLogger } from "src/logging";
import { Document } from "src/Document";
import { UnsavedFile } from "src/UnsavedFile";
import { currentToggles } from "src/featureToggleState";
import { applyDiffToYText } from "src/ytextDiff";
import { HunkActionBar } from "./hunkActionBar";
import { HunkActionButton } from "./hunkActionButton";
import { HunkActionDivider } from "./hunkActionDivider";
import { buildDiffLine } from "./buildDiffLine";
import { DiffHunk } from "./diffHunk";
import { FileDiffResult } from "./fileDiffResult";
import { ensureVisibleRowText } from "./lineSpanUtils";

export const VIEW_TYPE_FILE_DIFF = "evc-team-relay-differences-view";

/**
 * Everything either side of a diff can actually be at runtime.
 *
 * This used to read `TFile` alone, which was never true: both real callers
 * (`ViewBindings.openDiffView()` and `y-codemirror.next/LiveEditPlugin`) pass
 * a live CRDT `Document` as `leftFile` for a merge conflict. That compiled with
 * no cast only because `Document` happened to declare every field `TFile`
 * declares, so a `TFile`-typed slot accepted it structurally — and any read of
 * a `TFile` field on it resolved by coincidence rather than by contract.
 * Spelling the union out makes the compiler demand a narrowing before any
 * per-kind field is touched, which is what `modify()`/`readContent()` below
 * were already doing by hand.
 */
export type DiffViewFile = TFile | Document | UnsavedFile;

export interface DiffViewState {
	leftFile: DiffViewFile;
	rightFile: DiffViewFile;
	allowMergeActions: boolean;
	onMergeResolved?: () => Promise<void>;
	returnLeaf?: WorkspaceLeaf;
	[key: string]: unknown;
}

/** Opens (or re-opens, replacing any existing one) the side-by-side diff/merge view. */
export function launchFileDiffView(workspace: Workspace, state: DiffViewState): void {
	if (!state.returnLeaf) {
		state.returnLeaf = workspace.getMostRecentLeaf() ?? undefined;
	}

	workspace.detachLeavesOfType(VIEW_TYPE_FILE_DIFF);

	const leaf = workspace.getLeaf(true);
	void leaf.setViewState({ type: VIEW_TYPE_FILE_DIFF, active: true, state });
	void workspace.revealLeaf(leaf);
}

/**
 * Renders a line-by-line diff between two files (`DiffViewState.leftFile`/`rightFile`),
 * one row per shared line and a merge-action block for each block of lines
 * that actually differs. `leftFile`/`rightFile` are addressed generically — either
 * one can be a live CRDT `Document`, an in-memory `UnsavedFile`, or a plain
 * vault `TFile` — so writes always go through `writeFile()` rather than the
 * vault API directly.
 */
export class FileDiffView extends ItemView {
	private viewState?: DiffViewState;
	private leftContent?: string;
	private rightContent?: string;
	private leftLines: string[] = [];
	private rightLines: string[] = [];
	private diffResult?: FileDiffResult;
	protected log;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.log = namedLogger(`[${this.constructor.name}]`, "log");
	}

	override getViewType(): string {
		return VIEW_TYPE_FILE_DIFF;
	}

	override getDisplayText(): string {
		if (this.viewState?.leftFile && this.viewState?.rightFile) {
			const label1 = FileDiffView.labelOf(this.viewState.leftFile);
			const label2 = FileDiffView.labelOf(this.viewState.rightFile);
			return `File Diff: ${label1} and ${label2}`;
		}
		return `File diff`;
	}

	/**
	 * The human-readable name of one side, for the view's tab title.
	 *
	 * `UnsavedFile` needs no branch of its own here (unlike in
	 * `modify()`/`readContent()`, where it genuinely behaves differently): it
	 * `implements TFile` and declares `name` as its own field, so reading
	 * `.name` off it is its real contract, not a coincidence. `Document` is
	 * the one that only ever *looked* like a `TFile`.
	 */
	private static labelOf(file: DiffViewFile): string {
		if (file instanceof Document) {
			return file.docLabel;
		}
		return file.name;
	}

	/** The path of one side, used as its header in the generated patch. */
	private static pathOf(file: DiffViewFile): string {
		if (file instanceof Document) {
			return file.entryPath;
		}
		return file.path;
	}

	override async setState(state: DiffViewState, result: ViewStateResult): Promise<void> {
		void super.setState(state, result);
		this.viewState = state;
		await this.recomputeDiff();
		this.render();
	}

	onunload(): void {
		void this.viewState?.onMergeResolved?.();
	}

	async writeFile(file: DiffViewFile, newContent: string): Promise<void> {
		if (file instanceof Document) {
			applyDiffToYText(file.crdtDoc, newContent, this);
			return;
		}
		if (file instanceof UnsavedFile) {
			file.unsavedText = newContent;
			return;
		}
		await trackNativeDocumentWrite(this.app.vault, file.path, () => this.app.vault.modify(file, newContent));
	}

	private async readContent(file: DiffViewFile): Promise<string> {
		if (file instanceof Document) {
			return file.content;
		}
		if (file instanceof UnsavedFile) {
			return file.unsavedText;
		}
		return await this.app.vault.read(file);
	}

	/** Normalizes a file's text into the line array the diff/renderer works against. */
	private static toComparableLines(content: string): string[] {
		// A trailing newline + trimmed line endings sidestep a handful of
		// edge cases around EOF and trailing whitespace producing spurious hunks.
		return content
			.concat("\n")
			.split("\n")
			.map((line) => line.trimEnd());
	}

	private async recomputeDiff(): Promise<void> {
		if (this.viewState?.leftFile == null || this.viewState?.rightFile == null) {
			return;
		}

		this.leftContent = await this.readContent(this.viewState.leftFile);
		this.rightContent = await this.readContent(this.viewState.rightFile);
		this.leftLines = FileDiffView.toComparableLines(this.leftContent);
		this.rightLines = FileDiffView.toComparableLines(this.rightContent);

		const parsedDiff = structuredPatch(
			FileDiffView.pathOf(this.viewState.leftFile),
			FileDiffView.pathOf(this.viewState.rightFile),
			this.leftLines.join("\n"),
			this.rightLines.join("\n"),
		);
		this.diffResult = FileDiffResult.fromStructuredPatch(parsedDiff);

		if (this.diffResult.hunks.length === 0) {
			await this.resolveByteIdenticalMismatch();
			this.closeAndFocusOriginal();
		}
	}

	/**
	 * The line-based differ can find zero hunks while the raw file contents
	 * still differ (e.g. only whitespace/EOF handling changed). When that
	 * happens there's nothing meaningful to show the user — just take the
	 * left file as the resolution so the two files converge.
	 */
	private async resolveByteIdenticalMismatch(): Promise<void> {
		if (!this.viewState || this.leftContent === this.rightContent) {
			return;
		}
		const content1 = this.leftContent ?? "";
		const content2 = this.rightContent ?? "";
		this.log("byte level difference with differ equivalence", content1.length, content2.length);
		if (currentToggles().enableDeltaLogging) {
			this.logFirstByteMismatches(content1, content2);
		}
		await this.writeFile(this.viewState.rightFile, content1);
	}

	private logFirstByteMismatches(content1: string, content2: string): void {
		const maxLength = Math.max(content1.length, content2.length);
		const asHex = (code: number | undefined) =>
			code !== undefined ? `0x${code.toString(16).padStart(2, "0")}` : "EOF";

		for (let i = 0; i < maxLength; i++) {
			const byte1 = i < content1.length ? content1.charCodeAt(i) : undefined;
			const byte2 = i < content2.length ? content2.charCodeAt(i) : undefined;
			if (byte1 !== byte2) {
				this.log(
					`Byte difference at position ${i}: left=${byte1} (${asHex(byte1)}), right=${byte2} (${asHex(byte2)})`,
				);
			}
		}
	}

	private render(): void {
		this.contentEl.empty();
		const container = this.contentEl.createDiv({ cls: "evc-file-diff__container" });
		this.renderHeader(container);
		this.renderLines(container);
		this.scrollToFirstHunk();
	}

	/** Same as render(), but preserves scroll position — used after an in-place edit. */
	private rerenderInPlace(): void {
		const scrollTop = this.contentEl.scrollTop;
		this.contentEl.empty();
		const container = this.contentEl.createDiv({ cls: "evc-file-diff__container" });
		this.renderHeader(container);
		this.renderLines(container);
		this.contentEl.scrollTop = scrollTop;
	}

	private renderHeader(container: HTMLDivElement): void {
		const actionLine = container.createDiv({ cls: "flex flex-row gap-1 py-0-5" });

		new HunkActionButton({
			label: `Keep Editor Contents`,
			onActivate: (e) => {
				e.preventDefault();
				void this.acceptAllFrom("left");
			},
		}).renderInto(actionLine);

		HunkActionDivider.build(actionLine);

		new HunkActionButton({
			label: `Accept All from Local Disk`,
			onActivate: (e) => {
				e.preventDefault();
				void this.acceptAllFrom("right");
			},
		}).renderInto(actionLine);
	}

	/** Overwrites the OTHER file with `winner`'s content, resolves, and closes the view. */
	private async acceptAllFrom(winner: "left" | "right"): Promise<void> {
		if (!this.viewState || !this.diffResult) return;
		const target = winner === "left" ? this.viewState.rightFile : this.viewState.leftFile;
		const content = winner === "left" ? this.leftContent : this.rightContent;
		await this.writeFile(target, content || "");
		await this.viewState.onMergeResolved?.();
		this.closeAndFocusOriginal();
	}

	private closeAndFocusOriginal(): void {
		if (this.viewState?.returnLeaf?.parent) {
			this.app.workspace.setActiveLeaf(this.viewState.returnLeaf, { focus: true });
		}
		this.leaf.detach();
	}

	private renderLines(container: HTMLDivElement): void {
		const maxLineCount = Math.max(this.leftLines?.length || 0, this.rightLines?.length || 0);
		let cursor1 = 0;
		let cursor2 = 0;

		while (cursor1 <= maxLineCount || cursor2 <= maxLineCount) {
			const hunk = this.diffResult?.hunks.find(
				(d) => d.leftStart === cursor1 && d.rightStart === cursor2,
			);

			if (hunk != null) {
				const hunkContainer = container.createDiv({ cls: "difference" });
				this.renderDifferenceBlock(hunkContainer, hunk);
				cursor1 += hunk.leftLines.length;
				cursor2 += hunk.rightLines.length;
				continue;
			}

			const sharedLine =
				cursor1 <= cursor2 ? this.leftLines[cursor1] : this.rightLines[cursor2];
			container.createDiv({
				// A truly empty text node collapses to zero height in Obsidian.
				text: ensureVisibleRowText(sharedLine),
				cls: "evc-file-diff__line",
			});
			cursor1 += 1;
			cursor2 += 1;
		}
	}

	private renderDifferenceBlock(container: HTMLDivElement, difference: DiffHunk): void {
		if (this.viewState?.allowMergeActions) {
			new HunkActionBar(this.app, {
				hunk: difference,
				leftFile: this.viewState.leftFile,
				rightFile: this.viewState.rightFile,
				leftContent: this.leftContent || "",
				rightContent: this.rightContent || "",
				requestRebuild: () => {
					void this.recomputeDiff().then(() => this.rerenderInPlace());
				},
			}).render(container);
		}

		const leftCount = difference.leftLines.length;
		const rightCount = difference.rightLines.length;

		this.renderDiffSide({
			container,
			primary: difference.leftLines,
			secondary: difference.rightLines,
			bgClass: "evc-file-diff__top-line__bg",
			charClass: "evc-file-diff_top-line__character",
			noBottomBorder: (i) => i < leftCount - 1 || rightCount !== 0,
			noTopBorder: (i) => i !== 0,
		});

		this.renderDiffSide({
			container,
			primary: difference.rightLines,
			secondary: difference.leftLines,
			bgClass: "evc-file-diff__bottom-line__bg",
			charClass: "evc-file-diff_bottom-line__character",
			noTopBorder: (i) => (i === 0 && leftCount > 0) || i > 0,
			noBottomBorder: (i) => i < rightCount - 1,
		});
	}

	/**
	 * Renders one side (top = left-as-primary, bottom = right-as-primary) of
	 * a difference block. Both sides share the same per-line layout — only
	 * which array is "primary" vs "secondary", the CSS classes, and the
	 * border-collapsing rule at the block's edges differ.
	 */
	private renderDiffSide(args: {
		container: HTMLDivElement;
		primary: string[];
		secondary: string[];
		bgClass: string;
		charClass: string;
		noTopBorder: (index: number) => boolean;
		noBottomBorder: (index: number) => boolean;
	}): void {
		for (let i = 0; i < args.primary.length; i += 1) {
			const lineDiv = args.container.createDiv({
				cls: `evc-file-diff__line ${args.bgClass}`,
			});
			const diffSpans = buildDiffLine(args.primary[i], args.secondary[i], args.charClass);

			if (args.noBottomBorder(i)) {
				lineDiv.classList.add("evc-file-diff__no-bottom-border");
			}
			if (args.noTopBorder(i)) {
				lineDiv.classList.add("evc-file-diff__no-top-border");
			}

			lineDiv.appendChild(diffSpans);
		}
	}

	private scrollToFirstHunk(): void {
		if (this.diffResult?.hunks.length === 0) {
			return;
		}

		const containerRect = this.contentEl
			.getElementsByClassName("evc-file-diff__container")[0]
			.getBoundingClientRect();
		const firstDiffRect = this.contentEl
			.getElementsByClassName("difference")[0]
			.getBoundingClientRect();

		this.contentEl.scrollTo({
			top: firstDiffRect.top - containerRect.top - 100,
			behavior: "smooth",
		});
	}
}
