# Verified local source recovery archives

Managed structural recovery saves affected native files, local Yjs histories,
readable document text, unsaved editor buffers and the private inventory before
moving originals. This is a local source-recovery archive, separate from comment
exports and coordinated service backup/restore.

The archive lives under the existing device-local recovery folder, excluded from
Team Relay synchronization. Each archive has a unique timestamp/UUID directory.
Original file paths are preserved under `files/`; document identities select the
`.yjs`, `.txt` and optional `.unsaved.txt` files under `documents/`.
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

The snapshot reader exposes raw metadata for the forthcoming retained-work export;
the current structural archive does not yet serialize every custom metadata value.

Native/mobile filesystem acceptance remains pending. Capture still keeps the
affected source data in memory; streaming and larger resumable archives remain
separate work. This does not provide safe restored-cache resumption, automatic
replacement of native files or a coordinated database/relay/object-store restore.
