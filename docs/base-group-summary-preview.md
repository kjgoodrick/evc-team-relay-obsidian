# Bases group-summary protocol and offline preview

November 7, 2026. The server and client can retain and deliver a discussion about
one summary definition in one saved-view group. Native summary-row selection,
markers and exact navigation are the next increment; this checkpoint does not
claim native or mobile acceptance.

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

## Validation

- 3,250 plugin tests in 250 suites pass; 22 environment-specific tests remain
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
- Changed-source lint has no errors and two existing proper-name warnings.
- A subsequent native-adapter regression confirms pending summary targets do
  not fall back to group headers while exact summary controls are unavailable.

The local service fixture is stopped. No live vault installation or production
rollout is included. Native group-summary controls, native offline/reconnect,
mobile, accessibility and resource acceptance remain.
