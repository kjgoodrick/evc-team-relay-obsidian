# Restore-generation client foundation

This is a tested discussion-command, picture-upload, group-capture, inbox and
timeline-marker, permission, Bases-content, saved-view and inventory restore guard,
not a complete restore workflow.
Do not activate a restore generation in a live deployment yet. Complete
user-facing reconciliation, guards for other mutations, and a
coherent PostgreSQL/CRDT/private-picture backup and restore procedure remain.

Each discussion operation may retain `restoreGeneration` as local metadata.
Missing metadata and `null` mean the original server lineage. Mutation transport
sends a nonnull value in `X-Relay-Restore-Generation`, captured before credentials
are refreshed. The metadata never enters the canonical command body. Retrying
an old operation does not adopt a newer capability generation. Read-only receipt
inspection remains available without this mutation precondition; an unknown
receipt is never proof that a request did not commit.

`DiscussionStore.observeRestoreContext` requires the checkpoint revision read
before capability discovery. It rejects a late observation from another window
and refuses to downgrade a known nonnull lineage to an unsupported/original
server. Callers must stop workers and invalidate their in-memory context before
using it. The ordinary session now performs this observation during startup,
refresh and reconnect, before resuming old work. It retains the last learned
binding for offline intent creation. Restore invalidation drains old workers,
clears in-memory authority, broadcasts an invalidation signal to other windows,
reloads the inbox and reauthorizes visible targets. Cached permission/directory
reads use generation checks too, so a late old response cannot restore authority.

When a new generation is observed, one IndexedDB transaction:

- Preserves drafts, original pictures, recovery captures, pending online actions,
  original request payloads, and their lineage bindings.
- Stops older queued/sending/rejected requests by retaining them as rejected with
  `restore_generation_changed`. Already withdrawn review drafts retain their
  distinct review state. Accepted receipts remain historical records, and cannot
  authorize new-generation dependent requests.
- Clears derived entities, event cursors, downloaded pictures and target/access
  caches. A global fallback generation fences in-flight reads even for scopes
  that have never been cached, in addition to existing per-scope generations.
- Clears inbox projections and leases, advances the inbox epoch, and preserves
  pending inbox choices as rejected for review.

Enqueue, claims, retries, dependency checks, group preparation and late accepted
responses check the persisted context. New commands must supply a generation
captured at intent creation; the store never stamps a missing generation. Picture
dependencies inherit their parent's binding. Online draft completion/retry cannot
erase or restamp an older unconfirmed action. Group wire preparation and saved
request review preserve this metadata.

IndexedDB version 27 closes older workers and prevents them from opening this
store with an earlier version. Portable recovery copies retain the optional
metadata and validate it on inspection. Their existing envelope format remains
version 1/storageVersion 23; older strict readers reject requests containing the
new field instead of silently losing their binding.

Composers capture the binding at the Send click before awaiting local saves.
Moderation, state changes and online replies retain the original binding for
manual retries; durable target moves also check the binding in their completion
transaction. Older pending cards explain restore review and offer receipt
inspection, without presenting ordinary retry/replacement controls. Selecting
and copying the saved text remains available. Reconciliation of original
requests and their dependents into the restored service remains unfinished.

Picture staging, upload admission and final metadata commit retain the original
generation. The server upload ticket binds it across body receipt and object
storage; rotation during either interval prevents metadata publication. Immutable
objects written before a rejected final commit remain unreferenced cleanup
inputs. Bases group capture checks the generation before receipt lookup and again
after source validation. Retries preserve both the binding and canonical capture
body. Queued group creation, target moves and online picture replies carry it.

On a restored share, picture upload and group capture require the separate
`discussion_picture_restore_guard` and `discussion_base_group_restore_guard`
capabilities. Missing guards disable those authoring paths. Cached capability
decisions survive offline startup; an older queued request cannot gain a new
binding when these features become available.

Inbox read/unread/dismiss and follow/mute choices also retain their original
generation. It is captured before the local save and checked in that transaction
and before delivery; the transport freezes it before credential refresh. A
restored share requires `discussion_inbox_restore_guard` before enabling the
inbox. Exact subscription retries still require the matching generation. Reads
remain accessible through ordinary authorization without a mutation header.

Local rotation rejects queued choices and invalidates the worker lease/epoch,
so a late old response cannot clear the choice or replace restored state. A
server restore rejection stops delivery, preserves dependent choices for review,
and never retries automatically. The inbox explains the reason and lets the user
keep the server state before making a new choice. Version 27 specifically fences
older workers whose inbox parser would discard this binding.

Shared marker saves capture the binding before asynchronous axis validation and
retain it in the durable management slot. Exact retries after lost responses or
reload send that same header. Local completion checks the binding again, so a
late receipt after another window's restore cannot turn the old slot into a
current acceptance. The server checks under its share lock before marker receipt
or revision lookup. `discussion_timeline_marker_restore_guard` is advertised
independently of new-marker authoring so accepted-receipt retries remain possible
when that feature is disabled. Old pending marker requests remain inspectable;
the dialog explains the restore and offers no ordinary retry/discard.

`discussion_timeline_marker_command_status` enables **Check saved result**. This
read-only POST verifies the current actor's exact request hash and present read
access to the base; edit permission and a mutation-generation header are not
required. The response is either the matching accepted receipt or `unknown`.
Unknown is never proof of nonacceptance and does not change the retained slot.
An accepted receipt can complete the local review while preserving its original
binding, followed by explicit acknowledgement to load current marker state. No
marker mutation is sent. Another restore, request replacement or closed review
fences a delayed response. Original requests with missing restored receipts still
need explicit reconciliation; no automatic replacement or replay is provided.

Validation includes fake-IndexedDB multiwindow, rollback, unseen-scope response,
dependency, picture preservation, inbox and online-draft tests. The real HTTP
proof runs an isolated loopback control plane with a synthetic nonnull generation:

```sh
# From the control-plane checkout, with the plugin's Node toolchain on PATH:
.venv/bin/python tests/integration/discussions_client.py \
  --plugin /path/to/evc-team-relay-obsidian --restore-guard
```

That proof verifies old writes/withdrawals are rejected, old queued content stays
local, explicitly bound new commands work, accepted retries stay idempotent, and
receipt reads remain available. It also exercises the ordinary session against
HTTP: startup quarantine, new delivery, online resolve, offline queue capture and
reconnect delivery. The actual inbox projection worker also delivers a mention,
then the ordinary session sends offline read-state and follow/mute choices with
their original binding. Missing-generation retries fail without changing state.
Adding `--pictures-endpoint 127.0.0.1:PORT` with an owned
disposable MinIO fixture also exercises ordinary-session picture upload,
attachment, stale retry rejection and local-original reclamation. PostgreSQL
group capture tests rotate the generation during private source observation and
verify that no value, witness or receipt is committed.

These proofs do not restore database/object/CRDT backups or supply
native Obsidian/mobile acceptance evidence.

Marker-specific HTTP proof:

```sh
.venv/bin/python tests/integration/base_content_client.py \
  --plugin /path/to/evc-team-relay-obsidian --restore-guard
```

It loses an accepted marker response, reopens the ordinary session, recovers the
same request with the same binding, and rejects a legacy retry. PostgreSQL also
checks that a marker save blocked on the share lock sees a concurrently rotated
generation even when its ORM identity was loaded earlier. The proof additionally
represents old pending slots in the disposable store, confirms known receipts
without rebinding/replay, and keeps unknown requests unchanged. PostgreSQL checks
that receipt reads leave marker, revision and receipt counts unchanged.


Combined permission editing reads `restore_guard`/`restore_generation` with the
policy snapshot. The save freezes that binding before credential refresh and
uses it only as a mutation header. The server validates it under the share lock
before revision/no-op checks. A restore rejection retains the proposed rules and
requires reading current policy, explicitly merging and reviewing, then saving
against that new snapshot. New narrower exceptions remain in the merge. Reads
carry no mutation header. Lost acknowledgments require read-only reconciliation;
a mismatched generation or dropped guard in a success response remains
unconfirmed. Independent file-only/comment-rule endpoints now enforce the same
server guard. Legacy file-only forms send no binding and remain usable only on
original-lineage shares; use the combined editor after a restore. The legacy
list response shape remains unchanged, and no client silently adopts a new
binding for its old rules.


Guarded Bases content publish/withdraw now carries immutable request bindings as
well. Its separate per-entry snapshot/worker/recovery model and storage version 3
are documented in [the Bases implementation](../src/bases/README.md#restore-generation).
The actual restored HTTP scenario exercises explicit initialization review,
lost acceptance/reopening/exact retry, older pending work, and historical receipt
inspection. PostgreSQL verifies publication and withdrawal waiting across a
restore both reject before receipt/content changes. Full restored-work
reconciliation remains.

Saved-view repair binding and registry cache version 2 are documented in
[the saved-view contract](../src/bases/README.md#saved-view-restore-binding).
Current snapshots retain their restore context; pending repairs keep the original
binding through copying, persistence, reopening and transport. Restored cache
observations retain prior mappings even when the server revision moves backwards.
The read-only repair receipt control preserves old intent without requiring
synchronized source bytes or sending a mutation. The actual HTTP suite covers
old-request rejection and fresh bound lost-response retry; PostgreSQL verifies
waiting repair/replay restore rejection and read-only receipt authorization.

## Inventory preservation

Managed manifests and claims advertise the restore context. Batch/activity saves,
automatic conflict retries, reviewed layout decisions and claims retain their
original binding outside the canonical body. A known restored client preflights
its next batch/claim before writing to a potentially downgraded server. Claims
freeze their body before waiting behind another exchange; Bases acknowledgments
also carry the original pending binding. Fresh empty clients may join a restored
share; older or unproven local work is held for review.

The private folder Y.Doc retains a `managed_base_v1.restoreReview` record with
the previous and observed inventory plus the local records/activity at detection.
Existing file metadata, conflicts and activity remain intact, including later
local edits. A restored inventory cannot trigger automatic conflict rebasing,
claim adoption or source-metadata acknowledgment. Read/write authority is withheld
for inventory consumers, retries stop, and reopening reports the retained pause.
The conflict dialog explains why ordinary layout choices cannot resume it and
offers an offline, verified local source copy. The copy includes known retained
document histories and metadata, unsaved buffers, loaded native files, inventory
and review context. It leaves synchronization paused; discussion/Bases queues and
unassociated caches are outside its explicitly recorded coverage.

This checkpoint has no safe-resume or discard operation. Full inventory/CRDT/file
reconciliation, verified byte recovery, minimum client versions, native acceptance
and coordinated restore remain unfinished. The metadata record does not by itself
back up source bytes, fence an older plugin cache worker or drain document sockets.

## Managed source attachments

Blob transfers capture file, share, provider/account and inventory context before
their first asynchronous read. Token requests retain that original restore
binding. A returned different generation, observed inventory restore, stopped
transport, moved file/share, changed login or teardown prevents later transfer
steps and metadata acknowledgment. The final upload response must succeed, and
the acknowledged digest/mtime belongs to the captured bytes rather than a later
local hash lookup. Downloads validate status and digest before returning bytes;
local stat/context checks guard the subsequent native write.

File grants have their own bounded memory cache (256 entries), outside persisted
document credentials and background renewal. Server/provider session, file,
digest, content type, byte length and restore binding distinguish requests.
Identical requests coalesce; session changes and cache clear reject late results.
Routine JWT refresh within the same session does not invalidate the namespace.

The paired server stores verified revisions at
`managed-assets/v1/{share}/{entry}/{sha256}`, with verified legacy reads. This keeps
an in-flight old upload from replacing the bytes selected by restored inventory.
Actual TypeScript/HTTP/MinIO and PostgreSQL race tests cover these boundaries.
It does not provide atomic filesystem replacement, a pre-write source-byte
backup, native/mobile acceptance, full restore reconciliation or safe resume.

## Document socket admission and automatic pause

The paired server now binds managed document grants to the request's original
restore generation and checks it on admission and active socket traffic. The
`realDocumentRestore` fixture verifies the actual credential cache and
ProviderBacked against FastAPI/Rust. Open readers/writers close; a cached original
credential receives a dedicated `4412` close without opening an upstream relay;
an uncached original token request receives `409 restore_generation_changed`.
All three client paths pause without reconnect/token-refresh loops and preserve
their local Y.Doc edits. Explicitly bound fresh low-level clients can read/write
the current generation. Current file/session authorization precedes the restore
close, so revoked access does not reveal the restore state.

The automatic document path retains its original null binding; token responses
cannot assign it a new generation. A detected pause survives manual retries and
credential-cache clearing during that runtime. In-flight success cannot undo it,
and unloading settles late credential requests without recreating cache entries.
Markdown and existing Canvas sync also respect the parent inventory's durable
restore review. Ordinary original-lineage synchronization remains compatible.

Each Markdown/Canvas document now also records a monotonic review marker in its
existing private cache, independently of folder inventory. Saving it does not
replace updates, sync bases, origin or server-sync metadata. Cache close drains
the marker transaction and accepted edits. Opening and token acquisition read it
before network work, including the otherwise fresh cached-token path; that read
also detects another window's marker. Failed writes reject instead of reporting
durability, while the current runtime stays paused. There is no marker-clear or
resume action. Existing plugin workers are not excluded from the legacy cache.

The actual-service fixture closes the paused store and reopens a fresh client:
its old edits return and it makes no token request. Unit checks include marking
during startup, immediate close, second-window discovery, failed persistence and
unload during the read. These use fake IndexedDB, not native/mobile persistence
acceptance. Safe resumed cache namespaces, verified source replacement and full
review remain required; the legacy cache's versionless IndexedDB open means a
version bump alone cannot exclude older workers. No native restore workflow,
restored-data drill or coordinator is claimed by this admission/pause test.

## Background source writes

Native document writes and inventory acknowledgments also check durable review.
They retain the document/share path, identity, server, account session and live
provider selected before waiting. Renaming, deletion, structural recovery,
provider/account replacement, unload or restore review before the native write
starts prevents that write. Editor saves also abandon a text snapshot superseded
while reading the review marker. A legacy document cache pauses when its parent
has already adopted a nonnull restored inventory, even without an inventory
review record. That inventory cannot authorize automatic reuse of old CRDT work.

Background pull, upload reconciliation, conflict-copy replacement and queued
upload retries stop at known restore review. Late startup/metadata callbacks no
longer acknowledge that old work; already deleted entries retain their prior
no-op acknowledgment behavior. Ordinary writes and a new entry at a previously
deleted path remain supported. Tests cover detection during reconciliation claims
and conflict-copy writes, delayed native writes, account/path/provider changes,
cached review and both pending and newly scheduled retries.

These are pre-write guards. Obsidian's adapter does not provide an atomic
compare-and-write transaction across a native file and IndexedDB. A write already
handed to the host may still finish. Verified original-byte backups, protected
source replacement, new cache namespaces and the full restore/review flow remain
required before enabling restore as a supported user operation.

The existing structural recovery archive now reads back and hashes every saved
artifact, records a versioned checksum manifest and rechecks it before a layout
decision moves originals. Its [format, verification and limits](managed-recovery-backup-preview.md)
are documented separately. Paused shares now use the same verifier to export
their known local source work. This does not reconcile all queues, find every
orphaned cache, replace files or authorize restored synchronization.
