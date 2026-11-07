# Native Bases group preview

November 7, 2026. This is development acceptance evidence, not a completed
desktop/mobile release. Testing uses Obsidian 1.13.7 and a disposable vault at
`/private/tmp/evc-groups-integrated-native-20261107`, backed by the actual local
Python control plane and Rust/Yjs relay. No live vault or production service is
changed.

## Verified behavior

The fixture has six saved views of one synchronized Markdown record: Table,
Cards, List, Time & Line Timeline and Sequence grouped by `status: Ready`, plus
a Table grouped by `file.folder`. The note's exact Yjs source was independently
received by a read-only protocol peer before native capture.

- Native group-header selection creates comments in Table, Cards and List.
- The Time & Line target picker selects a lane without editing its task or
  collapsing the lane. Native Sequence Enter confirmation also passes.
- Each view receives its own group discussion and marker. The equal `Ready`
  values do not merge discussions across saved views.
- The folder group displays the local mount `Team` and captures the share root
  as empty wire text, preserving mount-independent identity. The sidebar now
  describes this as `Shared folder root`, distinct from an empty note property.
- Owner and read-only reviewer API reads return identical thread bodies and
  exact group anchors for all six views. Table target navigation and Sequence
  marker opening pass. Folder and Sequence markers/discussions survive full
  native reloads.

Native Obsidian serialized the fixture's initial JSON definition to YAML and
canonicalized `note.*` order aliases. Independent checks verify all six view
identities, filters, grouping, property order and axis settings remain equivalent.
The source Markdown bytes are unchanged. This run does not claim unchanged
`.base` bytes.

## Fixes found by native testing

The provider's picker previously used the lane's first SVG text node, which is
the collapse glyph. It now selects the dedicated group-name node; native menus
show `Lane: Ready`. Sequence item accessible names and tooltips now use original
ordinal positions, including decimal spans in dense layouts, instead of calendar
dates or rounded layout coordinates. Native Obsidian announces `Position 2.3`.

The consumer no longer adds a second `Group:` prefix to the complete draft
description. Shared folder root descriptions also apply to pending captures and
lane ranges. These are presentation changes; group identity and authorization
are unchanged.

Native group headers also initially needed two clicks after focus moved outside
the Base: the precise pointer selection was overwritten when Obsidian focused
the surrounding container. The pane now retains the pointer target through that
same gesture's ancestor focus, then clears this temporary allowance on pointer
completion/cancellation, blur or keyboard input. Two regressions reproduce the
failure before the fix for cells and groups; both pass afterward. Native sidebar
focus followed by one folder-header click now retains the group. Pending draft
creation displays exactly `Group: folder · Shared folder root (verification pending)`.
An empty synthetic draft is retained in the test vault; no additional thread was
posted during this label check.

Validation: all 3,206 plugin tests across 249 suites pass, with 22 fixture-gated
tests in 17 suites skipped. The focused host/pane/group/comment DOM checks and
51 pane/navigation cases pass. Preview build/main types pass; test types remain
within the frozen baseline (206 errors/45 signatures against 207/46). Changed-source
lint has no errors and five existing Bases proper-name warnings. The provider has 269
passing tests, including decimal sparse/dense label and tooltip coverage, plus
typecheck/build/package. All eight actual-source consumer interoperability cases
pass. The provider test host needed its missing Obsidian `appendText` method
before the new tooltip assertions could execute.

## Remaining acceptance and observed limitations

An initial native open showed two comments toolbars. A diagnostic read found one
current host/controller/pane but two toolbar elements. Reopening the Base cleared
the duplicate; subsequent view changes and three full reloads have not reproduced
it. Its origin is unresolved and remains a lifecycle investigation, not a fixed
or accepted behavior.

Group and lane-range target status now uses exact current native handles in the
matching saved view. The sidebar reports a local match only when the captured
anchor, synchronized definition/generation and (for ranges) axis still agree.
Hidden, virtualized or duplicate handles withdraw positive evidence without
claiming the target was deleted. Changes notify the relevant sidebar; scrolling
alone does not repeat catalog reads or send status notifications.

Native Sequence and folder discussions now report zero unchecked targets.
Switching to another saved view withdraws that evidence; Show Bases target
restores the matching view and positive status. A native Sequence lane range
from 2.2 through 2.4, inclusive, retains the exact ordinal endpoints and Ready
lane, with independent owner/reviewer API readback. Both group and range markers
remain separate and both statuses explain their local evidence.

The disposable relay and API were paused with an automatic-resume watchdog.
A new Sequence group comment was captured and queued, then survived a full
native reload. Cached group/range markers and positive local statuses returned
while services were still paused; online-only moderation stayed disabled.
After resume, the queue cleared and exactly one new thread appeared, confirmed
independently through both owner and read-only reviewer APIs (eight total threads).
Source Markdown and equivalent saved-view configuration remained unchanged.
Initial capture waited for bounded network failure detection; this checks retained
cached identities, not first-ever offline identity creation. The fixture was
stopped and the original Obsidian window restored after readback.

This follow-up passes all 3,210 plugin tests / 249 suites (22 tests / 17 suites
skipped), preview build/main types, and the frozen test-type gate (206 errors /
45 signatures against 207 / 46). Changed-source lint has no errors and five
existing proper-name warnings. Positive evidence does not complete authoritative
absence checks, other Bases target kinds, wider typed groups, native reviewer
authoring, cross-window/popout, physical mobile, accessibility or resource
acceptance.

Local evidence: `/private/tmp/group-native-evidence.json`,
`/private/tmp/group-native-readback.log`, `/private/tmp/group-native-seed.log`,
`/private/tmp/group-plugin-focused.log`, `/private/tmp/group-plugin-build.log`,
`/private/tmp/group-plugin-lint.log`,
`/private/tmp/group-focus-before.log`, `/private/tmp/group-focus-after.log`,
`/private/tmp/group-plugin-regression.log`, `/private/tmp/group-testtypes.log`,
`/private/tmp/group-picker-provider-validation.log` and
`/private/tmp/group-picker-interop.log`. These are disposable machine-local
artifacts; fixture credentials are not committed.

Target-status follow-up evidence: `/private/tmp/group-status-regression.log`,
`/private/tmp/group-status-focused.log`, `/private/tmp/group-status-build.log`,
`/private/tmp/group-status-testtypes.log` and `/private/tmp/group-status-lint.log`.

Offline timing: `/private/tmp/group-native-queue-timing.json`.
