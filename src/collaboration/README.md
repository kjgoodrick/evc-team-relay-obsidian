# Collaboration foundations

These modules are implemented/tested primitives, not an enabled comments UI.
No worker is constructed by plugin startup yet. The server protocol is documented
in the matching server checkout at `docs/discussion-preview.md`. Current commands
support whole-note discussions only; text/Bases target primitives remain separate
until their authorization, identity, and native rendering gates are complete.

## Local commands and delivery

`DiscussionStore` persists drafts, operations, cached entities and checkpoints in
IndexedDB, partitioned by canonical server URL, account UUID, local vault identity,
and share UUID. Use the transport's normalized `identity.serverId` when opening
the store. IndexedDB schema version 3 preserves previous drafts/outbox/cache,
and adds per-scope invalidation generations to the version-2 scope index.
Payloads are copied before asynchronous writes,
so another pane cannot mutate a command during persistence.

In the local queue, `scopeId` is the **managed entry UUID**, available offline.
`payload` is the server's command object (including its `type`), not an entire
envelope. `operationId` is a stable UUID generated once. The transport constructs
the envelope using its immutable share/account identity. The server's returned
`scope_id` is separate metadata; never replace the local queue key with it.

Only create, ordinary reply, own edit, and desired-state reaction commands can
be queued. Payload/type mismatches and online-only `reopen` flags reject before
HTTP. Resolve, reopen, delete and moderation need a separate online action path.
Queue a reply behind an unaccepted thread-create operation using `dependsOn`.
A rejected dependency remains visible for recovery and does not block unrelated
work. Do not mutate its operation ID or payload to repair it: a reviewed new
command needs a new ID and explicit dependency repair.

`DiscussionTransport` gets fresh session credentials through an injected async
callback for each attempt. It verifies the callback's account UUID before sending
to the fixed server. Use the existing native authentication manager for that
callback. Never pass a document grant or agent key. It validates matching operation,
thread and message IDs and safe integer revisions before acknowledging success.
Bodies, tokens and cursors are excluded from platform network diagnostics using
`sensitive: true`; errors retain only known protocol codes. The request deadline
is 20 seconds, below the worker's 30-second lease.

`DiscussionOutbox` owns scheduling:

- `resume()` starts or resumes after credentials/protocol/storage repair.
- `wake()` after durable enqueue or connectivity changes triggers delivery only
  while active. It does not undo an authentication/protocol pause.
- At most one request runs per worker. IndexedDB leases coordinate other windows.
  Each turn processes at most 25 operations before yielding. Idle empty/blocked
  queues have no polling timer.
- Network/408/429/5xx failures retain the immutable command, use exponential
  backoff with jitter, honor bounded Retry-After, and cool down the whole worker.
  New enqueue/wake notifications cannot bypass that cooldown.
- 401 pauses; malformed successful responses and missing/disabled previews pause.
  403/target-404/conflict/invalid-command errors preserve a rejected local draft
  for review. 403/404 also clear the affected remote cache/checkpoint, preserving
  local drafts/outbox. Other scopes remain intact.
- `stop()` invalidates the current generation and ignores late HTTP results.
  Await `settled()` after stop before closing or clearing the store. The native
  Obsidian `requestUrl` API cannot cancel an already submitted POST. The server
  may accept it; a later worker recovers the identical operation using its receipt
  after the lease expires. This is retry-safe, not a remote cancellation promise.
- Acknowledgment persistence failures pause with `storage_error`, leaving the
  operation recoverable. UI status callbacks cannot alter command delivery.

The transport now provides capability discovery, authorized thread/message/history
reads, and a separate one-attempt `sendOnline` method for moderation and Send and
reopen. Keep an ambiguous online operation's ID/payload for an explicit retry;
never put it into the offline queue. Reads validate response IDs, revisions,
pagination progress, supported structured bodies and event kinds. Read responses
are capped at 512 KiB; command responses remain capped at 64 KiB.

The host controller still needs capability negotiation wiring, account/logout lifecycle,
cross-window enqueue notifications, explicit local-data removal UX, draft/rejection
review, dependency repair and attachment staging. The store's `clearAll()` is an
explicit local cleanup primitive, not an automatic logout policy. Stop every
worker sharing that store before using it. Revocation does not promise erasure
of already downloaded content or user-authored local recovery text.

## Inbound data and targets

`DiscussionSync` implements incoming authorized replay for one visible entry.
It reads 25 metadata events per page, collapses repeated message targets, and
fetches current messages/reactions or thread state without downloading entire
conversations. Cache revisions use the read's thread activity sequence because
reactions do not increment message edit revisions. Thread removal purges cached
message bodies atomically; a missing message triggers an authorized state read
that distinguishes removal from entry revocation. Removed state never includes
the anchor or comment body. A plain absence in a page never deletes cached data.

`applyRemoteBatch` atomically updates entities/acks/checkpoint/purges with both
cursor and invalidation-generation preconditions. Clearing a scope increments
its generation, fencing in-flight reads even when its cursor was already empty.
Expired/changed-epoch cursors clear remote state and restart retained replay;
drafts/outgoing operations survive. Stop the worker and await `settled()` before
closing its store. Authentication/protocol failures pause; network errors back
off. Stop during a pending read ignores its late result.

The worker yields after three pages and uses a five-second active-surface fallback
after catching up. The host must stop it for hidden/background surfaces and wake
it for relevant invalidations/local sends. WebSocket invalidation, snapshot/event
retention and host lifecycle wiring remain open; this is not a mobile battery or
native UI claim. The current server retains all metadata, so do not enable pruning
until a snapshot bootstrap protocol replaces replay from zero.

The text anchor module captures shared Yjs/Yrs encodings and dependency evidence;
it does not itself prove server durability. The Bases module provides view-scoped
identity types and currently supports calendar-date/instant ranges. Historical
and ordinal timeline codecs, saved-view reconciliation and the Time & Line API
bridge are still required. No generic DOM/pixel identity is used.

## Validation

Unit tests use fake IndexedDB and controlled transports to exercise restart,
leases, cross-window claims, immutable retries, account checks, backoff, failed
authorization, storage failure, cursor transactions, old-schema upgrade and
privacy diagnostics. These are not native mobile storage/battery claims.

For an actual HTTP contract check, run from the server's `apps/control-plane`
with its Python environment and the plugin's locked Node dependencies available:

```sh
python tests/integration/discussions_client.py --plugin ../../../evc-team-relay-obsidian
```

The harness creates a temporary SQLite database and loopback FastAPI process with
synthetic accounts, runs `realDiscussionStack.test.ts`, and removes/stops them.
It proves a lost accepted response/retry, dependent reply, history, reactions,
policy change and preserved rejected text across the real boundary. The normal
Jest run skips this opt-in test. PostgreSQL lock/migration tests live in the
server's separate `discussions_postgres.py`; this client test does not substitute
for them. No native vault or running service is touched.
