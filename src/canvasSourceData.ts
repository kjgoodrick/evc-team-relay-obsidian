import type * as Y from "yjs";
import type { CanvasData, CanvasEdgeData, CanvasNodeData } from "./HostCanvasView";

/** One projection shared by live saves and isolated source verification. */
export function canvasSourceData(ydoc: Y.Doc): CanvasData {
	const yedges = ydoc.getMap<CanvasEdgeData>("edges"), ynodes = ydoc.getMap<CanvasNodeData>("nodes");
	const edges = Array.from(yedges.values(), edge => ({ ...edge }));
	const nodes = Array.from(ynodes.values(), node => {
		const text = ydoc.getText(node.id);
		// Legacy nodes may only have the metadata text. Once a Y.Text has
		// held content, its tombstones distinguish an intentional clear from
		// that legacy state, even after a cache/server round trip.
		return { ...node, text: text._start === null ? node.text : text.toJSON() };
	});
	return { edges, nodes };
}
