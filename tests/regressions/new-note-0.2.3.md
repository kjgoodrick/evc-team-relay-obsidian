# New-note conflict-copy regression: 0.2.3

Verified November 3, 2026 (America/Denver), using Node 24.22.2 and actual
Obsidian 1.13.7 on macOS. This is a client-only change; the tested server remains
`460ddf67e7092bb8e211ec6534d2f74bd9a472ab`.

## Evidence and diagnosis

A reported create → title → type sequence produced a new conflict-copy note.
The supplied 0.2.2 diagnostic log shows a successful rename retaining the same
document identity, followed by `uploadDocumentViaSocket` reconciling 16 live
characters against a 13-character vault file. It preserved the newer live text
in a conflict copy and applied the older disk snapshot. This was content
reconciliation, not a rejected structural rename.

The same log shows a signed-out editor binding while the share's provider
authenticates and connects successfully. The binding registry used the global
active/default server's authentication state, while the share's provider used
its own server session. A signed-out binding can still reach the fallback
embedded-document synchronization path, but it does not hold the normal
document editor lock. Background transfers therefore treated an intermediate
save as an independent disk edit while typing continued.

This was reproduced in a disposable Obsidian vault against an isolated real
relay. The share server was authenticated while an unused default server was
signed out. Holding the background disk read at 16 characters and typing three
more produced a conflict copy and reverted the active note to 16 characters.
The observed stack reached `writeConflictCopy` through
`reconcileWithConflictCopy`, `reconcileRelayContent` and
`uploadDocumentViaSocket`. The supplied log does not expose the reporter's full
server configuration; the controlled configuration reproduces its binding and
transfer behavior.

During actual Obsidian testing, an asynchronous editor resync also resumed after
its view was destroyed and threw while reading the disposed editor's state.
That lifecycle race and stale editor snapshots are covered by this correction.
Private logs, note contents and account identifiers are not included here.

## Correction

- Resolve editor authentication and folder connectivity against each share's
  configured server, retaining the legacy fallback for shares without one.
- Let the active editor own its live document. Background markdown upload
  reconciliation, sync-base advancement and fallback disk flushing honor its
  lock, including after asynchronous operations.
- Defer reconciliation if the live text changes during a disk read or backup.
  Preserving an older snapshot does not authorize replacing later edits.
- Recheck editor/view/document identity after resync waits. Seed an empty live
  document from the latest editor buffer, and discard a keyframe calculated
  before a subsequent editor transaction.

Genuine conflicts on closed notes still use the existing preservation path.
The update does not delete or merge conflict copies already created.

## Verification

| Check | Result |
| --- | --- |
| Regression tests | 16 added tests across server-specific bindings, transfer races and editor resync; the three focused suites pass all 25 tests |
| Failure before fix | Three stale-upload tests and all five resync race tests failed against the earlier implementation |
| Full Jest suite | 135 suites / 1,386 tests passed; one separately run real-stack test skipped in the ordinary suite |
| Real relay integration | Separate managed-stack test passed against the production provider, control plane and Rust relay, including concurrent/offline edits, restart and permission checks |
| Production build | TypeScript and `npm run build:preview` passed; 15 pre-existing Svelte warnings |
| Test type baseline | No new errors; inherited baseline decreased from 207 errors / 46 signatures to 206 / 45 |
| Actual Obsidian, signed-out default server | Create, title, type and delayed background upload preserved every expected character with the correct editor lock and no new conflict copy |
| Actual Obsidian, live peer | An independent WebSocket client read the exact text, appended an edit which appeared in Obsidian, and received subsequent typing |
| Actual Obsidian, reload | The full final text survived reload; a second create/title/type sequence synchronized exactly with no new conflict copy |
| Runtime errors | None captured during the final fixed-build workflow |

The delayed-upload fixture's final editor, disk and independent peer all held
`hello world!!123 + peer editXYZ`. The second note held
`Every character must survive.123`. Only the conflict copy deliberately created
by the earlier 0.2.2 reproduction remained in the disposable vault.

These are actual desktop Obsidian integration checks and isolated relay checks.
The 0.2.3 changes have not been rerun in mobile emulation or iOS Simulator.
The [0.2.2 mobile report](../mobile/results/2026-11-03/README.md) remains historical
coverage, not proof of this version on iOS. Native Obsidian on iPhone/Android,
plugin loading, real mobile vault access, background/resume and device
performance still require testing. The reported MacBook must also be updated
and its original workflow confirmed there.
