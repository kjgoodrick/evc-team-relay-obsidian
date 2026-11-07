# Native Bases summary footer discussions

November 7, 2026. This increment connects saved-view summary definition threads
to the built-in Obsidian 1.13.7 table footer. It uses the existing server protocol;
there is no schema change or new permission. Group-specific summaries and
computed-result authorization remain separate work.

## Behavior and boundaries

A footer selection captures the catalog's summary identity/revision, property and
summary assignment. Both ordinary properties and formula properties work. Posted
threads receive exact footer markers; **Show summary** navigates to the matching
footer. Hidden columns retain their discussion and report unavailable placement.
A horizontally virtualized footer can be mounted using verified column geometry,
without selecting a record or changing saved filters. Failed navigation restores
the previous viewport.

The adapter verifies renderer, footer, cell, result-array identity and rendered
summary key, plus the existing saved-view binding. It never reads the rendered
aggregate value or evaluates formulas. A group summary row is not a whole-view
footer, and an unassigned placeholder cannot become a view comment. Recycled,
replaced, detached, duplicate or stale handles cannot supply placement. Summary
presence pointers are not added by this increment.

Native toolbar controls are outside target selection. An unsupported target in
the table content/header/footer suppresses the default view-capture action; the
view's discussions remain accessible. Native testing found and fixed an initial
hint that shifted the Properties button during its click. Duplicate native target
handles now suppress their marker instead of selecting the last handle.

The private footer model was checked in the running version's app source. The
version gate remains Obsidian 1.13.7. Summary assignment semantics are described in
[Obsidian's Bases syntax](https://obsidian.md/help/bases/syntax).

## Native desktop evidence

Disposable vault: `/private/tmp/evc-summary-native-20261107`. It uses the actual
local Python control plane and Rust/Yjs relay with synthetic owner/reviewer
accounts. The source note was seeded through Yjs and verified from a read-only
protocol peer before native testing.

- Native capture/send creates separate `note.order / Sum` and
  `formula.double / Average` threads and exact footer markers.
- Changing Sum to Average withdraws the original marker and reports a changed
  definition. Reverting to Sum retains that review state; it does not reattach a
  historical revision silently.
- Hiding the formula column removes its marker but preserves the discussion and
  verified definition status. Navigation explains that the property is hidden.
  Restoring the column returns the exact formula-summary marker and navigation.
- Full online reload retains both threads, revision-review state and the final
  **Show summary** label. The corrected Properties menu opens normally.
- Independent owner/reviewer API reads agree on both immutable original targets
  and bodies after native configuration changes. Markdown bytes are unchanged.
  The `.base` file undergoes ordinary native YAML normalization and deliberate
  summary/column edits.

A full offline reload restores the cached formula-summary marker, last-verified
definition status and changed-summary review state with moderation disabled. A new
formula-summary comment can be captured and queued offline; it survives a second
full reload. Reconnection delivers it exactly once: three threads, a two-thread
formula-summary marker, no pending send and exact owner/reviewer readback. The
disposable services are stopped and the original Obsidian window is restored.
Mobile/popout/version acceptance,
large/empty results and broader keyboard/repaint/resource checks remain. Current
horizontal virtualization, stale ownership, failed-scroll restoration and
unsupported/group-summary behavior have automated evidence; this native run does
not claim those entire matrices.

## Validation

The final full run passes 3,238 tests in 250 suites (22 tests in 17 opt-in suites
skipped). The focused adapter/pane/navigation/sidebar run passes 188 tests. Preview build
passes with 15 existing warnings. The frozen test-type gate passes at 206 errors /
45 signatures against its 207 / 46 baseline. Changed-source lint has no errors and
five existing proper-name warnings.

Local logs: `/private/tmp/base-summary-regression.log`,
`/private/tmp/base-summary-native-fix.log`, `/private/tmp/base-summary-ui.log`,
`/private/tmp/base-summary-build.log`, `/private/tmp/base-summary-testtypes.log`,
`/private/tmp/base-summary-lint.log`, and `/private/tmp/summary-native-seed.log`.
Native evidence and exact API readbacks are recorded in
`/private/tmp/summary-native-evidence.json`; credentials are not committed.
