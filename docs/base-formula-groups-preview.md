# Formula groups and timeline lanes

November 7, 2026: the discussion preview can capture supported formula-based
groups in saved Bases views. Native table headers and Time & Line lane selection
use the existing exact typed target, marker, navigation and durable outbox paths.
Each saved view keeps its own discussions. Formula cells/definition discussions
remain separate target types.

Creation requires the server's `discussion_base_formula_groups` capability and
the exact group definition in the paginated catalog's `formula_group_ids`.
Eligibility does not authorize a client-provided result. The server derives it
from verified source and current saved formula definitions before granting an
immutable source witness. See the server repository's
[formula-group contract](https://github.com/kjgoodrick/evc-team-relay/blob/main/docs/base-formula-groups.md)
for supported functions, bounds, authorization and remaining formula families.

The client copies the typed value before asynchronous work, retains source
snapshot/lineage and definition revisions, and preserves them through offline
capture, cache reopening and lost responses. Cache version **25** preserves all
stores while fencing older writers. Capability downgrade stops new captures and
retains pending work for explicit recovery. Existing witness access remains
subject to server permission checks.

Unsupported formula groups offer no capture button. The keyboard command explains
that the selection is unsupported. A native-discovered focus bug is fixed:
returning from the command palette to a table container retains the precise
selection instead of replacing it with the whole saved view. Explicit pointer
selection and Tab navigation can still change the target.

## Native desktop evidence

Disposable vault `/private/tmp/evc-formula-groups-native-20261107`, Obsidian
**1.13.7**, Time & Line **39d9482**, local synthetic owner/reviewer accounts.
No production service or live vault was changed.

The saved Base defines `double = order * 2` and
`bucket = if(status == "Ready", formula.double + 1, 0)`. A record with order
`2.3` supplies numeric group `5.6`. Tests verify:

1. Table group capture, posting, exact group marker and present target status.
2. Time & Line's target picker selects lane `5.6`; its posted discussion and
   marker are separate from the table's discussion.
3. Full reload restores both markers and the table discussion. Show Bases target
   returns from Timeline to the captured Table view and confirms the group.
4. The command palette retains a supported group draft and explicitly refuses an
   unsupported `file.path` formula group without replacing its selection.
5. Independent owner/reviewer API reads agree on the two exact formula targets
   and bodies. The unsupported view has no posted discussion. Note and `.base`
   hashes match the initial fixture.

The vault is closed and services stopped. Local evidence is
`/private/tmp/formula-groups-native-evidence.json`; the source-only native formula
fixture in the server repository records 131 separate semantics observations.

## Automated verification and remaining work

**3,301 tests / 251 suites** pass, plus production build/main types, the frozen
test-type gate and changed-source lint without errors. Two new regressions cover
unsupported groups with and without a typed native handle across command-palette
focus restoration. Actual Python/Rust/Yjs/client fixtures pass with table and
timeline formula groupings, lost responses, cache reopening, source access,
retained-source loading, group summaries/ranges and relay restart.

This is an opt-in preview. General computed-result/aggregate authorization,
unsupported formula families, formula-group presence, wider native group-summary
and lane-range checks, two-client/version/mobile/accessibility and resource
acceptance remain. The table/picker success does not claim those checks passed.
