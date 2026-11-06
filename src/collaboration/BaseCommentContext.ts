import type { TFile } from "obsidian";
import type { NativeBasesSurface, NativeBaseBinding, NativeBaseTarget } from "../bases/NativeBasesSurface";
import type { DiscussionSession, BaseTargetSelection } from "./DiscussionSession";
import type { BaseAnchor } from "./DiscussionProtocol";

export interface BaseCommentContext {
	file: TFile; session: DiscussionSession; entryId: string; baseEntryId: string;
	surface: NativeBasesSurface; binding: NativeBaseBinding;
	current(): boolean; release(): void;
	canComment(target: NativeBaseTarget): boolean;
	selection(target: NativeBaseTarget): BaseTargetSelection | undefined;
	native(anchor: BaseAnchor): NativeBaseTarget | undefined;
}

export function baseSelectionKey(target: BaseTargetSelection): string {
	if (target.type === "formula_cell") return JSON.stringify([target.type, target.recordId, target.definitionId, target.definitionRevision]);
	if (target.type === "formula" || target.type === "summary") return JSON.stringify([target.type, target.definitionId, target.definitionRevision]);
	return JSON.stringify([target.type, "recordId" in target ? target.recordId : null,
		"property" in target ? target.property.source : null, "property" in target ? target.property.name : null]);
}
