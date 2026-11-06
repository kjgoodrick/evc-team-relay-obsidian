import { type AttachmentToggles, type AttachmentSyncSettings } from "./AttachmentSyncSettings";
import { currentToggles } from "./featureToggleState";
import { mimeTypeForPath } from "./mimeLookup";
import { Notifier } from "./notifiers/Notifier";

export enum ItemKind {
	Folder = "folder",
	Document = "markdown",
	Canvas = "canvas",
	Image = "image",
	PDF = "pdf",
	Audio = "audio",
	Video = "video",
	File = "file",
}

export type AttachmentKind =
	| ItemKind.Image
	| ItemKind.PDF
	| ItemKind.Audio
	| ItemKind.Video
	| ItemKind.File;

interface ItemRecordBase {
	id: string;
	version: number;
	type: ItemKind;
	hash?: string;
	synctime?: number;
	mimetype?: string;
}

// FolderRecord/DocumentRecord/CanvasRecord only differ from ItemRecordBase in pinning
// `type` to one literal ItemKind — parameterize instead of repeating the
// three-field shape per type.
type PlainMeta<T extends ItemKind> = ItemRecordBase & { version: 0; type: T };

export type FolderRecord = PlainMeta<ItemKind.Folder>;
export type DocumentRecord = PlainMeta<ItemKind.Document>;
export type CanvasRecord = PlainMeta<ItemKind.Canvas>;

interface AttachmentRecordBase extends ItemRecordBase {
	version: 0;
	type: AttachmentKind;
	mimetype: string;
	hash: string;
	synctime: number;
}

// Same pattern for the file-backed metas — the only per-type difference is
// which AttachmentKind member `type` is pinned to.
type FileMetaOf<T extends AttachmentKind> = AttachmentRecordBase & { type: T };

export type ImageRecord = FileMetaOf<ItemKind.Image>;
export type PDFRecord = FileMetaOf<ItemKind.PDF>;
export type AudioRecord = FileMetaOf<ItemKind.Audio>;
export type VideoRecord = FileMetaOf<ItemKind.Video>;
export type FileRecord = FileMetaOf<ItemKind.File>;

export type AttachmentRecords = ImageRecord | PDFRecord | AudioRecord | VideoRecord | FileRecord;

export type ItemRecord = FolderRecord | DocumentRecord | AttachmentRecords | CanvasRecord;

type ItemKindToRecord = {
	[ItemKind.Folder]: FolderRecord;
	[ItemKind.Document]: DocumentRecord;
	[ItemKind.Canvas]: CanvasRecord;
	[ItemKind.PDF]: PDFRecord;
	[ItemKind.Image]: ImageRecord;
	[ItemKind.Audio]: AudioRecord;
	[ItemKind.Video]: VideoRecord;
	[ItemKind.File]: FileRecord;
};

export const SyncFlagToItemKind: Record<Exclude<keyof AttachmentToggles, "bases">, ItemKind> = {
	images: ItemKind.Image,
	audio: ItemKind.Audio,
	videos: ItemKind.Video,
	pdfs: ItemKind.PDF,
	otherTypes: ItemKind.File,
};

export const ItemKindToFlagMap: Record<ItemKind, keyof AttachmentToggles | null> = {
	[ItemKind.Document]: null, // Always enabled
	[ItemKind.Canvas]: null, // Always enabled
	[ItemKind.Folder]: null, // Always enabled
	[ItemKind.Image]: "images",
	[ItemKind.Audio]: "audio",
	[ItemKind.Video]: "videos",
	[ItemKind.PDF]: "pdfs",
	[ItemKind.File]: "otherTypes",
};

// Every is*Record guard below is "meta?.type === SOME_TYPE" — build them off one
// factory instead of hand-writing the same one-liner eight times.
function recordTypeGuard<T extends ItemRecord>(type: ItemKind) {
	return (meta?: ItemRecord): meta is T => meta?.type === type;
}

export const isDocumentRecord = recordTypeGuard<DocumentRecord>(ItemKind.Document);
// NB: pre-existing quirk carried over as-is (not introduced by this rewrite) —
// this narrows to DocumentRecord rather than CanvasRecord despite checking
// ItemKind.Canvas. Left unchanged; see rewrite report.
export const isCanvasRecord = recordTypeGuard<DocumentRecord>(ItemKind.Canvas);
export const isFolderRecord = recordTypeGuard<FolderRecord>(ItemKind.Folder);
export const isFileRecord = recordTypeGuard<FileRecord>(ItemKind.File);
export const isImageRecord = recordTypeGuard<ImageRecord>(ItemKind.Image);
export const isPDFRecord = recordTypeGuard<PDFRecord>(ItemKind.PDF);
export const isAudioRecord = recordTypeGuard<AudioRecord>(ItemKind.Audio);
export const isVideoRecord = recordTypeGuard<VideoRecord>(ItemKind.Video);

function baseRecord(type: ItemKind, guid: string): { version: 0; id: string; type: ItemKind } {
	return { version: 0, id: guid, type };
}

export function makeDocumentRecord(guid: string): DocumentRecord {
	return baseRecord(ItemKind.Document, guid) as DocumentRecord;
}

export function makeCanvasRecord(guid: string): CanvasRecord {
	return baseRecord(ItemKind.Canvas, guid) as CanvasRecord;
}

export function makeFolderRecord(guid: string): FolderRecord {
	return baseRecord(ItemKind.Folder, guid) as FolderRecord;
}

export function makeFileRecord<T extends AttachmentKind>(
	type: T,
	guid: string,
	mimetype: string,
	hash: string,
	synctime?: number,
): ItemKindToRecord[T] {
	return {
		...baseRecord(type, guid),
		mimetype,
		synctime: synctime ?? Date.now(),
		hash,
	} as ItemKindToRecord[T];
}

interface KindSupport {
	maxSupportedVersion: number;
	allowedMimetypes: string[];
	syncEnabled: boolean;
}

const DEFAULT_PROTOCOLS: ReadonlyArray<[ItemKind, KindSupport]> = [
	[ItemKind.Folder, { maxSupportedVersion: 0, allowedMimetypes: [], syncEnabled: true }],
	[
		ItemKind.Document,
		{ maxSupportedVersion: 0, allowedMimetypes: ["text/markdown"], syncEnabled: true },
	],
	[
		ItemKind.Image,
		{
			maxSupportedVersion: 0,
			allowedMimetypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/svg+xml",
				"image/webp",
				"image/avif",
				"image/bmp",
			],
			syncEnabled: true,
		},
	],
	[ItemKind.PDF, { maxSupportedVersion: 0, allowedMimetypes: ["application/pdf"], syncEnabled: true }],
	[
		ItemKind.Audio,
		{
			maxSupportedVersion: 0,
			allowedMimetypes: [
				"audio/mpeg",
				"audio/wav",
				"audio/flac",
				"audio/mp4",
				"audio/x-m4a",
				"audio/ogg",
				"audio/opus",
			],
			syncEnabled: true,
		},
	],
	[
		ItemKind.Video,
		{
			maxSupportedVersion: 0,
			allowedMimetypes: [
				"video/mp4",
				"video/webm",
				"video/ogg",
				"video/quicktime",
				"video/x-matroska",
			],
			syncEnabled: true,
		},
	],
	[
		ItemKind.Canvas,
		{ maxSupportedVersion: 0, allowedMimetypes: ["application/canvas+json"], syncEnabled: true },
	],
	[
		ItemKind.File,
		{ maxSupportedVersion: 0, allowedMimetypes: ["application/octet-stream"], syncEnabled: false },
	],
];

export class KindRegistry extends Notifier<KindRegistry> {
	static defaultProtocols = DEFAULT_PROTOCOLS;

	private supportByKind = new Map<ItemKind, KindSupport>();
	private basesEnabled = false;
	// Reverse index (mimetype -> ItemKind) rebuilt whenever supportByKind
	// changes, so kindForPath is a lookup instead of a scan over every protocol.
	private mimetypeIndex = new Map<string, ItemKind>();

	constructor(
		private attachmentSettings: AttachmentSyncSettings,
		configs: ReadonlyArray<[ItemKind, KindSupport]> = KindRegistry.defaultProtocols,
	) {
		super();
		for (const [type, config] of configs) {
			this.supportByKind.set(type, config);
		}
		this.rebuildMimetypeIndex();
		this.unsubscribes.push(
			attachmentSettings.subscribe((settings) => this.applySettingsUpdate(settings)),
		);
	}

	private rebuildMimetypeIndex(): void {
		this.mimetypeIndex.clear();
		for (const [type, config] of this.supportByKind) {
			for (const mimetype of config.allowedMimetypes) {
				this.mimetypeIndex.set(mimetype, type);
			}
		}
	}

	private setKindEnabled(type: ItemKind, syncEnabled: boolean): void {
		const config = this.supportByKind.get(type);
		if (config) {
			this.supportByKind.set(type, { ...config, syncEnabled });
		}
	}

	supportsSync(vpath: string, meta?: ItemRecord): boolean {
		if (meta?.type !== ItemKind.Folder && vpath.toLowerCase().endsWith(".base")) return this.attachmentSettings.isFileTypeAllowed(vpath) &&
			(!meta || meta.type === ItemKind.File && meta.version === 0);
		if (vpath.endsWith(".md")) return true;
		if (currentToggles().enableCanvasSync && vpath.endsWith(".canvas")) return true;

		const hasExtension = vpath.split("/").pop()?.includes(".");
		if (!hasExtension) return true;

		if (meta) {
			const config = this.supportByKind.get(meta.type);
			return !!config && config.syncEnabled && meta.version <= config.maxSupportedVersion;
		}

		const type = this.kindForPath(vpath);
		return !!this.supportByKind.get(type)?.syncEnabled;
	}

	private applySettingsUpdate(settings: Record<keyof AttachmentToggles, boolean>): void {
		this.basesEnabled = settings.bases === true;
		for (const [flagKey, syncType] of Object.entries(SyncFlagToItemKind)) {
			this.setKindEnabled(syncType, settings[flagKey as keyof AttachmentToggles]);
		}
	}

	public enabledSyncKinds(): ItemKind[] {
		const enabledTypes: ItemKind[] = [];
		for (const [syncType, proto] of this.supportByKind) {
			if (proto.syncEnabled && syncType !== ItemKind.Folder) {
				enabledTypes.push(syncType);
			}
		}
		if (this.basesEnabled && !enabledTypes.includes(ItemKind.File)) enabledTypes.push(ItemKind.File);
		return enabledTypes;
	}

	kindForPath(vpath: string): ItemKind {
		const mimetype = mimeTypeForPath(vpath);
		const type = this.mimetypeIndex.get(mimetype);

		if (type === undefined) return ItemKind.File;
		if (type === ItemKind.Canvas && !currentToggles().enableCanvasSync) return ItemKind.File;
		return type;
	}
}
