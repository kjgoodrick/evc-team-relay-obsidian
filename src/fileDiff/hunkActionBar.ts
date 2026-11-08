import type { App } from "obsidian";
import { trackNativeDocumentWrite } from "../storage/native-document-writes";
import { Document } from "src/Document";
import { UnsavedFile } from "src/UnsavedFile";
import type { DiffViewFile } from "./fileDiffView";
import { applyDiffToYText } from "src/ytextDiff";
import { HunkActionButton } from "./hunkActionButton";
import { HunkActionDivider } from "./hunkActionDivider";
import { DiffHunk } from "./diffHunk";
import { removeLineSpan, insertLineAt, replaceLineSpan } from "./lineSpanUtils";

type NoArgCallback = () => void;

interface ActionLineArgs {
	hunk: DiffHunk;
	leftFile: DiffViewFile;
	rightFile: DiffViewFile;
	leftContent: string;
	rightContent: string;
	requestRebuild: NoArgCallback;
}

/** One button of an action line: its label and what it does when clicked. */
interface ActionSpec {
	text: string;
	run: (hunk: DiffHunk) => Promise<void>;
}

/**
 * The row of buttons drawn above a diff hunk ("Accept Top", "Discard on
 * Disk", ...) that let the user resolve a single conflicting block of lines
 * without leaving the merge view. Which buttons appear depends on whether the
 * hunk has content on the left side, the right side, or both.
 */
export class HunkActionBar {
	private readonly hunk: DiffHunk;
	private readonly leftFile: DiffViewFile;
	private readonly rightFile: DiffViewFile;
	private readonly leftContent: string;
	private readonly rightContent: string;
	private readonly requestRebuild: NoArgCallback;

	constructor(
		private obsidianApp: App,
		args: ActionLineArgs,
	) {
		this.hunk = args.hunk;
		this.leftFile = args.leftFile;
		this.rightFile = args.rightFile;
		this.leftContent = args.leftContent;
		this.rightContent = args.rightContent;
		this.requestRebuild = args.requestRebuild;
	}

	render(container: HTMLDivElement): void {
		const actionLine = container.createDiv({ cls: "flex flex-row gap-1 py-0-5" });
		for (const action of this.actionsForThisHunk()) {
			if (actionLine.childElementCount > 0) {
				HunkActionDivider.build(actionLine);
			}
			new HunkActionButton({
				label: action.text,
				onActivate: (e) => {
					e.preventDefault();
					void action.run(this.hunk).then(() => this.requestRebuild());
				},
			}).renderInto(actionLine);
		}
	}

	/** Picks the applicable button set for the current hunk's shape. */
	private actionsForThisHunk(): ActionSpec[] {
		const hasFile1Lines = this.hunk.leftLines.length > 0;
		const hasFile2Lines = this.hunk.rightLines.length > 0;

		if (hasFile1Lines && hasFile2Lines) {
			return [
				{ text: "Accept Top (Editor)", run: (d) => this.overwriteFile2WithFile1(d) },
				{ text: "Accept Bottom (Local Disk)", run: (d) => this.overwriteFile1WithFile2(d) },
				{ text: "Accept All", run: (d) => this.keepBothOnBothFiles(d) },
				{ text: "Accept None", run: (d) => this.dropHunkFromBothFiles(d) },
			];
		}
		if (hasFile1Lines) {
			return [
				{ text: `Keep in Editor`, run: (d) => this.copyFile1LinesIntoFile2(d) },
				{ text: "Discard in Editor", run: (d) => this.dropHunkFromFile1(d) },
			];
		}
		if (hasFile2Lines) {
			return [
				{ text: `Accept from Local Disk`, run: (d) => this.copyFile2LinesIntoFile1(d) },
				{ text: "Discard on Disk", run: (d) => this.dropHunkFromFile2(d) },
			];
		}
		return [];
	}

	/** Writes `newContent` back to `file`, routing through the CRDT/buffer/vault as appropriate. */
	private async writeFile(file: DiffViewFile, newContent: string): Promise<void> {
		if (file instanceof Document) {
			applyDiffToYText(file.crdtDoc, newContent, file);
			return;
		}
		if (file instanceof UnsavedFile) {
			file.unsavedText = newContent;
			return;
		}
		await trackNativeDocumentWrite(this.obsidianApp.vault, file.path, () => this.obsidianApp.vault.modify(file, newContent));
	}

	private async overwriteFile2WithFile1(hunk: DiffHunk): Promise<void> {
		const newContent = replaceLineSpan({
			fullText: this.rightContent,
			newLine: hunk.leftLines.join("\n"),
			position: hunk.rightStart,
			linesToReplace: hunk.rightLines.length,
		});
		await this.writeFile(this.rightFile, newContent);
	}

	private async overwriteFile1WithFile2(hunk: DiffHunk): Promise<void> {
		const newContent = replaceLineSpan({
			fullText: this.leftContent,
			newLine: hunk.rightLines.join("\n"),
			position: hunk.leftStart,
			linesToReplace: hunk.leftLines.length,
		});
		await this.writeFile(this.leftFile, newContent);
	}

	private async keepBothOnBothFiles(hunk: DiffHunk): Promise<void> {
		const merged = [...hunk.leftLines, ...hunk.rightLines].join("\n");

		const newFile1Content = replaceLineSpan({
			fullText: this.leftContent,
			newLine: merged,
			position: hunk.leftStart,
			linesToReplace: hunk.leftLines.length,
		});
		await this.writeFile(this.leftFile, newFile1Content);

		const newFile2Content = replaceLineSpan({
			fullText: this.rightContent,
			newLine: merged,
			position: hunk.rightStart,
			linesToReplace: hunk.rightLines.length,
		});
		await this.writeFile(this.rightFile, newFile2Content);
	}

	private async dropHunkFromBothFiles(hunk: DiffHunk): Promise<void> {
		await this.dropHunkFromFile1(hunk);
		await this.dropHunkFromFile2(hunk);
	}

	private async copyFile1LinesIntoFile2(hunk: DiffHunk): Promise<void> {
		const newContent = insertLineAt({
			fullText: this.rightContent,
			newLine: hunk.leftLines.join("\n"),
			position: hunk.rightStart,
		});
		await this.writeFile(this.rightFile, newContent);
	}

	private async copyFile2LinesIntoFile1(hunk: DiffHunk): Promise<void> {
		const newContent = insertLineAt({
			fullText: this.leftContent,
			newLine: hunk.rightLines.join("\n"),
			position: hunk.leftStart,
		});
		await this.writeFile(this.leftFile, newContent);
	}

	private async dropHunkFromFile1(hunk: DiffHunk): Promise<void> {
		const newContent = removeLineSpan({
			fullText: this.leftContent,
			position: hunk.leftStart,
			count: hunk.leftLines.length,
		});
		await this.writeFile(this.leftFile, newContent);
	}

	private async dropHunkFromFile2(hunk: DiffHunk): Promise<void> {
		const newContent = removeLineSpan({
			fullText: this.rightContent,
			position: hunk.rightStart,
			count: hunk.rightLines.length,
		});
		await this.writeFile(this.rightFile, newContent);
	}
}
