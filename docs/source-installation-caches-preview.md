# Verified source-cache imports

`seedSourceInstallationCaches` imports the staged inventory and Markdown/Canvas
histories into the selected generation's inactive IndexedDB caches. It requires
the exact source-selection journal revision in `applying`, re-verifies the plan
and retained original-work archive, and checks each staged update again before
importing. It opens no live provider, awareness session or native writer.

Each cache uses the existing generation/server/endpoint/vault-bound cache name
and existing `LocalDocumentStore` schema. One read/write transaction stores the
identity, plan/artifact receipt, source update, remote origin, known-server-state
flag and, for Markdown/Canvas, the exact native sync base. A failed transaction leaves
none of those records committed. Successful caches can survive interruption of
the remaining folder import.

An import can claim only a completely empty database. A retry accepts exactly
one unchanged seed update and the exact expected identity, receipt and metadata.
It does not append to a populated cache, replace unknown metadata, remove a
quarantine flag or merge an existing editing history. A cache already opened or
modified for another purpose is preserved and refused. Version/schema changes
are refused, and open/transaction waits are bounded. Cancellation after an
uncertain commit is recovered by inspecting the exact stored receipt on retry.

Older preview Canvas seeds omitted the native sync base. A retry may add only
that missing field, in the same transaction, after verifying the exact original
identity/receipt, one byte-identical source update and all remaining metadata.
Changed history, additional updates or unexpected metadata still refuse the
import without modification. This compatibility step does not relabel, merge or
replace history, and does not apply to already-active caches.

Imports run one cache at a time, bounded by the plan's 16 MiB source-update limit
and 10,000-entry limit. The import is atomic per cache, not across every document
database. The durable `applying` journal keeps ordinary source admission closed
throughout; a restart repeats the import and verifies each completed cache.
Concurrent identical imports serialize through IndexedDB and agree on the same
seed. The original legacy/generation caches, recovery archive, text buffers and
pending-upload queues are not read or changed.

The existing document store can reopen these caches offline, including Markdown
text/sync base, Canvas data and the exact inventory restore generation. Tests also
cover old-history isolation, corrupt artifacts, stale journals, partial imports,
unknown/populated/changed caches, simultaneous import, caller mutation,
transaction rollback on quota/cancellation and cancellation after commit.

Verification passes 100 focused cache/materialization/journal/context tests. A
combined real-filesystem test installs native files, imports the staged history,
reopens it through the production document store and resumes both steps after
reopening the journal. Main types, changed-source lint, the unchanged test-type
ratchet and an isolated browser bundle pass. The earlier full regression
checkpoint remains 4,454 tests across 306 suites; this isolated module adds 16
cache tests and extends the native installation test.

This does not prove native installation is complete and does not activate sync.
The activation coordinator must verify native files and selected caches, review
any existing destination-generation buffers/pending uploads, establish writer
isolation, confirm current server admission/generation, update the shared-folder
mapping and commit the journal. Mapping/restart UI and native/mobile acceptance
remain separate unfinished work.
