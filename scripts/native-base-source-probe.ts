/** Build only into the disposable fixture's plugin directory. This is native
 * compatibility evidence, not a production plugin feature or a host API shim.
 * Input: source-cases.json with synthetic { id, source, property } rows.
 * Output: source-observations.json. Never writes any note or .base definition.
 */
import { FileSystemAdapter, Plugin, Notice, apiVersion, ObjectValue, getFrontMatterInfo, parseYaml, TFile } from "obsidian";
import { nativeBaseGroupValue, nativeBaseGroupValueKey } from "../src/bases/NativeBaseGroupValue";

type Case = { id: string; source: string; property: string };
type NativeObject = { getInsensitive(name: string): unknown };
type NativeConstructor = { fromFrontMatter(app: Plugin["app"], file: TFile, raw: unknown): NativeObject };

export default class SourceCompatibilityProbe extends Plugin {
	onload() {
		this.addCommand({ id: "capture", name: "Capture synthetic property compatibility", callback: () => void this.capture() });
	}

	async capture() {
		const adapter = this.app.vault.adapter;
		if (apiVersion !== "1.13.7" || !(adapter instanceof FileSystemAdapter) ||
			adapter.getBasePath() !== "/private/tmp/evc-base-groups-20261106") return;
		const cases = JSON.parse(await adapter.read("source-cases.json")) as Case[];
		const file = this.app.vault.getAbstractFileByPath("Team/A.md");
		if (!(file instanceof TFile)) throw new Error("Missing synthetic source note");
		const result = cases.map(item => {
			try {
				const fence = getFrontMatterInfo(item.source);
				const raw: unknown = fence.exists ? parseYaml(fence.frontmatter) : {};
				const rawJson = JSON.stringify(raw, (_key: string, value: unknown) =>
					typeof value === "number" && !Number.isFinite(value) ? { nonfinite: String(value) } : value);
				// Private conversion is confined to this version-pinned test probe.
				const object = (ObjectValue as unknown as NativeConstructor).fromFrontMatter(this.app, file, raw ?? {});
				const value = object.getInsensitive(item.property);
				const typed = nativeBaseGroupValue(value, (link, source) => this.app.metadataCache.getFirstLinkpathDest(link, source));
				return { ...item, parse_status: "ok", raw: JSON.parse(rawJson) as unknown,
					nativeType: (value as { constructor?: { type?: string } } | null)?.constructor?.type ?? null,
					groupKey: typed ? nativeBaseGroupValueKey(typed) : null };
			} catch { return { ...item, parse_status: "error" }; }
		});
		await adapter.write("source-observations.json", JSON.stringify({ host: apiVersion,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, sourcePath: file.path, cases: result }, null, 2));
		new Notice(`${result.length} synthetic property observations saved`);
	}
}
