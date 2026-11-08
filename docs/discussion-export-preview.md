# Shared discussion archive preview

November 7, 2026. The comments sidebar can export posted discussions for the
current note, directly opened image, explicitly selected saved Bases view, or
all readable discussion scopes in the shared folder.
Read permission is sufficient. The server must advertise `discussion_export`
(`COLLABORATION_EXPORT_ENABLED`, independently disabled by default).

## User flow

Open comments and choose **Export discussions**. The dialog shows the selected
note/view, explains exclusions, and defaults to including comment picture files.
**Save discussion archive** captures current authorized server state and saves a
unique `Discussions-<UUID>` folder beneath `Relay Recovery (local only)`.
Team Relay excludes this folder from synchronization; other backup tools may copy
it. The files are unencrypted and are not erased by later access/content changes.

`discussions.json` contains the server snapshot: thread state, full live-message
history, target history (unavailable old Bases targets are redacted), aggregate
reactions and UUID identity references. Removed threads and removed message bodies
are omitted even for moderators/authors. Drafts, queued changes, note files,
permissions, other saved views and private inbox state are not included. Local
saved-work recovery remains a separate operation.

When selected, pictures are downloaded one at a time through the normal
authorized endpoint. The archive saves sanitized content renditions, not original
uploads or separate thumbnails. Pictures referenced only by live-message history
are included. Embedded note images and external image bytes are not downloaded.
If a referenced picture is missing or the collection exceeds 100 MiB, the user can
retry or explicitly select metadata-only export. No silent picture omission
produces an archive claiming picture files were included.

Each picture is verified against the captured hash/length, written under a
generated filename, read back and verified again. JSON and README readback are
also checked. `manifest.json` lists file hashes/lengths and picture selection;
`COMPLETE.json` is written last and records the verified manifest hash. Partial
folders are retained as incomplete evidence, and retries capture fresh authorized
state in a new unique folder. Existing files are never overwritten.

The writer checks the account, authentication epoch, document generation, view and
read access between asynchronous operations. Closing/changing the view cancels
remaining work; a session permits one export at a time. Offline/cache fallback,
automatic command replay and automatic import are absent. Closing during an
in-flight filesystem write cannot retract bytes already written; completion
requires validating the manifest and every referenced file.

## Bounds and validation

The parser binds server/exporter/share/file/view identity, validates known record
shapes, rejects duplicate/orphan/future records and removed bodies, and checks
current revisions and picture references before creating files. It copies only
supported fields; body text/links/paths remain data. Archive output paths never
come from comment or note text. The response is limited to 8 MiB and 5,000 records;
streaming responses are canceled when over budget. Obsidian's native HTTP adapter
may materialize the response before the plugin can inspect its length.

- 126 focused client/protocol/session/DOM/transport/storage tests pass, including
  account/view changes, revoked access, concurrent export refusal, historical
  pictures, removed content, limits, failed downloads/writes, corrupt readback,
  retry into a new folder and metadata-only selection.
- Full plugin suite: 3,367 tests in 253 suites pass; 29 tests in 20 opt-in suites
  skip. Production build/main types pass with 15 existing warnings. Test types
  remain below the frozen baseline (206 errors/45 signatures vs 207/46); no new
  errors. Changed-source lint and whitespace checks pass.
- Actual loopback HTTP/MinIO and filesystem integration passes: read-only member
  export, historical sanitized picture bytes, manifest hashes, deleted-body
  exclusion for reader/owner, and revocation between capture and download leaving
  no completed archive. All disposable services/storage are removed afterward.
- Native Obsidian 1.13.7 saves a note with two message revisions and a separate
  Table-view archive with metadata-only selected. The Table archive excludes the
  seeded Timeline discussion. Both archives' manifests and all files verify;
  note and Bases source hashes are unchanged. The fixture vault is closed, the
  original window restored, and its API/relay processes stopped. Native picture,
  interrupted-write, multiwindow, mobile and accessibility acceptance remain.

Server contract, locks and PostgreSQL measurements:
[server export preview](../../evc-team-relay/docs/discussion-export-preview.md).

Resumable/paged larger archives, reviewed import, coherent
service backup/restore and physical mobile/resource acceptance remain unfinished.
This is a portable discussion copy, not a coherent service backup or an outbox.
No migration, production deployment or live-vault installation is included.


## Whole-folder collections

Servers advertising `discussion_export_catalog` allow the dialog's **Export
scope** selector to include all readable discussions in the shared folder.
**Open comment storage → Export shared-folder discussions** also works with no
active note. The operation uses the same account/session concurrency guard as
single-scope export and does not send, edit, discard or replay local work.

A read-locked catalog lists only scopes with a readable nonremoved thread. Bases
views are separate entries, including authorized archived views; hidden record
or formula dependencies do not reveal a scope's name/path. Catalog rows are
bounded, ordered, unique and tied to account/share/scope/file/view identities.
The client freezes that inventory before beginning the sequential captures.
Each scope is reauthorized; its scope identity, kind, server epoch and sequence
must agree with the catalog boundary. Renames may update captured paths without
reinterpreting identity. Denied/disappearing scopes stop completion instead of
being silently omitted.

The collection folder contains `catalog.json`, a README, individual verified
scope archives, and a collection manifest/completion marker. Its manifest binds
the inventory and each child's verified completion bytes/hash. A failed later
scope can leave usable earlier child archives, but no complete collection.
Retries create a new folder. Inventory capture and per-scope snapshots have
separate times and sequences; concurrent edits can appear in later snapshots,
and new scopes created after the catalog are outside that inventory. The format
explicitly records `atomic: false`; this is not a coherent service backup.

Limits: 256 scopes, 10,000 catalog scan rows, 64 MiB total written text metadata,
250 MiB selected picture files per collection and the existing 100 MiB per-scope
picture limit. All child files use generated names. Larger/resumable collection
support remains future work; no unbounded or silently partial export is added.

Updated validation: **137 focused client tests** pass, and the full suite passes
**3,378 tests / 254 suites**, with 29 tests / 20 opt-in suites skipped. Build/main
types pass with 15 existing warnings; frozen test types remain at 206/45 with no
new errors. Changed-source lint and whitespace checks pass. **24 server export/
catalog tests** cover current/archived views, exact target restrictions, no writes,
limits and removed content. PostgreSQL additionally proves catalog encoding
finishes before a waiting discussion writer commits. Actual HTTP/MinIO/filesystem
collection export verifies two scope archives and picture/completion hashes.

Native Obsidian 1.13.7 exports from the storage panel with no note open. The
collection contains one note with two revisions and separate Table and Timeline
view archives, each with its own discussion. Collection/child completion,
manifest and file hashes/lengths all verify; both source-file hashes are unchanged.
The disposable vault is closed, the original window restored and API/relay
processes stopped. Native large/interrupted/picture/mobile collection acceptance
and reviewed import remain outstanding.
