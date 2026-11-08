# Restore-generation client foundation

This is a tested discussion-command, picture-upload, group-capture, inbox and
timeline-marker restore guard, not a complete restore workflow.
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
the dialog explains the restore and offers no ordinary retry/discard. Read-only
receipt reconciliation for these old marker requests remains unfinished.

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
generation even when its ORM identity was loaded earlier.
