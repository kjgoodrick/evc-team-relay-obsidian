# Shared timeline marker client preview

The client now understands `timeline_marker` discussion anchors and verified
saved-view marker catalogs. This is a development foundation, not a complete
native milestone interface. Keep the server's marker creation flag disabled
outside disposable tests until the remaining interface and renderer work lands.

## Available behavior

- Strict decoding retains the marker UUID/revision, captured label/color and
  exact point/range coordinates together with the saved view and axis identity.
  Points require one closed coordinate; labels never become identities.
- `DiscussionTransport.timelineMarkers` loads bounded, revision-pinned catalog
  pages, including archived placements for historical status. Mixed revisions,
  duplicate IDs, mismatched placements and forged redundant targets are refused.
- `DiscussionSession.readTimelineMarkers` stores verified metadata in the
  existing account/server/vault/share cache, under the saved-view scope. Only
  retryable connection failures may use the last verified catalog. Denials,
  invalid responses and generation changes invalidate that proof. Store tickets
  prevent late responses from overwriting another verification or cache reset.
- `captureTimelineMarker` compares the selected revision with the verified
  catalog and current saved view/axis, with comment permission checked again after
  asynchronous work. Capture copies the selection before awaiting. An edited,
  archived, detached or rebound marker requires reselection.
- Captured anchors use the existing durable draft/outbox path. Offline restart,
  queueing, exact retries and historical reads/replies preserve the original
  target. Existing comments do not follow a marker to its new position.
- Composer/draft/thread labels identify marker targets. Thread status distinguishes
  changed or archived markers from the captured revision. The saved-view toolbar
  opens a Shared markers picker with explicit marker selection, refresh, position
  inspection and comment capture. Refresh retains an exact selected revision;
  an edit/archive/detachment clears the selection for explicit review. Read-only
  members can inspect positions without gaining comment permission.
- Existing marker discussions project onto their captured coordinates using the
  verified axis. Their overlays identify the captured label and preserve marker
  identity/revision, separately from ordinary ranges. Opening a thread or its
  captured position rechecks saved-view/axis authority. Navigation reuses the
  provider's guarded range reveal and temporary focus; dirty inspector changes
  stop navigation. Changed axes retain the discussion without guessed placement.
- Projection uses cached discussion data and performs no network work on scroll.
  Cancellation, closing, account/access changes and async completion are guarded;
  the picker releases its host reference and loaded metadata on close.
- Cache version 19 preserves all stores and fences older workers that cannot
  decode marker targets. Revocation clears cached marker metadata while retaining
  unsent local work for recovery.

Marker creation requires both the target kind and feature flag in capabilities.
Existing anchors remain decodable when creation is disabled. An inactive
placement may retain an old axis incompatible with the marker's latest content;
its metadata remains readable but cannot become a new comment target.

## Online management

The session also exposes explicit online marker-management commands. Before a
write, the client durably saves its exact operation, content, expected revisions
and complete placement set. One pending operation per managed base prevents a
second local promotion while the first result is unknown. Windows share that
slot through compare-and-swap; accounts, servers, shares and vaults remain
isolated. This is not background offline management.

Timeouts, malformed success responses, authorization loss and feature disablement
retain the original intent for explicit retry. Confirmed receipts validate the
operation, lineage, counter advances, content and active placements. A late
failure cannot overwrite a confirmed receipt. Terminal revision conflicts remain
visible until acknowledged; a generation conflict means this intent cannot
apply to the current generation, not proof that it never succeeded in an older
generation. Pending intents cannot be dismissed.

The saved-view toolbar now exposes **Manage markers**, independently of the
creation flag so an editor can recover a previous request after feature
disablement. The dialog lists active, detached and archived associations in the
current saved view. Editors create point/range markers, edit label/color/position,
review every retained view placement, explicitly detach placements, archive across
all views, and restore in selected views. Updating one view preserves the other
selected placements. Older axes require explicit review/rebinding in their view;
the dialog does not silently reinterpret coordinates. Duplicate view names retain
an ID suffix. New associations outside the current/retained views still need the
base-wide placement/matching workflow.

Position editing reuses the exact coordinate form and, for ranges, the actual
renderer endpoint-selection workflow. Returning to the management form does not
save metadata until the editor chooses Save. Point positions use one explicitly
entered coordinate; direct point picking on the renderer remains work. Closing
the host cancels the child selection and guards late reads. Read-only/offline
members can inspect retained results without gaining management permission.

Unconfirmed results offer Retry original save and a selectable copy of the saved
request/result. Confirmed saves offer Load current marker. Conflicting attempts
retain their values until explicit review/acknowledgement; another window's
recovery update cannot be lost behind an older local read. Unreadable recovery
data blocks a replacement save. Broader repair/export and account-wide access to
results after the original view becomes unavailable remain work.

## Verification

The management interface passes **2,478 plugin tests in 206 suites**, preview
build/main types, changed-source lint (five existing warnings), whitespace checks
and the frozen test-type gate (206 existing errors/45 signatures versus baseline
207/46). The build retains 15 existing Svelte warnings. Twelve focused UI cases
cover creation, preserving all active placements, point entry, renderer range
selection, archive/restore, axis review, uncertain/rejected results, access loss,
close/reopen, late callbacks and cross-window state reads.

All eight source interoperability cases exercise the actual management form
through the Time & Line range-selection bridge for both renderers/load orders
and grouped/ungrouped views. The six actual HTTP tests additionally prove that
an unavailable placement is a terminal conflict, its acknowledgement permits a
valid restore, and no partial command consumed the marker/catalog revision.
The Mac was checked and was locked, so no native acceptance is claimed.

Focused tests exercise malformed/cross-scope catalogs, pagination and revision
changes, point precision, offline reopen, account isolation, archive/detach/edit
and axis changes, authoritative denial, read-only access and late-response fencing.

The control-plane `tests/integration/base_content_client.py` fixture now runs
`realTimelineMarkerStack.test.ts` against disposable loopback HTTP and SQLite.
It uses the actual transport/session/store/delivery/outbox, synthetic owner and
commenter accounts, and both Timeline/calendar and Sequence/exact-decimal targets.
It verifies offline capture after reopening, draft consumption, a lost accepted
response, another cache reopen, metadata edit/archive before exact retry,
historical replies and stale new-capture rejection. The `.base` state is unchanged
by marker metadata and comments. This is not native Obsidian or server-restart
acceptance; the separate server PostgreSQL tests cover transaction serialization.

The same HTTP fixture now loses an accepted editor marker-save response, reopens
the owner's cache, changes and archives the marker from another device, then
retries the retained operation. The original revision-one receipt is recovered
byte-for-byte in request intent while a fresh detail read reports archived
revision three. Both Calendar and exact-decimal Sequence pass. The six actual
HTTP tests pass and their disposable server/database are removed. Twenty-four
focused management tests cover strict decoding, access gates, isolation, restart,
cross-window races, uncertain failures and explicit acknowledgement.

The management increment passes **2,463 plugin tests in 205 suites**, preview
build/main types, changed-source lint and whitespace checks. The frozen test-type
gate reports no new errors (206 errors/45 signatures versus the existing
207/46 baseline); it is not a clean full test-type check. The build retains its
15 existing Svelte warnings. No management UI or new native acceptance is claimed.

The interface increment passes **2,439 plugin tests in 204 suites**, the preview
build/main types, changed-source lint (five existing warnings), whitespace and
the frozen test-type gate. Eight interoperability cases bundle both plugins'
actual source under the synthetic Obsidian host, in both load orders and with/
without lanes. They exercise the real picker, point-marker geometry, selected
position reveal, and captured-discussion controls for Timeline and Sequence.
Focused tests also cover refresh/cancellation, read-only access, distinct marker
revisions, exact host capture and dirty inspectors at every navigation stage.
The native availability check encountered a locked Mac; this is not native
desktop/mobile or physical keyboard/touch acceptance.

## Remaining work

Current-marker overlays independent of discussion presence, side-by-side
current-versus-captured position UI, automatic metadata refresh/change delivery,
base-wide placement/matching, local marker promotion, direct point picking and
broader recovery controls remain. The picker provides explicit refresh; it does not yet subscribe to live
metadata changes. Overlapping overlay polish also remains. The Time & Line fork
has not changed in this increment. Native desktop/mobile, accessibility, recovery
UI and resource acceptance remain before enabling this feature for users.
