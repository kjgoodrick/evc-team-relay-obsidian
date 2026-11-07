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
Bases now have server-verified saved-view identities and view/item/cell/property
discussion protocol support. `DiscussionTransport` can capture record lineage,
request view-specific lists/changes and validate filtered pages. The existing
durable draft/outbox preserves these anchors across restart and sends them through
comment-only access; the actual HTTP fixture verifies rename, retry, revocation
and regrant. The native sidebar now offers an explicit saved-view chooser and
targets for the whole view, a managed file record, a cell and a note/file
property header. The discussion view is pinned separately from the native layout;
the target picker searches local shared files and does not evaluate
the view's filters. It saves IDs and property names, never row offsets or display
labels. Inline selection, markers and target navigation remain adapter work.

`discussion_base_record_types` negotiates Markdown, image, audio, video, PDF,
Canvas and generic file records. Older servers default to Markdown only; unknown
kinds are ignored, malformed lists are refused and the negotiated list survives
offline restart. These are Bases rows/cells, not PDF/Canvas content annotations.
Folders, local-only files and ambiguous managed IDs cannot be selected. Only
Markdown records have note properties; all supported records have file-property
targets. The picker preserves an invalid note-property selection until the user
explicitly chooses a file property, and capture rechecks the current inventory.
Type conversions rotate server anchor lineage, including when converted back;
renames and content changes retain it. Existing drafts remain recoverable.

Local scope keys encode both entry and view as `base:<entry UUID>:<view UUID>`;
HTTP still sends the ordinary managed-entry ID with the required view filter.
Drafts, pending operations, pictures, remote entities and update cursors use the
composite key. IndexedDB version 9 preserves version-8 note/image work and fences
older workers that cannot route these keys. Account-bound saved-view choices and
verified capture contexts survive restart. Offline capture requires the cached
generation and, for record targets, a prior record-comment grant. A known denial
clears that grant; delivery always rechecks current server permissions. When an
offline folder has no inventory provider, cached view names can be read using the
same account/server/vault/share discussion session's retained read grant. An
existing inventory denial still wins. No view-repair or file-write authority is
added by that cache read.

Snapshot resets clear cached authority as well as remote entities. The session
finishes any older permission request and reauthorizes before replay so valid
read grants and generations are restored for the next offline startup. The
actual HTTP fixture reproduced the earlier cache-access loss and verifies the
fix through revocation, regrant and an offline restart. A subsequent native
Obsidian 1.13.7 check observed two automatic snapshot resets, restored cached
read grants and both threads after a fully offline reload. Native image-cell
and CSV-record sends, draft reload and offline CSV queue/reload also passed.
Native record tests use an owner; reviewer enforcement has actual HTTP evidence.

Group protocol support decodes bounded typed values, negotiates the explicit
server capability and submits immutable capture requests to the private-source
backed endpoint. A verified group anchor contains a stable group ID and the exact
source witness used for its thread's authorization.

New group selections can now remain local as `base_group_pending` draft targets.
They retain the source generation, Yjs snapshot, typed value, definition revision
and timezone. The session can capture from cached read-side source lineage while
offline; source comment permission is not required. Public anchor parsing rejects
these local targets. Cache version 14 preserves existing data and closes older
workers that cannot safely deliver this operation type.

The ordinary outbox handles `base.group.create` in two phases: capture with its
own immutable operation ID, then persist the verified anchor under the worker's
current lease before sending a normal `thread.create`. The comment operation ID,
message body, thread ID and original selection do not change. Both lost capture
responses and lost thread responses recover through database reopen. Expired,
replaced or stopped workers cannot advance from capture to comment delivery.
Pictures retain ordinary upload dependencies. Recovery can atomically fence an
unprepared local group intent; after preparation it must withdraw the exact wire
command before replacing expired uploads. Original drafts/commands remain
available for review when current permissions or definitions reject delivery.

The composer and draft chooser retain/display pending targets through recreation.
The actual Python/Rust/Yjs fixture now creates a previously unverified offline
intent and loses both accepted responses across reopen, in addition to checking
delete-only dependencies, source denial, relay restart and historical targets.
Focused tests cover lease races, stop, storage failures, proof mismatch, dependent
replies, picture recovery and offline source-read capture. The plugin regression
suite passes 2,099 tests; preview build/main TypeScript and existing test-type
gates pass.

Native group controls are now connected to that flow on the version-gated table,
cards and list adapters. A mixed heading offers distinct typed choices. Capture
uses an existing synchronized Markdown source, checks the visible selection and
source bytes, freezes its Yjs snapshot, and resolves file/link values to managed
IDs and generations. Unresolved links retain source path evidence. Markers and
navigation match the typed group across membership/order changes, including saved
pending drafts. Ambiguous duplicate headers and changed definitions retain the
thread without guessing a target. Selection uses one inventory-count scan and
stops looking for a source after finding an available candidate.

Automated component tests and the actual Python/Rust/Yjs capture/session/delivery
fixture verify the integration. This increment still needs a native Obsidian run:
the Mac was locked when that check was attempted. The temporary native services
were stopped without installing into a vault. A source whose CRDT is not loaded
can now be read from its retained cache after source-read authorization. Cache
discovery is deferred until no live source is available; inventory identities are
counted once, and supported hosts enumerate database names once per action.
The reader uses a readonly transaction, requires initialized local/server state,
rejects incomplete history, and compares the retained text with the current file.
It does not construct a provider or use the normal cache writer/compactor. Limits
are 32 MiB total retained bytes, 8 MiB per update, 50,000 records, 2 Mi UTF-16 text,
5 seconds per storage read and 10 seconds across source discovery. Temporary
documents are disposed on success and failure; a newly opened native document
invalidates the retained source instead of letting stale cache replace its edits.
The actual Python/Rust fixture captures from a closed read-only peer cache and
verifies outbox delivery through both accepted-response losses and reopen.
Native Obsidian validation of this path remains pending.
Formula groups, remaining file properties, group summaries, source-resolution
compatibility, mobile and native acceptance also remain. Do not treat this as
release-ready group commenting.

Inventory-backed file groups now cover `name`, `basename`, `fullname`, `ext`,
`path`, `folder` and `file` across supported record types. They negotiate an
explicit property capability and capture managed identity, generation and a
share-relative path digest without loading a CRDT or reading file contents.
Path/folder values translate between each vault's mount and shared wire paths;
empty shared folder means the share root. Typed source evidence keeps file and
note intents disjoint, and cache version 15 fences older pending-intent workers
without changing existing tables. Downgrade retains pending work and disables
new file captures. The actual service fixture sends an image-file group and
recovers both accepted-response losses across outbox reopen. The full plugin
suite passes 2,141 tests. Native group/mobile acceptance and the other file
properties (timestamps, size and dependency-bearing metadata) remain unfinished.

Actual HTTP session tests cover separate views, offline restart/delivery, cache
revocation/regrant and retained drafts. Desktop Obsidian tests capture/send all
four target kinds, restore a cell draft, separate views and retain cached comments
and queued offline work. Formula cells and formula/summary definition discussions
also have native preview evidence. Groups/lanes, computed values and group summaries,
inline definitions, provisional identities, Time & Line, target-aware mention
choices, native reviewer and mobile/resource acceptance remain unfinished. See
the server's `docs/base-discussions-preview.md`, `realBaseDiscussionStack.test.ts`
and the parent workspace's `docs/Plans/obsidian-presence-comments-bases.md`.

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

## Comment inbox preview

`DiscussionInbox` and `InboxView` connect the opt-in `discussion_inbox` capability
to the native sidebar and Comment inbox command. Configured shares aggregate in
one view with unread/all/mentions/muted/dismissed filters. Opening a notification
does not mark it read. Explicit read/unread, dismiss/restore and follow/mute choices
persist offline; thread controls also allow readers to follow without a prior
notification. `DiscussionHost` resolves the managed entry through the local
inventory and preserves its original saved Bases view. Targeted thread reads
cache content without inventing an event cursor.

Cache version 16 fences older workers that cannot clear inbox references on
access loss. Per account/vault/share storage retains at most 500 notifications,
500 separately loaded preferences and 200 pending choices. Older paging starts
a new bounded window at capacity, retains its starting cursor through refresh
and restart, and offers an explicit return to latest. Expired cursors reset to
the latest authorized page. Foreground polling runs every 30 seconds, replacing
the loaded window with up to ten authorized pages; background polling stops.

One expiring IndexedDB lease serializes delivery across windows. Ambiguous writes
retain exact payloads, Retry-After survives restart, and preference conflicts
retain rejected changes for review. Dependent changes cannot bypass a rejected
preference. Read acknowledgments never advance the presented notification version
without fetching its activity reference. Epochs fence responses that arrive after
known access loss; pending choices remain while readable references are removed.

The actual HTTP/application-worker fixture verifies notification projection,
offline restart, a lost subscription acknowledgment, a later subscribed reply
and access revocation. Protocol/store/DOM/host tests cover filters, focus,
multiwindow delivery, read races, bounded paging, current-file navigation and
saved-view preservation. Native desktop/mobile acceptance is pending; the Mac was
locked at the latest attempt. The complete collaboration release remains disabled.
See the server's `docs/discussion-inbox.md` for delivery and API semantics.

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
uses the placement dialog. Direct manipulation, remaining comment-picture recovery,
image presence, arbitrary transforms, all format/EXIF
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

## Native Bases surface boundary

`../bases/NativeBasesSurface.ts` implements the private built-in table/cards/list
boundary for desktop Obsidian **1.13.7**. It is **not yet connected** to discussion
capture, inline markers or sidebar navigation. The existing explicit target
picker remains the available commenting interface. Unknown versions/layouts and
an explicit `enabled: false` return no adapter; a user-facing toggle still needs
to be wired with the host integration.

The adapter returns mounted record/property handles from native model objects,
not labels, row order or DOM text. Recycled rows, changed query results, unloaded
views, unsaved configuration and unsupported formula cells cannot be silently
reinterpreted. Loading is unavailable, distinct from a record filtered out by a
completed query. Virtual navigation uses the matched record's current layout
coordinates, verifies the mounted target, and never edits native selection or
saved configuration. Failed navigation restores scrolling while its context is
still current; background-frame waits have a bounded fallback.

`bind` checks exact local bytes against a parsed server registry, normalizes the
runtime configuration through the host's pure query parser, and verifies the
saved-view slot. The caller must supply a live authority predicate covering the
account, inventory/file identity, pending registry repairs, latest registry
revision, permissions and lifecycle. A mapping proof is not an authorization
grant. Check the returned binding and target handle again after every awaited
capture, then use the existing server capture/outbox. Do not reuse a binding
after a view switch. Callers own visible-pane subscriptions, cancellation on user
navigation/backgrounding, and refresh after query/layout changes; the adapter
itself installs no listeners, polling or persistent state.

Native evidence covers an 80-record synthetic fixture in all three layouts,
offscreen `note.rank` cells, hidden records/properties, stale layout rejection,
and binding a previously verified cached registry offline. `.base`, image and
CSV source hashes were unchanged. The disposable probe was unloaded/removed and
the test vault closed. The last exception/animation-frame cleanup guards have
automated evidence; they were added after the native run. Group collapse, broader
configurations, mobile/popouts, RTL and the complete performance/accessibility
matrix remain. See the parent workspace's Bases evidence page.

Validation: **44 focused tests**, **1,960 plugin tests** across 188 passing suites
(12 opt-in tests skipped), preview build/main TypeScript, changed-source/test lint
with no findings, and the existing test-type gate passed. The build retains 15
existing warnings; test types remain 206 errors/45 signatures within the frozen
207/46 baseline. The first sandboxed regression attempt could not bind localhost
fixtures and was stopped; the successful full run used the required socket access.

## Validation

The direct managed-image-file protocol is available independently of text-anchor
barriers through `discussion_image_files`. Its `image_file` target binds the
managed asset ID, server generation, observed hash, intrinsic basis and geometry.
Use `DiscussionSession.watch(entryId, listener, "image")` to obtain that file's
context. The existing cache/outbox preserves offline drafts, exact retries and
original version evidence; it never rewrites queued targets after lineage changes.
Read responses and queued commands must match the requested file. The native
host now opens image-file discussions from the command, file menu, sidebar or
verified file-view overlay. Whole-image/pin/region placement uses the static
dialog; target drafts persist independently of note drafts. Saved markers open
their thread, and Show image opens the actual file and its target preview.
`ImageFileOverlays` bootstraps image-scope permissions, binds only an unambiguous
exact native resource, shares bounded digest verification with embedded images,
and suppresses old coordinates after asset/lineage/basis changes. The real-service
fixture is `--image-files --plugin <this checkout>` in
the server's `tests/integration/managed_stack.py`; it verifies offline replay
with comment-only access and text barriers disabled.

Desktop Obsidian 1.13.7 evidence includes all three file geometries, a draft
restored after reload, saved overlays and target/reply navigation. A synthetic
reviewer with `{read:true, comment:true, edit:false, moderate:false}` created a
native image-file discussion after switching from the owner account. Files were
unchanged. Direct manipulation on the native image, full geometry/format and
mobile acceptance remain unfinished; creation still uses the placement dialog.

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

## Pictures in comments: desktop preview

The client now understands picture body blocks and the separately negotiated
`discussion_pictures` capability. `PictureProtocol` bounds metadata and strips
untrusted fields. `DiscussionTransport` stages immutable IDs, sends authenticated
raw bytes and verifies returned MIME/size/digest. Existing verified uploads are
reused after a lost acknowledgment. Content reads use authenticated requests;
bearer tokens never enter image URLs or diagnostics.

IndexedDB version 6 added original picture bytes and explicit draft/outbox
references. Saving a draft and its bytes is atomic. Enqueue transfers references
and inserts immutable `picture.upload` dependencies before retiring the draft.
The ordinary worker sends a message only after its pictures are verified. A
rejection preserves the original bytes and blocks only dependent work; temporary
upload failures back off uploads while ordinary comments remain runnable.
Ready ordinary comments take priority over queued uploads. There is still one
active request per worker: in-flight upload latency and native memory/battery
behavior remain part of performance acceptance.

Upload leases allow 120 seconds for staging plus upload. Other actions keep
their existing lease duration. Sources have a separate 100 MiB local quota and
are never evicted while referenced by drafts or pending/rejected actions.
Acknowledgments, including event-based acknowledgments, release references in
the same transaction; the final reference releases the bytes. Account/server/
vault/share isolation, compare-and-swap drafts and version-change closure remain.
An authorization cache purge removes remote data while preserving originals the
user has not finished sending. Explicit account cleanup includes the new stores.

The normal regression suite covers these invariants and old-schema upgrade.
For the actual HTTP/MinIO boundary, start a disposable loopback MinIO with the
synthetic credentials documented by the server harness, then run:

```sh
python tests/integration/discussions_client.py --plugin ../../../evc-team-relay-obsidian --pictures-endpoint 127.0.0.1:<test-port>
```

This runs `realPictureStack.test.ts`: offline restart, reviewer upload, lost
upload acknowledgment, private staging, authenticated content/thumbnails,
history, revocation and retained original bytes. It also exercises the session
image loader, offline cache, and picture Send and reopen against the actual API.
Its bucket, database and HTTP
process are temporary. The ordinary text-only fixture also remains supported.

The composer supports a native file picker and clipboard image files, descriptions,
removal and picture-only messages. It saves each source atomically before showing
the attachment. Format/header preflight rejects unsupported/animated/oversized
sources before local preview decoding; the server remains the full verifier.
Simple paragraph/mention messages with trailing pictures can be edited without
dropping references. Other rich or interleaved content waits for the rich editor.
Send and reopen uploads first, then locks its exact online command. A failed
upload leaves the draft editable; a lost reply acknowledgment preserves the
receipt and retries without uploading again. It never queues moderation offline.

IndexedDB version 22 adds [local storage controls](../../docs/comment-storage-preview.md)
for the separate LRU rendition cache. New databases default to 100 MiB; upgrades
preserve the former 50 MiB budget. Users can change the limit or disable/clear
download caching. It cannot evict original draft/outbox sources. Downloads always reauthorize online, validate
MIME/size/digest, and use account-local blob URLs. Only retryable network failures
allow a cached offline rendition; authorization failures purge its variants.
Scope-generation checks prevent late downloads from repopulating revoked data;
a separate cache epoch fences downloads started before an explicit cleanup.
The account-owned loader deduplicates requests and permits at most two reads,
with a bounded waiting list. The renderer loads visible pictures, frees blob
URLs/offscreen decoded pixels while reserving layout, and releases everything
on disposal/account loss. Full-size loading is explicit; an offline miss retains
the thumbnail. Cache quota failures do not prevent displaying authorized bytes.

Desktop Obsidian 1.13.7 has native evidence for picker, draft reload, picture-only
send, edit/history, Send and reopen, scrolling and offline cache reload. Clipboard
paste has automated DOM coverage; native clipboard/mobile/large-format and
resource acceptance remain. Draft/Send-and-reopen recovery is described below;
rejected dependency editing, complete storage accounting and backup/restore remain. Server
expiry/orphan cleanup has separate PostgreSQL/MinIO evidence. Keep the server
creation flag disabled outside controlled fixtures until those parts are ready.

## Saved picture-upload recovery

The pending-comment panel now offers **Refresh picture uploads and retry** when
online with picture/comment permission and the negotiated `discussion_recovery`
capability. It preserves the exact text, rich blocks, descriptions, thread/message
identity and target. This action refreshes saved local picture originals; it does
not yet edit/remove rejected attachments.

The transport first posts the exact original envelope to `/commands/withdraw`.
An accepted receipt reconciles the existing comment without another upload. If
the command has not committed, the server records a durable withdrawal under its
original receipt primary key. All late sends, including a request returning from
private anchor validation, are fenced by that receipt. A timeout or malformed
response cannot authorize a replacement. Authorization is checked on every call.

IndexedDB version **8** adds a dependency index. After confirmed withdrawal, one
transaction records the old operation as withdrawn, creates the replacement and
new upload dependencies, transfers picture references, and rewires dependent
commands that have never been attempted. Picture bodies/targets are preserved;
the new request changes only its operation ID and refreshed picture IDs. Shared
originals remain available to other drafts/pending work. The transfer reads one
source at a time, releases unused old references before checking quota for its
replacement, and rolls back entirely on storage failure. Obsolete upload jobs
cannot be revived by late responses. Competing windows converge on one replacement.

If the server withdrawal commits but the local save fails or the app stops,
original work remains in the outbox; repeating recovery obtains the same server
decision and completes the transfer. Never prune withdrawal receipts during
backup/restore or downgrade a client across an unsupported local schema.

The normal suite includes storage, cross-window, source-quota, transport,
session and DOM-control checks. The actual HTTP/MinIO fixture seeds an expired
reservation, repairs it as a comment-only reviewer, verifies one resulting
message and rejection of a late original send, then reconciles a deliberately
lost successful comment acknowledgment without another upload.

Unsent drafts offer **Refresh picture uploads**, including offline. This rotates
only retained local originals, preserves already-published pictures, text,
mentions, descriptions and the target, and creates no outbox work. A single
transaction checks the revision and absence of a pending online intent, transfers
one original at a time, and increments the draft revision. Stale preflight uploads
and competing editors cannot subsequently submit or overwrite that draft.
Shared originals remain referenced; quota or storage failure rolls back the transfer.

An unconfirmed **Send and reopen** offers **Check delivery and edit** while online
with comment permission and recovery support. It posts the exact persisted online
envelope to the same withdrawal endpoint. An accepted reply clears its draft;
confirmed withdrawal clears the intent and increments the draft revision while
retaining all content. Neither outcome resends or reopens. Unknown outcomes keep
the draft locked. A later explicit send reads the current durable intent, uses a
fresh operation/message identity when appropriate, and checks the current thread
revision. Old in-memory requests cannot revive a withdrawn action. No schema
upgrade beyond version 8 is needed, and the online action never enters the outbox.

The actual HTTP/MinIO fixture also proves an expired unsent upload, offline
refresh, a stale-state Send and reopen rejection, withdrawal and late-send
rejection, and reconciliation after a successful retry's response is lost.
Native recovery buttons and mobile acceptance remain separate checks.
