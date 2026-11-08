# Same-folder recovery preparation and comparison

The recovery preparation pipeline now accepts an explicit
`mode: "existing-folder"`. It produces a version-2 source installation plan whose
original and destination roots must match exactly. Omitted mode retains the
version-1 new-folder behavior; equal paths never silently opt in. Source downloads,
archive verification, full editing-history/native projection checks and durable
prepared-journal receipts are shared with the existing pipeline.

This is **read-only preparation and comparison, not same-folder replacement**.
The new-folder materializer, native publication adapter and mapping coordinator
explicitly reject version-2 plans before their mutations. Merely accepting a new
plan format cannot bypass the existing installer’s disjoint-folder protections.

`inspectSameFolderSource` verifies the saved plan, selected source and original
archive before inspecting the native tree. It compares each current file with
the hash-bound archive entry and selected native projection. It reports unchanged,
create, replace, local-only, absent and file/directory-conflict observations;
separate backup status identifies changed/deleted originals and files not in the
archive. A local-only file is not automatically classified as a deletion. Empty
files, empty directories and hidden local files remain visible to the comparison.
Archived files outside the exact original-root prefix do not attest its contents.

Case and Unicode aliases are checked through parent directories as well as file
names. A file blocking a selected directory marks its affected descendants too.
Rows carry selected managed entry IDs when available; path equality does not
establish that two histories have the same identity. There is no automatic merge,
deletion, upload or source activation.

`createDesktopSameFolderInspectionIO` provides the actual read-only filesystem
adapter. It refuses unsupported/mobile hosts, out-of-root paths, symbolic links,
non-regular files and hard-linked files. It remembers vault/directory identities,
checks file identity/size/timestamps around no-follow reads, and rejects directory
changes during listing. It creates no marker or temporary file. These checks
detect ordinary concurrent replacement; they are not an OS lock against arbitrary
processes and do not turn a sequential comparison into an atomic tree snapshot.

Inspection has entry/path/component limits, sequential bounded file reads,
256-MiB per-file and 64-GiB total byte ceilings, caller-lowerable read budgets,
30-second per-operation timeouts, cancellation and account/context checks.
Oversized or failed scans return no successful partial comparison. The verified
archive retains its existing separate limits. Individual file buffers are still
materialized; mobile/streaming and physical resource acceptance remain unfinished.

A returned comparison is an observation, not durable permission to overwrite.
The replacement coordinator must bind explicit review choices, recheck live files
and saved work, journal each mutation, preserve untracked content, coordinate
editors and activate fresh histories at the same root. Native-file comparison
also does not prove that unsaved editor buffers or pending discussion/Bases work
have been reconciled. Private packaged archive storage, recovery UI and the
same-root registry/startup handoff remain unfinished.

A separate [desktop file-operation primitive](same-folder-native-operations-preview.md)
now retains original inodes and publishes reviewed replacements at the same path
with restart receipts. It is not yet the complete replacement coordinator and
does not turn this read-only comparison into write authorization.

## Verification

Real temporary-directory tests cover native comparison without a second working
folder, backup/edit/delete/new-file distinctions, empty content, hidden files,
type/ancestor/case conflicts, invalid mode/version/root combinations, damaged
archives, resource limits, links, root replacement, cancellation, timeouts and
context changes. A prepared same-folder journal survives reopen; invoking the
old mutation paths leaves native originals unchanged and the materializer's
journal prepared.

The actual disposable FastAPI/Rust restore fixture also prepares and compares
Markdown and existing Canvas histories at the original root, using the real
download and native inspection adapters. The HTTP/MinIO fixture exercises current
and legacy managed attachment revisions. Both identify preserved local work and
new unbacked-up work without creating the proposed alternate working folder or
advancing the review journal. They then continue their separate existing
new-folder activation proofs. These are actual-service/desktop-filesystem checks,
not native Obsidian UI or mobile acceptance. Their owned processes, buckets and
container are cleaned up.

The checkpoint passes **204 focused recovery tests** and **4,622 tests across
310 suites** in the full regression (41 tests in 27 opt-in suites skipped).
Main types, changed-source lint, browser bundles and the production preview build
pass; 15 existing build warnings remain. The test-type ratchet is unchanged at
205 errors/44 signatures against the frozen 207/46 baseline. Native UI testing
remains unavailable while the Mac is locked.

Related: [source plan](source-installation-plan-preview.md),
[staging](source-installation-staging-preview.md),
[new-folder activation](source-installation-activation-preview.md).
