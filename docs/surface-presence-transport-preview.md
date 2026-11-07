# Image and Bases presence transport preview

The client transport supports the server's optional version-two location and
surface-roster protocol. The foreground `LocationHost` now opts in and connects
directly opened managed image files to the existing participant controls and
Jump/Follow. Notes, images and verified saved Bases views reuse one socket per
foreground host/account. Bases participants and whole-view Jump/Follow are connected.
Direct-image pointer overlays and position-aware Jump/Follow are also connected.
Embedded-image capture, overlays and Jump/Follow are connected in the foreground
note as well. These have automated host evidence; native image acceptance,
visible split-pane image observation and group/lane/range presence remain unfinished.
Precise cell/record/header capture, overlays and Jump/Follow are now connected
through the native Bases and Time & Line adapters, with automated host evidence.

## Transport contract

`LocationChannel` accepts `surfaceLocations: true` for a host that understands
`SurfaceLocation`. It checks the server's separate extended-location and roster
capabilities, authenticates the existing socket with version two, and verifies
the returned version. Ticket format and credential renewal stay compatible.
Without mutual support, note presence continues; non-note publication becomes
null and non-note Follow/watch commands are withheld. No fake note document or
second location socket is created for an image or `.base` file.

Exact location shapes are defined in
[`LocationProtocol.ts`](../src/collaboration/presence/LocationProtocol.ts):

- Notes keep the existing share/entry and editor/Reading descriptor.
- Managed image files additionally identify the current generation and SHA-256.
- Bases additionally identify the current generation, definition, saved view and
  registry revision. A view rename/reassociation must use freshly verified
  metadata; a display name or DOM index is not identity.

The parser copies and freezes these descriptors. It rejects arbitrary fields,
external URLs, computed results and not-yet-supported subtargets. Image movement
uses a separate typed message rather than changing the room descriptor.
Revisions must be positive safe integers. Embedded-image occurrences now have
a separate typed transport and source-anchor foundation below. Fine-grained
Bases cells/records/headers now have a separate typed stream and record-specific
authorization below. Groups/lanes/ranges remain.

## Read-only saved-view context

`presence_base_context_preview` negotiates `readBaseContext(shareId, entryId)`.
The new `/base-context` endpoint returns the existing definition/generation,
registry revision, synchronized content hash and at most 64 active saved views
(ID, slot, name and type). It requires a current normal session and read access;
it does not require comment permission or an open discussion sidebar. Presence
and the Bases registry must both be enabled. No registry is initialized or
repaired, no file is written, and no object-store content is fetched. A missing
or stale registry remains unavailable until the normal Bases workflow updates it.

One SQL statement reads active identities and their revision together. Archived
and unmatched views, filters, formulas and record values are omitted. Sparse
slots are preserved. The client copies/freezes the bounded response, verifies
the requested share/entry and rejects malformed, duplicated or unordered views.
Only this context response has a 192 KiB HTTP budget to accommodate 64 Unicode
view labels; small control responses keep their existing limit. Disconnect or
account/channel replacement discards late lookup responses.

`NativeBasesSurface.bindPresence` verifies exact disk bytes, current saved runtime
configuration and every returned view slot before assigning a saved-view identity.
It is independent of discussion sessions and comment capabilities. Source,
file-stat, ownership or permission changes invalidate the binding. Guarded view
activation uses the existing transient native selection method; it requires this
surface's original binding and respects the integration's navigation guard.
These adapter methods have automated evidence, including delayed permission loss
and unchanged saved configuration. Fine-grained movement and native desktop/mobile
acceptance still remain.

## Saved-view host and navigation

`BasePresenceSurface` binds the foreground `.base` view through that read-only
context, current authorized inventory and the existing native/Time & Line adapters.
It requires the saved native configuration and exact synchronized bytes. A reader
can publish or observe without comment/edit permission. The existing participant
controls show only the exact saved-view roster. Privacy hides publication while
preserving authorized observation; denial clears participants and ends Follow.

The active file's metadata/source reads are reused across result repainting and
saved-view changes. Repeated rejection does not poll. Explicit retry, a changed
file or a new registry revision causes bounded fresh verification. Late results
cannot restore a replaced, logged-out or disconnected context. Source/stat/hash
changes immediately invalidate local proof. A 50 ms DOM check ignores owned UI
layers, and closing the surface clears its timer/listeners and timeline bridge.
This reuses the existing 256 KiB native Base limit; no second document/socket or
whole-vault presence index is created.

Follow crosses notes, images and saved views on the same foreground socket. It
uses transient native view selection without saving filters/layout/configuration,
respects timeline navigation locks, and does not reopen an already open Base to
switch its view. A pending native selection is not repeated during result repainting.
Newer destinations supersede an in-flight file open; cancellation permits a fresh
action. An incompatible generation/revision is re-read once before rejection.
Reconnect refreshes observation but never restarts Follow automatically.

Whole saved-view navigation remains available when no precise position is
published. Cell/record/header positions are now connected as described below;
group/lane/range targets remain unfinished.
Automated tests exercise the real native adapter against simulated host objects
and the actual `TimelineBridgeClient` contract. They cover read-only/hidden
observation, table/card and timeline view changes, denial/retry, source changes,
late responses, navigation locks, note→Base→image→note transitions and unload.
These are not native Obsidian desktop/mobile or performance acceptance results.

## Direct image binding

`ImagePresenceSurface` requires exactly one loaded native image with the current
vault resource URL. It compares fresh session-authorized `/image-location`
metadata with synchronized inventory and a digest of the rendered file. The
new `presence_image_context_preview` capability is required. This works with
read permission independently of discussion capabilities or an open sidebar.

The binding reuses `ImageAssets`' digest cache, two-read concurrency bound and
64 MiB verification limit. It does not decode a second image, upload bytes, or
hash on repaint. A changed file revision invalidates evidence. Missing/ambiguous
images wait; failed verification remains unavailable until retry or a context
change. Source changes, late callbacks, account changes and unload cannot restore
stale participants. Large files currently remain unavailable for this presence
binding; native resource measurements and the large-file path remain release work.

Participants appear as viewing the image. When current geometry is available,
Jump uses the remote pointer (or viewport center), and Follow uses the remote
viewport center (or pointer). It does not change local zoom or selection. Without
geometry the existing whole-image navigation remains available. Follow can start
there or cross from a shared note, and can
continue into an authorized note on the same pane/socket. User interaction,
navigation, backgrounding and access loss interrupt Follow. Hiding one's own
presence preserves authorized observation. No discussion session is created.

## Pointer and viewport movement

`presence_image_states_preview` enables image-only `watch` requests with
`image_states: true`, plus `publishImageState({pointer, viewport})`. Coordinates
are finite normalized fractions of the orientation-corrected intrinsic image;
the pointer is `{x,y}` or null and the viewport is `{x,y,width,height}` or null.
Zero-area/out-of-bounds viewports, extra identity fields and malformed numbers
reject. Publication must match the visible image generation/hash exactly.

The native binding maps actual object-fit, object-position, axis-aligned scale,
scroll and clipping. It publishes only visible geometry; letterbox padding is
not part of the image. Rotation/reflection/perspective remain unsupported and
withdraw coordinates rather than placing a guessed pointer. Pointers have
authenticated names and stable user colors. Their noninteractive overlay is
clipped and excluded from accessibility announcements; the normal participant
controls remain accessible. Pointer exit/cancel and touch release clear the
pointer; scrolling clears a stationary pointer and updates the viewport.

Capture is coalesced to 125 ms; transport sends at most eight ordinary movement
updates per second with immediate clearing. The server batches movement for
16 ms and holds only the latest state. Movement does not change membership
revision, refetch the roster or rebuild participant controls. Separate bounded
`image_states` snapshots contain only authorized identity tuples and geometry;
names come from the roster. A viewer's updates and the publisher's read access
are checked on each delivery. Snapshot guards cover delayed socket writes.

Scope/privacy changes, revocation, disconnect and unload clear geometry. Cached
movement is not replayed on reconnect. Neither coordinates nor viewports are
written to the outbox or database. Existing single-process/capacity limits apply;
these bounds are not a measured mobile/battery or production-load result.

## Observation and privacy

`watch(scope)` observes one image or saved view. `publish(location)` independently
controls visibility, so `publish(null)` may be combined with a watch. The roster
callback receives `{scope, status, peers}`; each peer contains an authenticated
display name and the user/public-session/instance tuple used by Follow.

The client clears peers on scope change, unwatch, connection loss and shutdown.
Reconnecting refreshes the desired watch with a new subscription ID, but never
restarts Follow. A server denial ends observation until the scope changes or the
user explicitly retries. Old socket/subscription events cannot restore stale
participants. Account/session replacement continues to require a new channel.

Roster frames allow at most 127 distinct identities, names of at most 255 code
points and 192 KiB of UTF-8. Duplicate identities, control characters, unknown
fields and invalid targets reject. Other messages retain the 4 KiB limit. No
presence state is written to the cache or outbox. Rendering consumers must use
text nodes and continue to enforce local surface/account ownership.

## Validation

The full plugin suite passes **2,689 tests in 217 suites**; 17 opt-in tests in 16
suites are skipped in that default run. Preview build/main types and changed
source/test lint pass. The build retains 15 existing Svelte warnings. The frozen
test-type gate passes with 206 known errors/45 signatures, below its 207/46
baseline; this is not a claim of zero test type errors.

The saved-view host increment changes no server implementation or wire schema;
the server and actual HTTP/WebSocket evidence below is retained from the preceding
context/transport checkpoint, rather than claimed as a new run.

The actual client/server runner passes seven tests in six suites, including
`realSurfaceLocationStack.test.ts`. It uses real loopback HTTP/WebSockets with
synthetic accounts in a separate share and disposable SQLite metadata. It proves
image roster discovery, hidden observation, image-to-Bases Follow, saved-view
separation, same-socket renewal, reconnect, no automatic Follow restart, idle
read revocation and socket cleanup. It also reads current image context using
the read-only reviewer's session and rejects that read after revocation.
The service/database are removed afterward.
The fixture also verifies the negotiated read-only Bases context through the
actual client transport and checks that its active view IDs reconstruct the
server's exact saved-view locations.
The fixture also delivers actual image pointer/viewport updates without roster
churn, clears them on surface departure and denies them after read revocation.
The broader runner also retains the existing Bases/discussion recovery checks.

The server regression set passes 265 tests across location, managed-awareness
protocol, collaboration-policy and Bases-registry suites. Controlled async tests
cover authorization becoming stale while waiting for the shared socket writer,
1,000 pending membership changes and an old denial completing after a new watch.
Host fixtures additionally cover verified image controls, hidden observation,
note→image→note Follow, unchanged local note selections, replacement, explicit
retry and delayed responses after logout. Binding fixtures cover unloaded and
ambiguous images, replacement during verification, synchronous/asynchronous
failure and unload. These use mocked native image layout and are not native tests.
Geometry/host fixtures cover letterboxing, off-center crops, pointer departure,
hidden observation, exact scroll positions for Jump/Follow, unchanged zoom,
unsafe transforms, malformed state, late subscriptions and cancellation. Server
tests cover geometry validation, legacy watchers, read-only publishers, changed
context during socket waits and 1,001 coalesced movements without roster work.
Bases-context cases verify read access without discussions, a single coherent
identity query, no database writes, sparse/archived views, registry/hash/generation
changes, revocation, malformed metadata, feature gates and normal-session-only
credentials. Native binding cases verify unchanged saved configuration and
rejection of late or mismatched source/account/view proofs.

## Required next work

Extend whole-view Bases/timeline presence with typed semantic positions.
Complete transformed-image and large-file coverage. Add precise Jump/Follow for cell, row,
header, group, lane and timeline targets. Preserve a single foreground publisher
and local interaction interruption across all surfaces and popouts. Separate
high-frequency movement from membership snapshots and measure its authorization,
rendering and battery costs. Native desktop/mobile, touch, accessibility and
resource acceptance remain required. The server preview still needs one
designated application process; no live-vault installation or deployment occurred.


## Embedded-image transport and exact source anchors

`presence_embedded_images_preview` enables `publishEmbeddedImage` and
`watchEmbeds` on the same version-two socket. A note embed and a direct-image/
Bases watch are mutually exclusive on that connection. Hidden users can observe.
The parser freezes bounded relative source positions, source SHA-256, exact
managed asset generation/hash or external URL hash with unknown version evidence,
intrinsic dimensions and normalized geometry. No URL, source text, path or
untrusted display identity is sent. Authenticated user/session/instance tuples
will join movement to the existing note-awareness identity, without another roster.

This separate channel is necessary because a note reader may lack access to its
image. The server checks both participants against both entries and omits all
image metadata for a denied asset. Note access denial ends the observation;
image denial leaves the readable note watch available. Source/asset changes fence
pending authorization; geometry-only changes coalesce without starving it.
The transport retains the latest movement, clears on privacy/context changes,
and never replays a previous pointer after reconnect.

`EmbeddedImageAnchors` parses the current Y.Text once per source revision and
reuses up to 128 syntax-hash promises. It captures exact relative source intervals
and resolves only a complete, forward image occurrence with the matching syntax
hash. Tests with real Yjs documents verify repeated images and remote edits;
deleted/replaced occurrences, stale asynchronous hashes and closed bindings fail
without guessing another image. Asset and renderer verification remain separate
requirements. `NotePresenceSurfaces.imageTargets` exposes the already verified
CodeMirror/Reading mapping and rejects stale or ambiguous sections.

The foreground `LocationHost` now opts into this stream when the server supports
it and the active note has a current, authorized shared-text binding. The real
HTTP/WebSocket fixture covers transport across editor/Reading descriptors,
transitions back to directly opened images, explicit clearing and asset-denied
observation. Native host behavior is covered separately by the tests below.


## Embedded-image host and navigation

`EmbeddedImageSurface` joins movement with authenticated note awareness by the
complete user/public-session/instance tuple. It resolves the exact source
occurrence, checks the locally authorized asset against fresh image-context
metadata, and verifies existing rendered bytes through `ImageAssets`. Remote
geometry also requires matching intrinsic dimensions. External images reuse the
native renderer's exact URL and advertise only its hash with unknown version
evidence. No second image decode, attachment upload, discussion permission or
extra socket is needed.

Only a hovered/touched image or an image with remote participants acquires an
overlay. Metadata, source hashes and file digests are bounded/reused. Geometry
updates reuse existing image mappings; they do not reread file bytes or rebuild
the participant list. Reading/comment/presence UI mutations are excluded from
source observation, preventing one overlay from repeatedly invalidating another.
Multiple image overlays share ownership of their positioning root.

Pointer motion is normalized through the existing crop/scale/clipping adapter.
Departure, touch release, scroll, source/render changes, privacy changes and
loss of the current source binding clear local image publication. Hidden users
can still observe. Connection loss, backgrounding, account/context changes and
unload clear overlays and fence pending verification. Failed image/metadata
checks expose the existing Retry control and do not poll on ordinary movement.
Retry refreshes observation without reviving an old pointer or restarting Follow.

Jump uses the image pointer; Follow prefers its viewport when supplied. Both
preserve local selection, zoom and editing/Reading mode. Offscreen navigation
first reveals the exact source occurrence, then waits briefly for the native
image to materialize before applying coordinates. Source mode retains exact
Markdown-occurrence navigation. Cancelled navigation/unload releases these waits.

Automated evidence includes a real CodeMirror replacement widget (the Live
Preview mapping), Reading postprocessor sections, two repeated embeds, managed
and external images, Source-mode fallback, image-aware Jump/Follow, touch-release
clearing, hidden observation, access denial, explicit retry and reconnect without
replay. The host/geometry tests simulate native layout; they are **not** an
Obsidian desktop/mobile acceptance run. Native pointer/touch/crop/zoom behavior,
visible split panes, full syntax/format/large-file support and resource/latency
measurements remain required. The latest computer-use check found the Mac locked.

## Bases cell, record and header position stream

The transport negotiates `presence_base_states_preview` independently, requiring
version-two surface locations, roster and read-only Base context support.
`BasePositionProtocol.ts` strictly validates and freezes `BasePresenceState`:
`{version: 1, pointer, viewport}`, with each position null or `{target, offset}`.
`offset` is a normalized `{x,y}` within a locally verified target. Record items
and cells carry record ID/generation; cells and property headers carry namespace
and name. Names are bounded to 128 code points/256 UTF-8 bytes. Extra values,
paths, client names, malformed geometry, unsupported targets and duplicate peer
identities reject. Formula names carry no evaluated results.

`readBaseRecordContext(shareId, entryId)` uses normal session credentials and a
read-only lookup of current record lineage/type, independent of discussions.
It does not create missing IDs, and late results after stop/reconnect are fenced.
The native capture host bounds/reuses these reads and verifies local record
bindings rather than requesting metadata for every pointer movement.

`publishBaseState(state)` uses the existing location socket and movement timer.
It sends only after the exact visible Base publication, coalesces ordinary
movement to 125 ms, clears immediately and drops stale state across surface
changes, hiding, disconnect or unload. Reconnect does not replay positions.
A host providing `baseStates` receives separate `{scope, status, peers}` events;
its Base watches request `base_states: true`. Geometry does not call the roster
callback. Stale subscriptions cannot repopulate another saved view. A target's
identity is the authenticated roster tuple, not anything supplied in its state.

The server separately checks both parties' access to the Base and referenced
records. A denied record suppresses all precise-state metadata while preserving
an otherwise authorized saved-view roster. Changed target/generation/property
invalidates delayed permission results and socket writes; offset-only movement
coalesces without starving authorization. Actual HTTP/WebSocket checks cover
cell delivery, explicit/hidden clearing and idle record revocation while the
Base remains observable. Unit checks cover Unicode bounds, malformed frames,
capability negotiation, coalescing, stale callbacks and reconnect cleanup.

`BasePresenceSurface` now connects this stream to native capture, overlays and
Jump/Follow. Group/lane/range schemas, native desktop/mobile acceptance and
performance/battery measurements remain part of the full feature scope.

## Precise native Bases host

`BasePresenceMotion` uses current native record/cell/property handles; display
labels, DOM order and row numbers never identify a record. Capture coalesces
pointer/touch events and a semantic viewport point. Only nearby viewport
candidates need ancestor-style checks, and only visible remote targets render.
The receiver joins positions to authenticated roster names/colors, proves current
local record access and matching generation, then clips the pointer to the
actual target and scrolling ancestors. Rotated/reflected/perspective geometry,
recycled rows, ambiguous repeated targets and unavailable properties do not
receive guessed coordinates. Overlays are noninteractive and aria-hidden; the
participant controls retain navigation and accessible labels.

`BasePresenceRecords` permits two metadata requests at once, retains at most 256
entries and prioritizes explicit navigation over queued background lookups.
Repaints and saved-view switches reuse verified lineage; denied lookups do not
poll. Explicit retry, changed local identities or a newly advertised generation
allow fresh checks. Generation mismatch refreshes are bounded. Account/access
changes, stale responses, eviction and close release pending waiters and cannot
restore old state. Geometry never reads note contents or attachment bytes.

Jump uses the pointer target; Follow prefers the viewport target. Navigation
waits for current lineage, uses the native adapter to materialize offscreen
cells, and centers the verified point through nested scrollers. It changes
neither selection nor saved configuration and respects Time & Line navigation
locks. Manual cancellation and unload release pending frame/metadata navigation.
A newer Follow target cancels the old wait and can proceed immediately, without
waiting for an unrelated HTTP response. Pointer departure, touch release, scroll,
privacy changes and lost bindings withdraw local coordinates. Hidden readers
continue observing authorized positions.

Automated evidence covers the real native adapter with simulated table/cards/list
layout; the real `TimelineBridgeClient` with simulated Timeline/Sequence SVG
handles; foreground publication/identity joining/overlays/Jump/Follow; virtualized
navigation, nested scrolling, revocation, stale generations, delayed responses,
recycled/duplicate targets, coalescing, bounded requests, hidden observation and
cleanup. This is **not native Obsidian desktop/mobile acceptance**. Group/lane/
range targets, broader keyboard/accessibility behavior, repeated-target context,
physical touch and resource/latency measurements remain required.

## Extended Bases targets (transport preview, November 7)

`presence_base_targets_v2_preview` independently negotiates group and timeline-range
positions. A Bases watch requests `base_target_version: 2` alongside
`base_states: true`. Publishers use a version-two state with the existing pointer
and viewport slots. Missing capability or watch version retains version one:
unsupported positions become null, while cell/record/header positions remain.
State is cleared on disconnect and is never replayed. This checkpoint implements
transport and authorization; native capture, overlays and Jump/Follow for these
new targets are still pending. The existing native cell/record/header path is
unchanged; it does not guess a record position for a group or range.

A group target contains `type: "group"`, its grouping `property`, a selected
`record_id`/`record_generation`, `value_sha256`, and up to eight additional
`references` with record identity/generation. Both users must currently read every
referenced input. The grouping must match the current saved view. The initial
adapters permit note properties and inventory-backed file properties (name,
basename, fullname, extension, path, folder, file); formula and dependency-bearing
file groups require the remaining computed-input authorization work. Labels,
values, local paths, formulas and result sets are absent from the message.

The hash is a matching hint, not a server attestation of membership. Native wiring
must derive it from a canonical typed value using managed identities, check that
the selected authorized record is a current member, and refuse ambiguous matches.
The planned digest is SHA-256 of UTF-8 canonical JSON for
`[1, share_id, entry_id, generation, definition_id, view_id, registry_revision,
property.source, property.name, value]`; `value` uses the existing BaseGroupValue
codec, sorted object keys, normalized negative zero and managed link identities.
Inventory paths must be canonical share paths, never local mount prefixes.
References must include every linked input, sorted by ID, excluding the selected
member; unsupported or over-budget values must not silently drop dependencies.
The digest does not make low-entropy values secret, so record authorization is
required even though labels and values are omitted.

`timeline_range` carries the existing typed `axis` and `range` codecs, plus a
nullable group `lane`. Calendar, instant, historical and ordinal coordinates
retain their timezone/precision semantics. Server checks compare the saved axis
without evaluating formulas. A lane must pass the same group checks. Range or
lane changes invalidate pending authorization/navigation; offsets alone remain
replaceable movement. A null lane means an explicitly view-wide range.

Each canonical state is bounded to 3,072 UTF-8 bytes inside the existing 4 KiB
input frame. Version-two Bases snapshots alone allow 512 KiB for at most 127
peers; legacy snapshots and other streams retain 192 KiB. Nested targets are
copied and frozen. Existing rate limits, movement coalescing and bounded sockets
apply; no extra socket, durable row or comment permission is introduced.

Validation includes strict codecs, negotiation/downgrade, reconnect clearing,
linked-input revocation, changed axis/grouping, pending-send fencing and full-room
snapshot bounds. The actual Python service/TypeScript client fixture exchanges a
group and lane range without roster churn. These are automated transport checks,
not native desktop/mobile acceptance.
