# Time & Line contextual comments preview

Team Relay can consume the optional collaboration bridge from
[the planning fork](https://github.com/kjgoodrick/obsidian-time-and-line-planning).
The bridge must advertise version one, `available`, both registered view types,
pre-navigation checks and the `annotation` capability. The initial bridge without
those additions is insufficient. Both plugins must be updated together.

This is a development preview. Native Obsidian validation, timeline ranges,
shared milestones and timeline presence remain unfinished. It does not establish
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
