# Bases group-summary native and offline preview

November 7, 2026. The server and client can retain and deliver a discussion about
one summary definition in one saved-view group. Built-in table summary rows now
support contextual capture, distinct markers, current-target status and exact
navigation, with native Obsidian 1.13.7 desktop evidence. Mobile and broader
resource acceptance remain.

## Identity and access

`group_summary` is a separate target kind containing the summary definition ID,
revision, property and assignment, together with the complete immutable `group`
target. It never becomes a whole-view summary or a group-header discussion by
fallback. The saved Base/view/generation supplies the outer scope.

Creating a thread requires comment access to the Base and current read access to
the exact group witness's source references. Source-note comment access is not
required. Reads, replies, history, receipts, pictures, search/filtering and target
moves continue to use that witness. Another readable group with the same typed
value cannot substitute for it. Moving a thread must preserve its entire set of
read dependencies, including when moving to or from a plain group.

The summary and grouping revisions are independently checked. Changing either
rejects a stale new selection while preserving historical discussions and exact
accepted retries. Catalog status distinguishes changed definitions from an exact
native target that has not yet been verified. No aggregate result, quote or
caller-supplied computed dependency list is accepted. Automatic computed-value
excerpts still require a separate dependency-authorization design.

## Offline and compatibility

A pending group selection may contain one immutable summary definition, mutually
exclusive with a timeline range. The existing two-phase outbox first verifies
and durably saves the group capture receipt, then forms the final summary target.
The same resolver is used for reviewed reattachment. Response loss retries retain
the operation ID, body, selected summary and original group evidence. Picture
recovery and draft restoration retain that intent too.

Cache version 24 preserves the existing stores and closes older handles. Older
plugin versions cannot reopen this cache and rewrite newer pending selections.
Downgrading therefore requires a planned cache/recovery procedure; do not delete
local saved work to bypass the version guard.

The default-off server flag is
`COLLABORATION_BASES_GROUP_SUMMARIES_ENABLED`. Creation also requires the existing
Bases definition/group capabilities. Upgraded clients require explicit
`group_summary` advertisement and definition/group support. Disablement pauses
new sends without deleting drafts or hiding existing readable discussions.
Enable only after every participating client supports the new target kind;
older wire parsers cannot read it. There is no SQL schema migration.

## Native table behavior

The adapter checks the native group, summary row, property, assigned summary and
current cell ownership. It reuses exact typed group choices and server-verified
member evidence without evaluating or copying aggregate results. A group header,
a group summary and the whole-view footer have separate target keys. Mixed typed
groups require an explicit choice. Recycled, duplicated or stale cells fail
closed. Horizontal navigation is bounded and never falls back to a group header.

Native acceptance used a disposable vault and local Python/Rust services. Four
posted discussions covered ordinary and formula summaries, separate Ready and
Planned groups, and a whole-view footer. Hiding/restoring the formula column
preserved discussions and restored exact markers. Show summary correctly reports
a hidden property; a native-discovered catalog-kind navigation bug was fixed and
retested. Switching grouping from status to file.ext and back leaves all three
old group summaries in revision review, while the whole-view footer stays valid.

A fifth discussion was captured and queued with both services paused, survived a
full app reload and delivered exactly once after reconnect. Its group revision
is newer; its summary identity is unchanged. Independent owner/reviewer readback
agrees on all readable anchors and bodies. The protected Planned group remains
absent from the reviewer list and direct access returns 404. Source Markdown is
unchanged. The test window is closed, the original window restored and both test
services stopped. Local evidence is in
`/private/tmp/group-summary-native-evidence.json`.

## Validation

- 3,271 plugin tests in 250 suites pass; 22 environment-specific tests remain
  skipped. Preview build and main types pass. Test types remain within the frozen
  baseline (206 existing errors / 45 signatures versus 207 / 46 allowed).
- Focused coverage includes malformed/nested targets, distinct capability gates,
  cache upgrade fencing, offline reload, changed permission/definitions,
  capture/send response loss, picture recovery and exact-target status.
- Actual Python control plane and Rust relay exercise group-summary creation,
  both lost-response stages, reopened cache, idempotent retry and relay restart.
- 185 server regression tests pass, including all 15 group-summary cases and
  existing definition, group, formula-cell, timeline-range and reattachment cases.
- Disposable PostgreSQL verifies same-value witness isolation for both ordinary
  groups and group summaries alongside the existing transaction/migration suite.
  The test container was stopped and removed.
- Changed-source lint has no errors and five existing proper-name warnings.
- Native adapter tests cover cell recycling, typed ambiguity, hidden properties,
  bounded virtualization, authorization loss and both definition revisions.

The local service fixture is stopped. No live vault installation or production
rollout is included. Wider native layouts, mobile, accessibility and resource
acceptance remain. Aggregate-result authorization is a separate unfinished area.
