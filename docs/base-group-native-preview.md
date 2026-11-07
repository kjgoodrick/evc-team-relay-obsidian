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
An empty synthetic draft is retained in the test vault; no seventh thread was
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

Group target status still reports that the saved definition matches but the
record/group needs verification. Marker/navigation capture does not substitute
for the unfinished comprehensive target-status path. Native reviewer authoring,
offline group capture/recovery, additional typed groups, cross-window/popout,
physical mobile, accessibility and resource acceptance remain. Actual-service
offline/retry/source-authorization coverage exists separately; this native run
does not replace it.

Local evidence: `/private/tmp/group-native-evidence.json`,
`/private/tmp/group-native-readback.log`, `/private/tmp/group-native-seed.log`,
`/private/tmp/group-plugin-focused.log`, `/private/tmp/group-plugin-build.log`,
`/private/tmp/group-plugin-lint.log`,
`/private/tmp/group-focus-before.log`, `/private/tmp/group-focus-after.log`,
`/private/tmp/group-plugin-regression.log`, `/private/tmp/group-testtypes.log`,
`/private/tmp/group-picker-provider-validation.log` and
`/private/tmp/group-picker-interop.log`. These are disposable machine-local
artifacts; fixture credentials are not committed.
