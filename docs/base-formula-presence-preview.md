# Formula-group presence preview

November 7, 2026. Saved Bases groups can publish and display precise cursors for
a bounded same-record formula subset, including Time & Line lanes and lanes inside
timeline viewport ranges. Existing Jump/Follow navigation uses the same verified
native handles. Discussions remain scoped to saved views and unchanged by this
presence feature.

The server separately opts in with
`COLLABORATION_PRESENCE_FORMULA_GROUPS_ENABLED=true`. Version-three negotiation
keeps unsupported positions out of older receivers while preserving supported
cells/items/headers and participant rosters. Formula comments do not need to be
enabled. See the [server contract](https://github.com/kjgoodrick/evc-team-relay/blob/main/docs/base-formula-presence.md).

## Native desktop verification

Disposable vault `/private/tmp/evc-formula-presence-native-20261107`, Obsidian
**1.13.7**, Time & Line **39d9482**, local synthetic accounts and a protocol peer.
This is one native client plus a protocol peer, not two native clients.

The Base defines `double = order * 2` and
`bucket = if(status == "Ready", formula.double + 1, 0)`. The selected record's
order `2.3` produces group `5.6`. Verified behavior:

1. The remote Table cursor appears on group `5.6` and moves from 25% to 75% of
   its header. Native pointer capture publishes a version-three formula target.
2. Selecting Timeline hides the Table cursor. Publishing the Timeline identity
   draws the cursor on lane `5.6`; native viewport capture includes that formula
   lane in its date-range target.
3. Jump reports success; Follow scrolls from evening to early morning in the
   same lane. Full native reload restores the remote lane cursor.
4. The unsupported `file.path` formula group publishes no group pointer while
   its supported formula-cell viewport remains available.
5. Native lane collapse/expand changes the saved Base revision and withdraws
   obsolete presence. A discovered repaint bug is fixed: failed lookups retain
   the unavailable status and Retry control. Native Retry restores presence
   without reloading; result repaint does not automatically repeat denied reads.
6. Independent owner API readback matches the final local Base hash and confirms
   two supported formula plans, with no plan for the unsupported view. `Note.md`
   retains its initial hash. Collapse/expand intentionally serializes YAML and
   changes `collapsedGroups`; these are native view edits, not presence writes.

The vault is closed and its test services are stopped. Local evidence is
`/private/tmp/formula-presence-native-evidence.json`.

## Automated coverage and limits

**3,331 plugin tests / 251 suites** pass, along with production build/main types,
the frozen test-type gate (no new errors) and changed-source lint without errors.
The server presence suite passes **262 tests**.

Protocol/context tests cover bounded plans, deep immutability, old-version
fallback, malformed negotiation and formula-lane ranges. Native adapters read
only static raw properties from an exact current member. Local matching includes
linked inputs from inactive formula branches, rejects stale inputs even when the
result stays equal, and shares existing bounded metadata/hash work. One thousand
unchanged captures do not add metadata or hashing jobs.

The actual Python/Rust/Yjs service fixture exchanges version-three state through
real `LocationChannel` clients and independently matches it using native input
ports. Removing a viewer's access to an inactive-branch linked record withdraws
the pointer while preserving the readable Base roster. The saved Base is unchanged.
Two regression cases cover unavailable/denied lookups across 100 native result
replacements and successful explicit retry.

This is still a preview. Unsupported formulas, ambient/cross-record computations,
remaining file-metadata groups, two-native-client/mobile/version/accessibility
coverage and device latency/battery measurements remain. Static inputs are
conservative: an unused linked input can make a group unavailable. Native lookup
failures intentionally require Retry after synchronization/authorization recovers;
repainting alone never polls the server. No live vault or production deployment
was changed.
