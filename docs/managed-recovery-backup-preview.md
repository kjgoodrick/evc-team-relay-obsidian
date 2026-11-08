# Verified local source recovery archives

Managed structural recovery saves affected native files, local Yjs histories,
readable document text, unsaved editor buffers and the private inventory before
moving originals. This is a local source-recovery archive, separate from comment
exports and coordinated service backup/restore.

The archive lives under the existing device-local recovery folder, excluded from
Team Relay synchronization. Each archive has a unique timestamp/UUID directory.
Original file paths are preserved under `files/`; document identities select the
`.yjs`, `.txt`, `.cache.json` and optional `.unsaved.txt` files under `documents/`.
`inventory.yjs` stores the private inventory and `recovery.json` records the
reviewed recovery context.

`manifest.json` has format `team-relay-local-recovery`, version `1`, and a `files`
array. Each entry contains its relative `path`, byte count and lowercase SHA-256.
The inventory, readable buffers and recovery metadata are covered alongside native
file and document-update bytes. The completion text includes the manifest digest.

Preparation copies the captured buffers and freezes the metadata before archive
writes. It rejects unsafe relative paths, unsafe document identities, duplicate
case/Unicode-normalized names and file/directory collisions before creating an
archive. It then writes every artifact, reads it back, verifies its length/hash,
verifies the manifest and compares a fresh source capture. The completion marker
also must survive readback before the archive is returned.

The structural decision calls the returned verifier again before moving anything.
It rechecks every saved artifact, manifest, completion marker and current source
capture. A completion filename alone cannot authorize recovery. Failed writes,
read failures, silent corruption or edits arriving during capture leave the
originals and conflict decision intact. Incomplete archives remain available for
inspection. Existing protection against edits during subsequent original-file
moves remains in place.

Verification includes real temporary filesystem operations with fake IndexedDB,
independent Node SHA-256 checks, binary/history restoration, corruption after
completion, mutable input buffers, unsafe/colliding paths, interrupted writes and
edits during structural recovery. The disposable FastAPI/Rust integration also
performs a verified backup before resolving a competing move and confirms that
offline edits survive.

Document capture now opens the existing cache for a single readonly transaction.
It reads the encoded update log and raw custom metadata together, without
subscribing to a live document, appending merged editor updates or compacting the
source. Missing caches remain absent. Blocked opens time out; a late open cannot
create a cache after that failure. Unsupported schemas, record types and malformed
updates fail without changing the source. Encoded updates retain missing
dependencies, and the temporary recovery document disables garbage collection to
preserve deleted content still present in the source. Tests cover later recovery
of missing dependencies, retained deleted content and cache immutability.

Each `.cache.json` uses format `team-relay-document-cache-metadata`, version `1`.
It records the cache name, existence, database version and update count, then
encodes custom keys/values with explicit type tags. Dates, binary buffers/views,
undefined, exceptional numbers, arrays and ordinary nested objects retain their
types; object keys remain entries rather than executable prototype properties.
Unsupported values, cycles and excessive nesting fail the export instead of
silently dropping data. This is an export format, not an import/resume API.

The restored-share dialog offers **Save local recovery copy**, available offline.
It uses the same manifest/readback verifier and leaves source files, inventory,
conflicts and restore review intact. The button is disabled while saving; success
shows the archive path, and errors leave the action retryable. Closing the dialog
does not cancel the copy or repopulate its detached content.

This copy includes currently loaded native files inside the share, including
untracked files, Bases source files and ordinary conflict copies. It excludes
previous recovery directories to prevent recursive exports. Document identities
come from the pre-restore/observed/local inventories, current index, structural
conflicts, staged inventory writes, legacy index and live documents. Missing caches
are explicitly recorded and remain absent. The review and pending inventory
writes/deletes/aliases/claims accompany the private inventory. Account, server,
share address/path, provider, unload, review or staging changes invalidate the
operation; repeated capture detects changed files, buffers and histories.

Coverage is explicit in `recovery.json`: unassociated/other-device caches,
discussion drafts/outbox and Bases request queues/registry are not included.
Their separate recovery exports remain necessary. This is a verified source copy,
not proof that every queue is reconciled or permission to discard a cache or
resume synchronization. A later edit can always make a saved copy outdated.

The restored-share tests use real temporary files and fake IndexedDB to exercise
offline export, known closed/live/missing caches, metadata, untracked/conflict
files, scope exclusions, concurrent source/context changes, disk failures and
retry. Dialog tests cover progress, success, errors and closing during a save.

Native/mobile filesystem acceptance remains pending. Capture still keeps the
affected source data in memory; streaming and larger resumable archives remain
separate work. This does not provide safe restored-cache resumption, automatic
replacement of native files or a coordinated database/relay/object-store restore.
