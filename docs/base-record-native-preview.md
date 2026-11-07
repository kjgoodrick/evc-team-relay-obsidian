# Native Bases record and cell status

November 7, 2026. Desktop development acceptance against plugin `a2c10b1`,
server `05e9a0b`, Time & Line `39d9482`, and Obsidian 1.13.7. The disposable vault
is `/private/tmp/evc-record-status-native-20261107`, backed by the actual local
Python control plane and Rust/Yjs relay. This is not full release acceptance.

The fixture contains one shared note with `status: Ready`, plus Table, Cards and
List views. Each view has separate record, status-cell and status-header threads,
seeded through the real command endpoint. The exact note source is seeded through
Yjs and independently received by a read-only protocol peer before native checks.

## Verified native behavior

- Table reports all three targets attached, with separate record, cell and header
  markers. The record message describes verified identity; cell/header messages
  describe exact current local handles.
- Hiding the status column retains all three discussions. The record stays
  attached; the cell and header become unchecked. The hidden cell marker joins
  the row marker without claiming the cell is present.
- Restoring the column returns both targets to attached after saved-view sync.
  Native restoration appends the column, so record/cell markers share a visual
  location and explicitly retain both discussion targets.
- Switching from Table to Cards withdraws Table cell/header evidence, while the
  record remains attached. Opening Cards discussions uses its own three threads.
- Cards and List both confirm the record and visible status cell. Their header
  discussions remain unchecked because these layouts have no matching native
  property-header handle. A label on an individual card is not promoted to a
  view-wide header.
- A full native reload with the API and relay paused restores List markers and
  cached record/cell checks. The record explicitly says last verified; the header
  remains unchecked and online-only moderation is disabled. Reconnection restores
  current record wording.
- Independent owner and read-only reviewer API reads agree on all nine original
  anchors/bodies and all three record batches after reconnect.
- One toolbar appears on the initial native open. This does not resolve the
  earlier intermittent duplicate-toolbar observation.

The original note bytes are unchanged. Native Obsidian normalizes the initial
JSON `.base` to YAML, and the deliberate hide/restore changes Table column order;
this test does not claim unchanged definition bytes. The disposable fixture is
stopped and the original Obsidian window restored.

## Scope

A subsequent capture-feedback increment immediately announces “Preparing
comment…” for cell, record and group capture, disables competing capture buttons
and ignores repeated capture shortcuts until completion. Controls remain stable
through scrolling and late completion cannot revive a closed pane. Its 36 pane
tests, preview build and existing test-type gate pass; changed-source lint has
no errors. This is automated evidence, not an additional native acceptance run.
It exposes the existing bounded preparation wait; it does not shorten network
timeouts or change authorization.

Native formula-cell, reviewer-authoring, multiwindow, mobile, accessibility and
resource acceptance remain. The automated checkpoint covers rebuilt record
identity, denied/missing records, duplicate/recycled handles, stale catalog
revisions, offline cache, authentication lifetime and competing-window writes.
This run does not replace those checks or establish authoritative deletion of a
hidden property.

Local evidence: `/private/tmp/record-native-evidence.json`,
`/private/tmp/record-native-seed.log`, `/private/tmp/record-native-readback.log`
and `/private/tmp/record-native-offline-timing.json`.
Fixture credentials are not committed.
