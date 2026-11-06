import { SettingsScope, Settings } from "./SettingsPersistence";
import { currentToggles } from "./featureToggleState";

export interface AttachmentCategory {
	categoryEnabled: boolean;
	fileExtensions: string[];
	summary: string;
	displayName: string;
}

export interface AttachmentToggles {
	images?: boolean;
	audio?: boolean;
	videos?: boolean;
	pdfs?: boolean;
	bases?: boolean;
	otherTypes?: boolean;
}

type AttachmentKey = keyof AttachmentToggles;

interface AttachmentTypeSpec {
	toggleKey: AttachmentKey;
	displayName: string;
	summary: string;
	fileExtensions: string[];
	initiallyEnabled: boolean;
}

const ATTACHMENT_TYPES: readonly AttachmentTypeSpec[] = [
	{
		toggleKey: "images",
		displayName: "Images",
		summary:
			"Sync image files (.bmp, .png, .jpg, .jpeg, .gif, .svg, .webp, .avif)",
		fileExtensions: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
		initiallyEnabled: true,
	},
	{
		toggleKey: "audio",
		displayName: "Audio",
		summary:
			"Sync audio files (.mp3, .wav, .m4a, .3gp, .flac, .ogg, .oga, .opus)",
		fileExtensions: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
		initiallyEnabled: true,
	},
	{
		toggleKey: "videos",
		displayName: "Videos",
		summary: "Sync video files (.mp4, .webm, .ogv, .mov, .mkv)",
		fileExtensions: ["mp4", "webm", "ogv", "mov", "mkv"],
		initiallyEnabled: true,
	},
	{
		toggleKey: "pdfs",
		displayName: "PDFs",
		summary: "Sync PDF files (.pdf)",
		fileExtensions: ["pdf"],
		initiallyEnabled: true,
	},
	{
		toggleKey: "bases",
		displayName: "Bases",
		summary: "Sync Bases views and preserve conflicting edits for review",
		fileExtensions: ["base"],
		initiallyEnabled: false,
	},
	{
		toggleKey: "otherTypes",
		displayName: "Other files",
		summary: "Sync unsupported file types",
		fileExtensions: [],
		initiallyEnabled: false,
	},
];

const TYPES_BY_KEY: ReadonlyMap<AttachmentKey, AttachmentTypeSpec> = new Map(
	ATTACHMENT_TYPES.map((d) => [d.toggleKey, d]),
);

function specFor(key: AttachmentKey): AttachmentTypeSpec {
	const descriptor = TYPES_BY_KEY.get(key);
	if (!descriptor) throw new Error(`Unknown sync category: ${key}`);
	return descriptor;
}

export class AttachmentSyncSettings extends SettingsScope<
	Record<AttachmentKey, boolean>
> {
	static readonly defaultCategoryFlags: Record<AttachmentKey, boolean> =
		ATTACHMENT_TYPES.reduce(
			(acc, d) => {
				acc[d.toggleKey] = d.initiallyEnabled;
				return acc;
			},
			{} as Record<AttachmentKey, boolean>,
		);

	constructor(
		settings: Settings<unknown>,
		path: string,
		public syncEnabled = true,
	) {
		super(settings, path);
	}

	public isFileTypeAllowed(path: string): boolean {
		const extension = (path.split(".").pop() ?? "").toLowerCase();

		if (extension === "md") return true;
		if (currentToggles().enableCanvasSync && extension === "canvas") return true;
		if (!this.syncEnabled) return false;

		const current = this.readValue();
		// Bases have a separate content protocol and must never fall through to
		// the catch-all attachment switch when explicitly disabled.
		if (extension === "base") return current.bases ?? false;
		for (const descriptor of ATTACHMENT_TYPES) {
			const enabled = current[descriptor.toggleKey] ?? descriptor.initiallyEnabled;
			if (enabled && descriptor.fileExtensions.includes(extension)) {
				return true;
			}
		}

		return current.otherTypes ?? specFor("otherTypes").initiallyEnabled;
	}

	describeCategory(key: AttachmentKey): AttachmentCategory {
		const descriptor = specFor(key);
		const enabled = this.readValue()[key] ?? descriptor.initiallyEnabled;
		return {
			categoryEnabled: enabled,
			displayName: descriptor.displayName,
			summary: descriptor.summary,
			fileExtensions: descriptor.fileExtensions,
		};
	}

	listCategories(): Record<AttachmentKey, AttachmentCategory> {
		const result = {} as Record<AttachmentKey, AttachmentCategory>;
		for (const descriptor of ATTACHMENT_TYPES) {
			result[descriptor.toggleKey] = this.describeCategory(descriptor.toggleKey);
		}
		return result;
	}

	public async setCategoryEnabled(
		category: AttachmentKey,
		enabled: boolean,
	): Promise<void> {
		await this.mutateValue((current) => ({ ...current, [category]: enabled }));
		this.log(`setting ${category} to ${enabled}`);
		this.notifySubscribers();
	}

	public async resetToDefaults(): Promise<void> {
		await this.mutateValue(() => ({ ...AttachmentSyncSettings.defaultCategoryFlags }));
	}
}
