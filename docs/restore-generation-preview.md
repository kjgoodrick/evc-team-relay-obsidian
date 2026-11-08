# Restore-generation client foundation

This is a tested transport/storage foundation, not a complete restore workflow.
Do not activate a restore generation in a live deployment yet. Session lifecycle
integration, user-facing reconciliation, guards for other mutations, and a
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
using it; the ordinary session does not yet call it.

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

IndexedDB version 26 closes older workers and prevents them from opening this
store with an earlier version. Portable recovery copies retain the optional
metadata and validate it on inspection. Their existing envelope format remains
version 1/storageVersion 23; older strict readers reject requests containing the
new field instead of silently losing their binding.

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
receipt reads remain available. It does not restore database/object/CRDT backups
or exercise the native Obsidian session lifecycle.
