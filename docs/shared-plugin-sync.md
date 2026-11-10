# Shared plugin setup MVP

Owner/admin-managed setup manifests are stored on the managed share with a
monotonic revision. Members may read; file editors cannot publish executable
requirements. Compare-and-swap rejects stale owner saves. No note or hidden
vault path is used for distribution. Clients pin three runtime files by digest
and size from public GitHub releases; optional missing CSS is an empty file.

The owner reviews sources and publishes required versions. Local consent is
bound to the share, configured server endpoint, and current user. Apply once does
not authorize unattended updates. Install and keep in sync approves subsequent
version/settings revisions for the same plugin IDs and repositories, including
owner-requested downgrades. A new plugin/source requires renewed consent.
Other connected shares are re-read to reject incompatible requirements.

Installation uses Obsidian's existing plugin manager to disable, reload manifests,
and enable the plugin. Files and personal data.json are locally backed up with
hashes and a recovery journal. Recovery runs before another setup is applied.
Portable fields merge into current data.json after unload; other keys remain.
Partial multi-plugin completion is retryable per plugin; this is not an atomic
transaction across all plugins. Removing requirements never uninstalls local
plugins or erases their data. The host must permit community plugins.

Only the Time & Line planning fork has a portable-settings adapter in this MVP:
weekStart, dependencyProperty, lockedProperty, showBarProperties,
barPropertyMinWidth. Credentials, markers, colors, device locks and all settings
for unrecognized plugins remain local. Adapters must be explicit in server and
client validation before extending shared configuration.

Supported release limits: 30 plugins, 100 MB total, 20 MB main.js, 2 MB CSS,
16 KiB manifest, public GitHub release assets. Custom config directories are
supported. Team Relay is the bootstrap and cannot manage itself this way.

Validation: source/Svelte checking, owner/member authorization and stale saves,
release/hash/compatibility tests, first install, personal-data preservation,
recoverable failure/restart, consent and changed-source boundaries. Native UI
verification was blocked by the locked Mac; private plugin-manager method names
were confirmed in installed Obsidian source. This is not native mobile acceptance.
