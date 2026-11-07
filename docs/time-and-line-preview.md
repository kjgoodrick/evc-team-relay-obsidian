# Time & Line contextual comments preview

Team Relay can consume the optional collaboration bridge from
[the planning fork](https://github.com/kjgoodrick/obsidian-time-and-line-planning).
The bridge must advertise version one, `available`, both registered view types,
pre-navigation checks and the `annotation` capability. The initial bridge without
those additions is insufficient. Both plugins must be updated together.

This is a development preview. Native Obsidian validation, outside-axis range
navigation, shared milestones and timeline presence remain unfinished. It does not establish
the complete desktop/mobile collaboration release.

## Supported behavior

- Timeline and Sequence use the same saved-view discussion scope as ordinary
  Bases views. The adapter retains the existing Obsidian **1.13.7** gate; a bridge
  does not bypass host/source checks or enable unknown Obsidian versions.
- Whole-view, record and visible property-badge targets flow into the existing
  comment UI, durable drafts/outbox and authorized discussion protocol. Property
  IDs retain their note/file/formula namespace. No comment data is written into
  the `.base` or task Markdown files.
- The toolbar offers **Select timeline target**. A subsequent task/badge click or
  tap selects a comment target. Scheduling gestures are intercepted during this
  explicit mode; touch panning retains its native default behavior. Cancel,
  Escape, backgrounding, permission loss, rebinding or unload release the mode.
  Physical touch acceptance remains required.
- Authorized cached threads produce bounded visible markers on the actual SVG
  handles. Hidden properties can retain an explicitly labelled record marker.
  Scroll/layout changes reuse cached discussions rather than loading threads or
  scanning the vault per gesture. The existing 128-marker cap remains.
- Target navigation preserves the original saved view and managed record. An
  unsaved/invalid task inspector prevents file/view navigation and target reveal;
  the guard is rechecked after asynchronous steps. Hidden or ambiguous targets
  produce explicit feedback without rewriting filters or scheduling data.
- Lane headers expose exact query group objects and their current source entries.
  Existing note-property and inventory-backed file-group capture can use these
  lanes. Typed values distinguish text/numbers/empty values; a mixed header offers
  explicit choices. Only records matching the chosen typed value can supply a
  source witness. Unsupported values cannot silently become a view/item target.
  Navigation preserves collapse and horizontal scroll; duplicate typed targets
  across headers are refused rather than guessed. Formula groups and remaining
  file-metadata properties still await dependency/authorization support.

## Ownership and lifecycle

The optional `ranges` extension now connects the fork's local range context,
selection, geometry and navigation to `NativeBasesSurface`. It requires all four
methods and validates renderer/kind compatibility, normalized property identity,
timezones, bounded editable drafts and finite geometry. Captured contexts and
geometry stop being usable after axis mutation, query replacement or unload.
Range and item annotation modes share cancellation ownership. Explicit
cancellation suppresses late delivery; provider cleanup may precede a valid
single selection. Dirty inspectors prevent navigation and new selection.

The consumer API now drives a **Comment on range** toolbar control, confirmation
form, durable target capture, saved markers and discussion navigation. The form
supports whole dates, exact times with explicit offsets, historical CE/BCE dates
with independent endpoint precision, and exact decimal Sequence values. Endpoint
inclusion is explicit. Users can enter values or select endpoints on the rendered
timeline; cancelling selection preserves even unfinished form input. Failed
capture retains values, concurrent sends are suppressed, and a changed axis or
lost permission prevents saving. Successful capture pins the original saved
view, saves the target through the normal draft store, and opens the existing
comment composer/offline outbox.

The form offers the entire saved view or a supported typed lane. The chosen lane
survives endpoint picking and cancellation. A removed, changed or ambiguous lane
cannot silently become a whole-view target. Lane selection freezes its source
evidence with the interval and axis identity; creation works offline after the
saved view, group catalog and axis have been verified and cached. Delivery first
obtains a group witness, persists it, and then sends the original interval with
that exact verified lane. Losing either accepted response, reopening the cache or
restarting the relay does not retarget or duplicate the comment. Axis/access
changes retain rejected work for review. Cache version 18 preserves the stores
and prevents older workers from stripping the new pending-range field.

Authorized lane ranges display on their exact typed lane. Pending draft navigation
also retains the original lane and never falls back to a view-wide span. Saved markers
aggregate identical ranges, clip to the viewport, distinguish included/excluded
endpoints and flag civil-axis DST discontinuities. Geometry refresh uses cached
threads/axis proofs and does not fetch them on scroll. Changed-axis targets stay
in discussions without misleading placement. Navigation respects dirty inspectors
and the original saved-view identity; outside-axis reveal currently reports hidden.

Validation: **2,401 plugin tests in 203 suites** pass (15 opt-in tests skipped),
with preview build/main types, changed-source lint (five existing warnings),
whitespace checks and the frozen test-type gate (no new errors).
Eight source interoperability cases exercise both real renderers, plugin load
orders and grouping modes, including lane choice, endpoint picking, confirmation
and saved lane markers. Their session port supplies a verified axis. Separate
actual Python/Rust/client fixtures for Timeline and Sequence cover fresh
unverified offline lane captures, both lost accepted responses, cache reopen,
exact retries and relay restart. These are not native Obsidian tests.
Range-specific PostgreSQL, desktop/mobile, physical touch and resource acceptance
remain. The last native availability check encountered a locked Mac; that is
historical evidence, not a current lock-state check.

`TimelineBridgeClient` discovers either plugin load order through the fork's
request/ready workspace events. It validates the API shape, bounds surfaces and
handles, rejects duplicate owners, and disposes registrations/annotation hooks.
Re-rendered, replaced, detached or unloaded handles cannot remain targets.
Explicitly cancelled selection callbacks cannot later select a target, and one
annotation session delivers at most one selection.

`NativeBasesSurface` verifies the exact host pane, active renderer, query/config
objects, saved source bytes, file metadata and registry digest before associating
a view. The bridge owns local renderer identities only; it grants no permission.
Existing discussion context/server checks still enforce account, scope, record,
generation and property access. Computed-result dependency authorization remains
a separate unfinished feature; this increment does not claim to implement it.

## Reproduce checks

After installing the pinned dependencies in both source checkouts:

```sh
npx jest __tests__/bases/TimelineBridgeClient.test.ts __tests__/bases/NativeBasesSurface.test.ts __tests__/collaboration/BaseComments.test.ts __tests__/collaboration/BaseCommentsNavigation.test.ts --runInBand
node scripts/check-timeline-interop.mjs /path/to/obsidian-time-and-line-planning
npm run build:preview
npm run typecheck:tests
```

Run `npm test -- --runInBand` for the full plugin regression and `npm run package`
inside the fork for its tests, typecheck, build and plugin-only archive.
`typecheck:tests` is the repository's existing frozen-debt gate, not a zero-error
test TypeScript claim.

The interoperability script bundles the actual production Timeline/Sequence
views, bridge, Team Relay client and saved-view adapter. It checks both load
orders, grouped/ungrouped layouts, exact formula-property targets, annotation
callbacks, saved-view digest binding, navigation, dirty inspector preservation,
render invalidation and disposal. Grouped cases also use the real source-capture
adapter with synthetic Yjs notes and a controlled session port. Only the Obsidian
API/DOM host, session boundary and synthetic source records are supplied by
fixtures; no services or vault are installed.

The separate real-service fixture accepts `EVC_BASE_GROUP_VIEW_TYPE` as `table`,
`sabidurian-timeline`, or `sabidurian-sequence`. From the server's control-plane
checkout, with its dependencies and relay binary available:

```sh
EVC_BASE_GROUP_VIEW_TYPE=sabidurian-timeline .venv/bin/python tests/integration/managed_stack.py --base-groups --plugin /path/to/evc-team-relay-obsidian
EVC_BASE_GROUP_VIEW_TYPE=sabidurian-sequence .venv/bin/python tests/integration/managed_stack.py --base-groups --plugin /path/to/evc-team-relay-obsidian
```

Both variants verify real group capture and retained-source/offline recovery,
lost capture/comment responses, database reopen, source permissions, relay
restart and file-group capture. This checks the shared protocol in each view type
separately from the real-source renderer fixture; it does not establish native
Obsidian end-to-end acceptance.

## Remaining targets and acceptance

Formula and remaining metadata lanes; calendar, instant, historical and ordinal ranges; opt-in
shared marker/milestone identities; timeline presence and Jump/Follow; keyboard
target selection/accessibility; popouts and physical touch; resource/battery
measurements; native authorization, offline delivery and recovery against actual
services. Unsupported targets retain discussions in the sidebar rather than
inventing a location or changing their identity.

## Durable range protocol and session checkpoint

Calendar, explicit-offset instant, historical and exact ordinal range values now
have shared client/server codecs. The server derives saved-view axis identities
and revisions, persists range discussions and validates optional lane witnesses.
The client discovers/caches the axis, captures explicit intervals, labels retained
targets, preserves drafts and uses the normal offline queue. Cache version 17
fences older writers while retaining existing stores. The server flag
`COLLABORATION_BASES_TIMELINE_RANGES_ENABLED` remains off by default.

The actual-service fixture above now also checks lane-bound ranges for both view
types: offline capture from verified axis context, queued delivery, accepted
response loss, cache reopen and retained targets after relay restart. Exact
Sequence values remain decimal strings; dense positions never become identities.

At the protocol checkpoint the renderer was not connected. The later optional
range API described above adds gesture, geometry and in-axis reveal consumption.
The current range interface above adds toolbar/confirmation, durable capture,
saved markers and discussion navigation. New unverified offline lane composition
and native acceptance remain.
Reading an existing range must
retain its original axis/zone/precision even when the current renderer cannot
project it. See the server's `docs/timeline-range-preview.md` for the wire contract
and authorization rules.
