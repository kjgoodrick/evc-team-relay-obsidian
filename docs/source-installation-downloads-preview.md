# Downloads for a reviewed source installation

`createSourceInstallationDownloads` supplies the preparation coordinator's
source, attachment and inventory-revalidation callbacks. It captures a detached
copy of the reviewed inventory and exact host/server/endpoint/folder/generation
identity. Requests must match that identity and the captured entry's path, ID,
type and revision. Unknown or relabeled entries fail before a network read.
Account changes, caller-context invalidation and cancellation are checked before
and after asynchronous work. Inputs and transport options are captured before
awaiting anything.

Markdown and existing Canvas source files use the isolated read-only source
preview, without loading retained local history or joining ordinary synchronization.
This preserves existing Canvas files during recovery; it does not add Canvas
discussion features. Attachments use the bounded, hash-verified streaming helper.
Returned previews must still pass their own validity checks before their bytes
are returned to staging. All downloads are read-only; this adapter writes no
files, caches, journal decisions or server content.

Revalidation obtains a fresh read-only inventory grant and streams the visible
manifest without creating an index document or running reconciliation. It checks
the captured generation before and after the read, caps decoded JSON at 16 MiB
and records at 10,000, and rejects redirects or another configured endpoint.
Preparation then performs the stricter entry/permission/activity/owner/content
comparison against its verified installation plan before advancing the journal.
This remains an inventory freshness check, not a simultaneous snapshot of every
live editing document.

Inventory GET authenticates after acquiring the share read lock, including
credential expiry and login-session checks after waiting, and uses `no-store`.
The ordinary index reader retains its ability to discover a restore; the new
inspection client refuses to adopt a changed generation. Read grants cannot
publish index changes. Token response bodies are excluded from network logging.

Streaming inventory and attachment requests require a host-supported `fetch`
and a server origin policy allowing that host. Desktop/mobile origin and stream
behavior still need native acceptance; no live origin policy was changed and
there is no fallback to the buffering Obsidian HTTP adapter. Native recovery
directory I/O, operation-intent persistence/resume UI, writer isolation, native
installation and activation remain separate unfinished work. No user-facing
activation control is enabled by this adapter.

Focused checks cover routing, immutable metadata, wrong sources/entries/revisions,
Canvas preservation, account changes, invalidated previews, cancellation,
unsupported/mismatched grants, bounded inventory bodies, changed generations and
stalled/late responses. The actual plugin/loopback HTTP/MinIO fixture exercises
the adapter's captured attachment read and fresh inventory revalidation, and
proves an owner's read-only inventory grant cannot POST changes. Fixture resources
are removed after the run.

Validation: 60 focused client checks, 35 managed-server tests and the full plugin
regression pass (4,403 tests across 303 suites; 41 tests/27 opt-in suites skipped).
Main types, changed-source lint, the unchanged test-type ratchet and production
preview build pass, with 15 existing build warnings. The test-type ratchet remains
205 errors/44 signatures against the frozen 207/46 baseline.
