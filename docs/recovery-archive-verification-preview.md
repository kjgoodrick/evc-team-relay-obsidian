# Reopening a local recovery archive

`prepareRecoveryBackup` now returns an immutable `reference` containing the
archive path and manifest SHA-256. A recovery coordinator can persist that exact
reference in the source-selection journal. `verifyRecoveryArchive` reopens the
archive using the reference after a restart; it does not need the old in-memory
capture closure. The original backup format and completion marker are unchanged.

The verifier checks the saved manifest digest, supported schema, safe artifact
paths, case/Unicode and file/directory collisions, required inventory/metadata,
and every listed file's length and digest. Both live and separately committed
unsaved buffers are covered. It checks the completion marker, then checks the
manifest and marker again after reading the artifacts. A replacement manifest
and marker cannot substitute for the digest retained by the caller.

Reads are sequential. File statistics are checked before loading data, and the
actual byte length is checked afterward. Current limits are 32 MiB for a
manifest, 100,000 artifacts, 256 MiB per artifact and 64 GiB in total; callers may
lower them. Larger artifacts require a future streaming verifier and are refused
before an installation decision. Each storage/hash operation has a bounded wait,
and cancellation or a changed caller context stops further work. A native read
already in flight may finish, but cannot resume a cancelled verification.
Cross-window ArrayBuffers are supported.

Existing structural recovery and paused-share export use this verifier for their
final archive recheck. Their additional live-capture comparison remains required.
The structural recovery's final synchronous editor check now also respects the
source namespace, so an unchanged selected history is not mixed into its legacy
archive and falsely reported as a new edit. A real late selected-source edit
still refuses teardown and retains the unresolved conflict.

Verification is read-only and returns a summary, not authority to activate a
source or a mutable list of trusted installation bytes. It neither proves that
the source is still current nor provides a filesystem lock. An installer must
recheck its journal, scope, server generation, writer isolation and bytes at its
own write boundary. Extra, unlisted files are not consumed as recovery inputs.
The native installation coordinator and its user-facing resume flow remain
unfinished; no activation action is enabled by this change.

Automated coverage uses real disposable filesystem archives and IndexedDB
preparations reopened through a fresh journal handle. It covers corruption of
each artifact family, replacing a manifest/marker, missing completion, unsafe
paths, invalid manifests, size limits, file growth, stalled I/O, cancellation,
caller changes, concurrent manifest replacement and cross-window buffers.

Verification: **4,177 tests across 295 suites** pass (40 tests/26 suites skipped).
Main types, changed-source lint, the unchanged test-type ratchet (205 errors/44
signatures against its 207/46 baseline) and preview build pass. The build retains
15 existing warnings. Native/mobile restoration acceptance remains pending.
