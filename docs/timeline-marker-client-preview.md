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
- Active shared definitions now render without a discussion. Solid marker lines
  and labels are separate from captured-discussion highlights/badges. Nearby
  labels share bounded choosers without merging marker IDs or revisions; all
  visible markers remain selectable even in dense clusters. Labels reserve the
  native scrollbar and use 44-pixel controls on mobile. The sidebar/picker remains
  available when a viewport is too small or its combined label budget is full.
- Active discussion refreshes opt into a small `timeline_markers` revision hint.
  Unchanged verified axis/catalog data is reused; a newer catalog revision fetches
  current marker metadata without re-reading an unchanged axis. Existing comment
  polling provides the five-second fallback, with no additional timer. Successful
  local management wakes active saved views of the same base. Legacy servers omit
  the hint and use a 15-second cache window on the existing refresh cycle.
- Hints contain no marker labels or coordinates and cannot authorize an anchor.
  Normal scope/generation/revision verification still gates catalog reads, cache
  reset fences late results, and access is rechecked after asynchronous work.
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
disablement. The dialog lists active and archived markers across the base and
loads a selected marker's retained placements. Editors create point/range markers, edit label/color/position,
review every retained view placement, explicitly detach placements, archive across
all views, and restore in selected views. Updating one view preserves the other
selected placements. Older axes require explicit review/rebinding in their view;
the dialog does not silently reinterpret coordinates. Duplicate view names retain
an ID suffix. Additional saved views can now be checked and explicitly added;
local marker promotion/matching remains separate work.

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

The current-overlay/refresh increment passes **2,491 plugin tests in 206 suites**,
preview build/main types, changed-source lint (three existing warnings), whitespace
and the frozen test-type gate (206 known errors/45 signatures versus baseline
207/46). Eight source interoperability cases render current shared markers using
both actual providers/load orders and grouped/ungrouped views. All six actual
HTTP tests pass, including revision-hint delivery and unchanged-catalog reuse in
the real session. Focused checks cover no-thread panes, no reads on scroll, dense
256-marker identity retention, stale/archived/detached rejection, legacy refresh,
late sync callbacks, cache resets and access loss during the final async fence.

The companion server passes 549 tests across the 13 collaboration modules,
including 18 marker cases. Native availability was checked and the Mac was locked;
no native layout, physical-touch, desktop/mobile or performance acceptance is
claimed. The build retains its 15 existing Svelte warnings. No vault installation
or production deployment occurred.

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

## Captured-versus-current comparison

The discussion card now offers **Compare marker positions** to readers, including
members without comment or edit permission. The dialog shows the immutable
captured target beside the latest checked marker: label, color, shape, exact
coordinates, range inclusivity, axis properties and marker revision. It identifies
changed fields, archived markers and detached placements. Its columns stack in
narrow windows and controls retain mobile-sized touch targets.

**Show captured position** and **Show checked position** use the guarded saved-view
navigation path. Neither updates the discussion target, marker metadata or note.
An archived/detached marker has no current-position navigation. Cached catalogs
are explicitly labeled; absence from a cache does not claim the marker was
deleted. Point labels show a single coordinate rather than repeating a range.

Comparison is an explicit, bounded read with no polling timer. Refresh rechecks
the discussion and catalog, then rereads the cached thread before showing the
result. Closing, access/authentication changes, generation changes, retargeting
and disposed sidebar cards clear the dialog or reject late results. Repeated
refreshes share the pending read; prior navigation callbacks become invalid.
Catalog lineage and registry revisions must match the captured saved view.

November 7 validation: **3,133 tests in 247 suites pass**, with 22 opt-in tests in
17 suites skipped. The 150-test focused set, build/main types, frozen test-type
gate and changed-source lint pass. Eighteen comparison cases cover changed and
unchanged content, archived/detached status, fresh versus cached absence, access
loss, late completion, lineage mismatches and exact decimal/historical payloads;
the sidebar integration case verifies reader access and closure on retargeting.

All eight source interoperability cases now open this actual dialog and navigate
both positions through the actual Timeline/Sequence providers, in both plugin
load orders and grouped/ungrouped views. Note writes remain empty. The companion
HTTP fixture passes seven tests in six suites, exercising real authorization,
catalogs, immutable anchors, offline recovery and surface presence. That fixture
does not render this dialog. The Time & Line checkout remains unchanged at
`6eedff2`. Logs use `/private/tmp/marker-comparison-*.log`.

Native desktop comparison evidence follows below. Popout/mobile, physical touch
and broader accessibility acceptance remain. No live vault or production service
was changed.

## Base-wide marker placement

Manage markers now uses the existing base-wide catalog endpoint. It fetches
summaries in revision-pinned pages of 50, with at most six pages and 256 markers.
It never returns a partial inventory across a revision change. Full placement
details are fetched only for the selected marker; no per-marker or per-view eager
fan-out is introduced. No new server protocol, schema or background polling is
required.

An editor can select a marker created in another saved view, retain its existing
placements, and add the current or another Timeline/Sequence view. **Check selected
view** reads only that view's saved axis at the reviewed registry revision. The
form displays its properties and time zone, then requires **Add checked placement**
or **Use checked axis for this placement** before changing the form. **Save marker**
remains a separate final action. Coordinates are never converted to fit another
axis; incompatible coordinate types/time zones are rejected. Unmatched views and
non-timeline renderers are excluded from the chooser. Existing inactive placements
remain available for explicit review and restore.

Online management reads reject late results across authentication recovery,
generation changes and access loss. Closing releases the modal listener and
invalidates pending checks. Recovery updates and offline/editor permission loss
prevent a late check from adding a placement. Existing immutable save intent,
revision checks and exact retries apply to the complete selected placement set.
Keyboard focus moves to the explicit placement confirmation and then Save.

November 7 verification: the focused protocol/session/management set passes 108
tests. Build/main types, frozen test types and changed-source lint pass. The
full-suite result is recorded in the repository status page. Tests cover bounded
256-marker pagination, malformed/torn lists, markers originating in other views,
explicit axis replacement, incompatible/stale axes, retained placements and late
access/recovery/close responses. The existing eight actual-source Time & Line
interoperability cases still pass; those cases exercise the management range and
comparison navigation, not native layout of the new placement chooser.

The actual HTTP fixture passes seven tests in six suites. Both Timeline/calendar
and Sequence/exact-decimal cases add a second saved view, preserve the original
placement, and read the new association back without altering an existing
discussion's captured target or the `.base` content. Its temporary server and
database are removed afterward. Logs use `/private/tmp/marker-placement-*.log`.
Native desktop placement evidence follows below. Mobile and broader placement
acceptance remain; no live vault or production service was changed.

## Native desktop placement and comparison, November 7

Obsidian 1.13.7 on macOS used the disposable
`/private/tmp/evc-timeline-markers-native-20261107` vault, the actual local
FastAPI/Rust services, plugin `90c6d23` plus the fixes below and Time & Line
`6eedff2`. Manage markers listed a marker originating only in another saved
Timeline view. Checking a Sequence view refused the incompatible coordinates
without changing the form. Checking the current Timeline showed its axis for
review; keyboard confirmation added that placement and moved focus to Save.
Server readback confirmed both active placements at revision two. They survived
a complete native reload; `.base` bytes remained unchanged.

The first native pass exposed a scrolling fieldset that hid its own placement
controls. Only the checkbox list now scrolls internally, keeping its legend,
axis check and explicit confirmation visible. A second native pass verified the
layout and point labels with one coordinate.

The comparison displayed the captured November 7 revision beside the revised
November 12 position and explained the changed label/position. Both navigation
buttons moved the actual empty Timeline viewport to the selected position.
Independent server readback confirmed the discussion's captured target stayed
unchanged. After stopping the fixture services and reloading Obsidian, the same
comparison opened from cache with the **Last saved catalog** label and both
positions. The new fixture also displayed the server's explicit UTC timestamp
at the correct local time.

A connection drop before the session detected offline initially prevented
comparison. A retry-classified discussion read can now use the saved thread,
still checking its exact anchor/revision and current read access. Authentication,
permission and pause failures cannot use this fallback. The comparison labels
the saved-discussion fallback. Five regressions cover those paths and retargeting;
the specific drop transition is automated evidence, while native offline reopen
is verified. The failure class lives in a dependency-free module, retaining its
transport re-export, so reading an error does not initialize host networking.

The full plugin suite passes **3,167 tests / 248 suites**, with 22 opt-in tests /
17 suites skipped. Build/main types, frozen test types, changed-source lint and
all eight actual-source Time & Line interoperability cases pass. Logs use
`/private/tmp/marker-native-fixes-*.log`; detailed native observations are in
`/private/tmp/timeline-marker-native-evidence.json`. The temporary services are
stopped and the original Knowledge Base window restored. This does not complete
native Sequence, broader recovery, popout/mobile, touch or resource acceptance.

## Remaining work

Local marker promotion/matching, direct point picking and
broader recovery controls remain. The picker and management form still use explicit refresh so
an in-progress selection/edit is never silently replaced; the timeline overlays
refresh automatically through active discussion polling. Overlapping overlay
polish and native layout/resource measurements remain. The Time & Line fork
has not changed in this increment. Native desktop/mobile, accessibility, recovery
UI and resource acceptance remain before enabling this feature for users.
