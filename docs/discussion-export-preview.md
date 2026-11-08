# Shared discussion archive preview

November 7, 2026. The comments sidebar can export posted discussions for the
current note, directly opened image, or explicitly selected saved Bases view.
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

Share-wide collection, resumable/paged larger archives, reviewed import, coherent
service backup/restore and physical mobile/resource acceptance remain unfinished.
This is a portable discussion copy, not a coherent service backup or an outbox.
No migration, production deployment or live-vault installation is included.
