"use strict";

import { App, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import TeamRelayPlugin from "src/main";
import SettingsPanel from "src/components/SettingsPanel.svelte";
import { mountComponent, type MountedComponent } from "src/svelteMount";

type CloseableSetting = { setting: { close: () => void } };

// CSS hook (styles.css) that strips the default `.setting-item` row chrome
// (padding/border/background) so the full-bleed SettingsPanel isn't shown
// boxed inside what's meant to be a single narrow settings row.
const FULL_BLEED_ROW_CLASS = "evc-relay-settings-tab-row";

export class RelaySettingsPage extends PluginSettingTab {
	// Not renamed: `PluginSettingTab`'s own base (`SettingTab`) conventionally
	// stores its constructor's `plugin` argument on `this.plugin` and its
	// default `getControlValue`/`setControlValue` read/write through it
	// (obsidian.d.ts doc comment: "Reads from `this.plugin.settings`").
	// This subclass doesn't call those, but renaming our own field would
	// decouple it from whatever Obsidian's base class continues to call
	// `this.plugin` internally, with zero compile error to catch it.
	plugin: TeamRelayPlugin;
	mountEl!: HTMLElement;
	private panel?: MountedComponent<Record<string, unknown>>;

	constructor(app: App, plugin: TeamRelayPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative settings-search entry point (Obsidian 1.13.0+). Returning a
	// non-empty array here means `display()` below is skipped entirely on
	// 1.13+ (obsidian.d.ts: "Not called when getSettingDefinitions returns a
	// non-empty array") -- `display()` stays only as the pre-1.13 fallback
	// (manifest.json minAppVersion is 1.8.7, so it must be kept).
	//
	// Design choice -- `render` item, not a `type: "page"` sub-page:
	// confirmed against Obsidian 1.13.7's actual runtime (app.asar, function
	// `Sie`, the settings-search entry collector) that a `type: "page"` item
	// using the imperative `page: () => SettingPage` factory contributes
	// NOTHING to the search index by itself -- `Sie` only recurses into a
	// page's declarative `items`, it never indexes the page itself. Only a
	// leaf definition (control/render/action) with `name`/`desc`/`aliases`
	// is what `Mie.search()` actually matches against. So a bare
	// `SettingDefinitionPage` would not have fixed the validator warning at
	// all -- it would have added a click without adding a search hit. A
	// `render` item is the only type that both (a) is indexed for search and
	// (b) can be drawn immediately, with no extra navigation step.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Team Relay",
				desc: "Manage plugin updates, synced folders, shares, and the on-prem connection.",
				aliases: ["relay", "sync", "team relay", "shares", "synced folders", "on-prem", "updates", "GitHub"],
				// Confirmed against the same runtime (function `s6`) that the
				// framework calls `setting.setName()`/`setting.setDesc()` from
				// the definition's `name`/`desc` BEFORE invoking `render()` --
				// so those fields are already applied to the row when this
				// callback runs. `mountPanel()` then empties the whole row
				// (wiping that pre-applied name/desc DOM) to mount the panel
				// edge-to-edge; that's safe because the search index is built
				// from the definition object itself, not from the rendered
				// DOM, so emptying the row here doesn't affect searchability.
				render: (setting) => {
					setting.settingEl.addClass(FULL_BLEED_ROW_CLASS);
					this.mountPanel(setting.settingEl);
					// Belt-and-braces: normal tab-switch-away teardown already
					// runs through hide() below; this cleanup covers the row
					// itself being torn down independently of the tab (e.g. a
					// future getSettingDefinitions() reconciliation). hide()
					// is idempotent (try/catch around destroy()).
					return () => this.hide();
				},
			},
		];
	}

	display(): void {
		this.mountEl = this.containerEl.parentElement as HTMLElement;
		this.mountPanel(this.mountEl);
	}

	private mountPanel(target: HTMLElement): void {
		this.mountEl = target;
		this.mountEl.empty();
		void this.plugin.relayRegistry.refresh();

		this.panel = mountComponent(SettingsPanel, {
			target: this.mountEl,
			props: {
				live: this.plugin,
				onClose: () => (this as unknown as CloseableSetting).setting.close(),
			},
		});
	}

	showPath(path: string): void {
		this.panel?.update({ initialPath: path });
	}

	hide(): void {
		try {
			this.panel?.destroy();
		} catch (e: unknown) {
			console.warn(e);
		}
	}

	teardown(): void {
		this.hide();
		this.plugin = null as unknown as TeamRelayPlugin;
	}
}
