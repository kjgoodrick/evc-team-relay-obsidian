import type * as Y from "yjs";
import { isRecord } from "../DiscussionProtocol";
import { presenceRange, type PresenceRange } from "./PresencePeers";
import { exactFields, locationId, parseImageState, parseLocationTarget, type ImagePresenceState, type LocationTarget, type NoteLocation } from "./LocationProtocol";

export type EmbeddedAsset = Readonly<{ kind: "managed"; entry_id: string; generation: string; sha256: string }> |
	Readonly<{ kind: "external"; url_sha256: string; version_evidence: "unknown" }>;
export type EmbeddedImage = Readonly<{ version: 1; occurrence: PresenceRange; source_sha256: string; asset: EmbeddedAsset;
	basis: Readonly<{ width: number; height: number; orientation: "display" }>; state: ImagePresenceState }>;
export type EmbeddedPeer = Readonly<{ target: LocationTarget; embed: EmbeddedImage }>;
export type EmbeddedImagesEvent = Readonly<{ scope: NoteLocation | null; status: "available" | "unavailable"; peers: readonly EmbeddedPeer[] }>;
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const dimension = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000;
const position = (value: Y.RelativePosition): Y.RelativePosition => Object.freeze({ ...value, ...(value.item ? { item: Object.freeze({ ...value.item }) } : {}) });

/** No source text, URLs, filenames or client identity travel with an embed.
 * Consumers must resolve this exact relative source interval and asset locally. */
export function parseEmbeddedImage(value: unknown): EmbeddedImage {
	if (!isRecord(value) || !exactFields(value, ["version", "occurrence", "source_sha256", "asset", "basis", "state"]) || value.version !== 1 ||
		!presenceRange(value.occurrence) || !hash(value.source_sha256) || !isRecord(value.asset) || !isRecord(value.basis)) throw new Error("Invalid embedded image");
	const raw = value.asset; let asset: EmbeddedAsset;
	if (raw.kind === "managed" && exactFields(raw, ["kind", "entry_id", "generation", "sha256"]) && locationId(raw.entry_id) && locationId(raw.generation) && hash(raw.sha256)) {
		asset = Object.freeze({ kind: "managed", entry_id: raw.entry_id, generation: raw.generation, sha256: raw.sha256 });
	} else if (raw.kind === "external" && exactFields(raw, ["kind", "url_sha256", "version_evidence"]) && hash(raw.url_sha256) && raw.version_evidence === "unknown") {
		asset = Object.freeze({ kind: "external", url_sha256: raw.url_sha256, version_evidence: "unknown" });
	} else throw new Error("Invalid embedded image asset");
	const basis = value.basis;
	if (!exactFields(basis, ["width", "height", "orientation"]) || !dimension(basis.width) || !dimension(basis.height) || basis.orientation !== "display") throw new Error("Invalid image basis");
	return Object.freeze({ version: 1, source_sha256: value.source_sha256, asset, state: parseImageState(value.state),
		basis: Object.freeze({ width: basis.width, height: basis.height, orientation: "display" }),
		occurrence: Object.freeze({ anchor: position(value.occurrence.anchor), head: position(value.occurrence.head) }) });
}
export function parseEmbeddedPeers(value: unknown): readonly EmbeddedPeer[] {
	if (!Array.isArray(value) || value.length > 127) throw new Error("Invalid embedded image participants");
	const keys = new Set<string>();
	return Object.freeze(value.map((item: unknown) => {
		if (!isRecord(item) || !exactFields(item, ["target", "embed"])) throw new Error("Invalid embedded image participant");
		const target = parseLocationTarget(item.target), key = JSON.stringify(target);
		if (keys.has(key)) throw new Error("Duplicate embedded image participant"); keys.add(key);
		return Object.freeze({ target, embed: parseEmbeddedImage(item.embed) });
	}));
}
