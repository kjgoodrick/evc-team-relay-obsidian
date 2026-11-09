import { InlineBaseAnchors, type InlineBaseSourceRequest } from "./InlineBaseAnchors";
import type * as Y from "yjs";

/** Locate a definition by its verified fence identity, never by its display
 * name or order. Re-resolve the fence after I/O so preceding edits are harmless. */
export async function findInlineBase(
	text: Y.Text, definitionId: string,
	inspect: (request: InlineBaseSourceRequest) => Promise<{ definition_id: string } | undefined>,
	current: () => boolean,
): Promise<{ from: number; to: number } | undefined> {
	const anchors = new InlineBaseAnchors(text);
	try {
		for (const source of anchors.definitions) {
			if (!current()) return;
			const anchor = anchors.capture(source), request = anchor && anchors.request(anchor);
			if (!anchor || !request) continue;
			const proof = await inspect(request);
			if (!current()) return;
			const resolved = anchors.resolve(anchor);
			if (proof?.definition_id === definitionId && resolved?.source === source.source) return { from: resolved.from, to: resolved.to };
		}
	} finally { anchors.close(); }
}
