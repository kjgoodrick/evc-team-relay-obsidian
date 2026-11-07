# Image and Bases presence transport preview

The client transport supports the server's optional version-two location and
surface-roster protocol. The foreground `LocationHost` now opts in and connects
directly opened managed image files to the existing participant controls and
Jump/Follow. Notes and images reuse one socket per foreground host/account.
Direct-image pointer overlays and position-aware Jump/Follow are also connected.
This has automated host evidence; native image acceptance, embedded-image presence
and Bases/timeline bindings remain unfinished.

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
Revisions must be positive safe integers. Embedded-image occurrence and
fine-grained Bases/timeline state still need typed extensions and authorization.

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

The full plugin suite passes **2,582 tests in 212 suites**; 17 opt-in tests in 16
suites are skipped in that default run. Preview build/main types and changed
source/test lint pass. The build retains 15 existing Svelte warnings. The frozen
test-type gate passes with 206 known errors/45 signatures, below its 207/46
baseline; this is not a claim of zero test type errors.

The actual client/server runner passes seven tests in six suites, including
`realSurfaceLocationStack.test.ts`. It uses real loopback HTTP/WebSockets with
synthetic accounts in a separate share and disposable SQLite metadata. It proves
image roster discovery, hidden observation, image-to-Bases Follow, saved-view
separation, same-socket renewal, reconnect, no automatic Follow restart, idle
read revocation and socket cleanup. It also reads current image context using
the read-only reviewer's session and rejects that read after revocation.
The service/database are removed afterward.
The fixture also delivers actual image pointer/viewport updates without roster
churn, clears them on surface departure and denies them after read revocation.
The broader runner also retains the existing Bases/discussion recovery checks.

The server regression set passes 211 tests across location, managed-awareness
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

## Required next work

Connect Bases/timeline bindings to this transport, including permission/version
refresh independent of whether discussions are open. Extend image presence to
embeds. Complete transformed-image and large-file coverage. Add semantic Jump/Follow and typed cell, row,
header, group, lane and timeline targets. Preserve a single foreground publisher
and local interaction interruption across all surfaces and popouts. Separate
high-frequency movement from membership snapshots and measure its authorization,
rendering and battery costs. Native desktop/mobile, touch, accessibility and
resource acceptance remain required. The server preview still needs one
designated application process; no live-vault installation or deployment occurred.
