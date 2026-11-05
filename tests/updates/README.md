# GitHub release updater (0.2.5)

The plugin checks `kjgoodrick/evc-team-relay-obsidian` automatically while Obsidian
is running and offers **Update to …** in its settings. Checks run shortly after
startup and at most once per day after success, with an hour between automatic
retries after failure. **Check for updates** works on demand. The automatic
check preference and a discovered update survive reopening the app.

Published previews are included: this fork currently distributes its builds as
GitHub prereleases. Drafts, incomplete releases, nonnumeric tags, releases from
another repository, and versions at or below the running version are excluded.
The newest eligible version among GitHub's 100 most recent releases is selected.
Public GitHub requests carry no Pocket ID tokens or vault content.

## Installation and recovery

Clicking Update downloads the three runtime assets and SHA256SUMS. It checks
sizes, SHA-256 hashes, plugin ID, release/manifest version, minimum Obsidian API
version and mobile support before touching installed files. Checksums detect
changed/corrupt downloads; trust still rests on this repository and HTTPS, not
an independent release-signing key.

The installer uses the public Obsidian DataAdapter APIs, including a probe that
requires rename to replace an existing file. It stages and verifies new files,
keeps verified copies of the previous runtime files, and records a recovery
journal in `<plugin directory>/.relay-update/`. It replaces `main.js`,
`styles.css`, and finally `manifest.json` using rename. It never removes or
truncates the running main.js as a fallback when rename is unsupported.

A write failure restores all three previous files. An interrupted transaction
is recovered before sync starts on the next load; that recovery asks for another
restart. Completed transactions do not override a subsequent manual version
installation. Installation does not reload the active plugin or close editors.
Save your edits and restart Obsidian when convenient to load the new version.

`data.json`, authentication storage, and notes are outside the updater's write
set. One previous set of runtime files is retained. A filesystem failure that
prevents Obsidian from loading main.js cannot be repaired by code that never
loads: restore the three `.previous` files from `.relay-update/` manually in that
case. Never replace data.json or remove local storage as part of recovery.

Keep Obsidian's upstream plugin updates off for this fork; this updater has its
own independent checkbox. A server release is not deployed by updating the
plugin; read the linked release notes for server requirements.

## Tests

Automated run: 1,428 tests passed in 139 suites, with the separately gated
real-relay suite skipped. The updater-focused run passed all 26 checks.
Production build passed (15 inherited Svelte warnings); Svelte type checking
has zero errors and the test type gate introduced no new baseline errors.
The full suite needs an unsandboxed loopback listener for existing OAuth tests;
the sandboxed attempt could not provide that listener. The production release
code also downloaded and verified all three real 0.2.4 assets from GitHub.

`npm test -- --runInBand __tests__/PluginUpdater.test.ts __tests__/PluginUpdatesDOM.test.cjs`
exercises release selection, verified downloads, invalid hashes/manifests,
staging and replacement failures, rollback/recovery, manual version replacement,
settings/notes preservation, concurrency, daily scheduling, rate limits,
timeouts, unload during download, and actual compiled Svelte button behavior.

`node tests/updates/serve.mjs` bundles the production PluginUpdater, UpdateFiles,
release validation and PluginUpdates component with production plugin CSS at
`http://127.0.0.1:4177/`. There are no runtime Obsidian imports to alias: the host
boundary is the injected DataAdapter and HTTP request implementation. The
adapter stores synthetic files in memory; requests return synthetic GitHub
responses. Results/errors are displayed, saved in localStorage and captured by
the loopback server under `dist/updates-harness/`. Rebuild after source edits:
`node tests/updates/serve.mjs --build-only`, then reload Safari.

The harness tests the production updater, including real WebCrypto hashes,
with a substitute host. It cannot establish native DataAdapter rename semantics,
real GitHub request handling, plugin discovery/loading, vault durability,
background/resume behavior or performance inside native iPhone Obsidian.

Manual host and Simulator verification is pending an unlocked Mac. The actual
host test uses a disposable vault with the new code labelled 0.2.3 only in its
fixture manifest, allowing it to discover/install the real published 0.2.4.
That label is never used in a published bundle or production vault.

## Publishing future releases

The updater requires these individual assets on the same published release:
`main.js`, `manifest.json`, `styles.css`, and `SHA256SUMS`. A ZIP alone is not an
eligible update. Use a bare numeric X.Y.Z tag matching the bundled manifest.
Generate checksums from the exact tested runtime assets (include the ZIP too
when distributing one). Keep releases immutable once published. The existing
stable release workflow now generates/uploads SHA256SUMS after its accepted-byte
check; the preview packaging process supplies it as well.

GitHub's [release API](https://docs.github.com/en/rest/releases/releases#list-releases)
provides the published release/asset metadata. The updater uses the release list
because GitHub's latest-release endpoint excludes prereleases.
