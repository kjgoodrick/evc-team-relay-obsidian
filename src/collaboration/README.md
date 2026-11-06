# Collaboration foundations

These modules now include whole-note and selected-text native discussion previews. Plugin startup
constructs `DiscussionHost`, which owns account-bound `DiscussionSession` instances
and negotiates the server's disabled-by-default discussion capability. The complete
text/image/Bases/presence feature is not enabled or finished. The server protocol is documented
in the matching server checkout at `docs/discussion-preview.md`. Current commands
support whole-note discussions in the native sidebar and selected text through
the editor command/context menu behind a separate capability. Desktop Source
mode and Live Preview capture, highlights, thread navigation, and draft restoration
have been exercised against the real control plane/relay in a disposable vault.
Block capture now expands selections/carets to Markdown source blocks and uses
the same durable relative ranges. It is capability gated, preserves existing
block IDs without editing the note, supports 1–32 blocks, and round-trips through
the actual control plane/relay with comment-only access. Offline restart and
capability changes preserve the queued target. Reading view now has a native
preview using public section metadata, the existing view/CRDT binding, exact
source-to-DOM maps, shared leaf subscriptions and cached source parses. Desktop
testing proves repeated-word and table-cell capture, accepted comments, exact
Reading navigation, reload, and explicit whole-callout block capture. A separate
Reading syntax parser now maps wiki aliases, highlights, hidden inline comments,
written callout titles and callout bodies, including nested callouts. Native
checks verified a repeated alias, highlighted text, written/generated titles,
nested body selection and reload. Generated callout titles have no invented text
range; they retain the block fallback. Multiline hidden comments, colored
highlights, complete construct coverage, block lifecycle recovery, mobile and
resource acceptance remain unfinished.
Bases primitives still require identity, authorization and native adapters.

The provider now publishes only its own awareness ID, including query responses
and timeout cleanup, and advances the local clock on reconnect. The matching
managed gateway replaces peer identity with authenticated account/profile data;
the Rust room enforces socket ownership and rejects collisions. See the server's
`docs/presence-boundary.md` and the opt-in `__tests__/presence/realPresenceStack.test.ts`.
The provider now coalesces cursor updates and distinguishes bounded collision
recovery from delayed capacity retries while retaining normal note sync. Recovery
rotates only the awareness ID; CodeMirror identifies self using that ID. The
provider exposes availability and explicit retry. `PresenceController` now owns
foreground-note publication across leaves/popouts, using the existing document
binding and connections. Background providers start silent; hidden/background,
private, deleted or moved-out-of-share notes withdraw presence. Reading announces
its surface with no editor caret. Account/session grant changes cannot republish
an old identity. Native settings, a note-header control and commands provide
persistent privacy and status/retry controls. A disposable desktop Obsidian
instance plus a protocol observer verified privacy/reload, active-note switching,
Reading transitions and popout transfer. The next increment adds a grouped
current-note roster with separate session actions, semantic editor viewport and
Reading block/selection publication, and current-note Jump/Follow. Navigation
scrolls without editing or changing the local selection. Follow stops on manual
interaction, view/note change, peer departure, disconnect or access loss. A
visible Stop control and command remain available while following. Reading
navigation materializes offscreen targets through the public source-line scroll
API, then verifies the rendered section; cancellation fences late rendering.
Desktop testing verified Live Preview and Reading jumps/follow, Reading selection,
manual scroll interruption and reload. Reading postprocessor ownership now avoids
duplicate controls when the same root is processed again. The authorized
cross-note location channel described below is now connected. Remote Reading highlights, image/Bases adapters,
socket backpressure, two-native-client rendering and mobile acceptance remain.

Cross-note preparation now gives the foreground controller one random instance
UUID per plugin lifetime and publishes it across active-note transitions. Profile
refresh preserves this identifier; background/privacy still removes the whole
awareness state. Peer parsing accepts the optional validated UUID, retaining
compatibility with previous states. The matching server has an opt-in location
transport preview documented at `docs/presence-location-channel.md`; the plugin
now connects to it as described in the cross-note presence section below.

## Embedded-image discussion preview

`ImageComments` adds whole-image, pin and region targets to Markdown image
occurrences behind `discussion_image_occurrences`. Its static placement dialog
works from Source, Live Preview and Reading; the existing draft/outbox stores
the entire image target. The nested Y.Text anchor keeps repeated embeds distinct
through edits. Managed assets require current same-share read access and verified
local bytes, and retain their entry ID/hash. External HTTP(S) URLs are rendered
only by the client with explicit unknown-version evidence. Changed assets or
dimensions suppress old geometry on the replacement.

Native desktop tests verified a second-occurrence pin, reload of the unsent draft,
an external region in Reading, Source-mode whole-image capture, accepted threads,
and reopened geometry without modifying note/image files. The actual
Python/Rust/plugin fixture runs with `--image-anchors --plugin <this checkout>`.
The matching server documents the payload and rollout boundary in
`docs/image-discussion-preview.md`. Upgrade all clients before enabling it:
older parsers do not understand image anchors in a thread feed.

`RenderedImageComments` now places saved pin/region overlays and per-image
controls over native Live Preview and Reading images. The adapters use CM source
positions or current Reading sections, independently verifying the displayed
asset/version. A pane shares its source parse and dependency snapshot. Digest
verification caches no bytes, coalesces duplicates and permits at most two
distinct reads/hashes at once. Queued work for closed surfaces is abandoned.
Permission loss or stale source clears controls; late verification cannot revive
a removed overlay. Object-fit, ordinary scaling and clipped viewports preserve
intrinsic geometry, and cropped-out marks do not retain keyboard focus.

Desktop tests verified duplicate-image pins, external regions, thread navigation,
scrolling/sidebar resizing, reload and an off-center cover crop. Creation still
uses the placement dialog. Direct manipulation, directly opened image files,
comment picture uploads, image presence, arbitrary transforms, all format/EXIF
cases, mobile and resource acceptance remain unfinished.

## Local commands and delivery

`DiscussionStore` persists drafts, operations, cached entities and checkpoints in
IndexedDB, partitioned by canonical server URL, account UUID, local vault identity,
and share UUID. Use the transport's normalized `identity.serverId` when opening
the store. IndexedDB schema version 5 preserves previous drafts/outbox/cache,
invalidation generations, ordered cache pages and local preferences, and adds
indexed selection-draft paging. Draft preconditions and atomic enqueue/removal protect edits
from another pane. Manual online-action intents are separate from the outbox;
they preserve IDs through ambiguous responses and never auto-submit.
Payloads are copied before asynchronous writes,
so another pane cannot mutate a command during persistence.

The editor captures from its actual live Y.Text binding only when document ID,
generation, permission and editor content agree. It freezes that target before
opening the sidebar. Each captured selection gets a separate durable draft ID;
switching drafts does not change anchors or discard text. Sending retires only
that draft, and a conditional preference update cannot replace a newer selection
in another pane. Invalid stored anchors leave the authored text selectable but
cannot silently turn into whole-note comments. Comment decorations use relative
positions and viewport clipping; account/access changes hide old highlights
synchronously. A target button reveals the exact range or explains that it is
unavailable, without guessing another occurrence of the quoted text.

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
- 409 `anchor_dependency_not_ready` also retains queued work and honors backoff;
  note synchronization must reach the relay before validation can succeed.
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

Text commands allow a 256 KiB envelope containing at most 64 KiB decoded snapshot
evidence, while whole-note commands retain the 64 KiB limit. Wire parsing binds
text anchors to their requested document and validates UUIDs, Unicode and byte
limits. Sessions cache authorized generations for offline capture; refresh never
changes a queued anchor's generation. Revocation removes the cached generation.
The current Rust relay, Python control plane and plugin pass a real-connection
fixture covering deletion-only dependencies, private authentication, lost replies,
and relay restart: run the server's `tests/integration/managed_stack.py` with
`--text-anchors --plugin <this checkout>` after building the Rust relay.

The native host now provides capability negotiation, account/logout lifecycle,
foreground/hidden-surface handling and cross-window notifications. The sidebar
has persistent drafts, replies, reactions, mentions, history and online state/removal
actions. Full rich-text editing, explicit local-data removal UX, actionable draft/
rejection review, dependency repair and attachment staging remain. The store's `clearAll()` is an
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
it for relevant invalidations/local sends. The host now does so. WebSocket
invalidation and snapshot/event retention remain open; this is not a mobile battery or
native UI claim. The current server retains all metadata, so do not enable pruning
until a snapshot bootstrap protocol replaces replay from zero.

The text anchor module captures shared Yjs/Yrs encodings and dependency evidence;
it does not itself prove server durability. The Bases module provides view-scoped
identity types and currently supports calendar-date/instant ranges. Historical
and ordinal timeline codecs, saved-view reconciliation and the Time & Line API
bridge are still required. No generic DOM/pixel identity is used.

## Cross-note presence preview

`presence/LocationChannel` provides one ephemeral foreground connection per
account/login session/plugin instance. It negotiates `presence_locations_preview`,
authenticates with single-use tickets outside the socket URL, refreshes credentials
in place, coalesces publication and bounds retries, heartbeat and buffered sends.
`LocationHost` resolves only unique authorized local managed entries, isolates
account/server changes and stops on private/background views. No presence history,
outbox or extra background note connection is created.

The native controller follows a known participant across shared Markdown notes
while preserving the viewer's Source, Live Preview or Reading mode. An awareness
departure does not immediately cancel an active cross-note subscription; waiting
for a new destination/binding is bounded to eight seconds. Manual interaction,
navigation, backgrounding, disconnect and inaccessible destinations stop Follow.
Presence reconnects automatically, but Follow requires an explicit restart.
Hiding the viewer's own presence does not prevent following another participant.
Older servers/peers retain current-note navigation with an explicit scope message.

The actual Python/Rust/plugin fixture runs with the server harness's
`--presence-locations --plugin <this checkout>` option. Desktop Source, Live
Preview and Reading have disposable-vault evidence with a protocol peer;
two-native-client and mobile acceptance remain open. The server preview is
disabled by default and currently requires one designated application process.
Image/Bases presence and remote Reading selection rendering are not implemented.

## Validation

The direct managed-image-file protocol is available independently of text-anchor
barriers through `discussion_image_files`. Its `image_file` target binds the
managed asset ID, server generation, observed hash, intrinsic basis and geometry.
Use `DiscussionSession.watch(entryId, listener, "image")` to obtain that file's
context. The existing cache/outbox preserves offline drafts, exact retries and
original version evidence; it never rewrites queued targets after lineage changes.
Read responses and queued commands must match the requested file. The native
host/composer/reveal/overlay wiring for directly opened files is not implemented
yet. The real-service fixture is `--image-files --plugin <this checkout>` in
the server's `tests/integration/managed_stack.py`; it verifies offline replay
with comment-only access and text barriers disabled.

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
