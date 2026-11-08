# Local-work recovery import: read-only preflight

November 7, 2026. The import preflight validates completed local saved-work
recovery copies. It is a core implementation with tests, not an import command
or native UI yet. It does not write drafts, populate caches, enqueue work,
contact a server or claim that a saved request has not already been accepted.

`inspectLocalWorkRecovery` accepts a selected relative vault directory, a local
read adapter and an account/window guard. It checks the completion marker,
manifest hash/byte count, supported format/storage versions, snapshot identity,
record shapes, unique IDs and captured dependency references. It rejects duplicate
decoded JSON keys, nonfinite numbers, excessive nesting and malformed metadata.
Original pictures use only canonical numbered paths; hashes and byte counts are
verified one at a time. The completion marker is reread at the end. The returned
metadata is deeply frozen and contains no picture bytes.

Limits match the existing capture format: 8 MiB of manifest metadata, 5,000
records, 10 MiB per picture and 100 MiB of original pictures. JSON additionally
caps depth at 48 and values at 250,000. A cooperative 60-second budget and
account/window checks run between asynchronous steps. Local adapter errors are
sanitized; errors contain no file contents, credentials or private paths.

The read adapter must remain local and check file sizes before allocating reads.
The preflight rechecks actual lengths afterward. These checks catch changed
files but cannot impose streaming memory bounds on a public vault API that reads
a whole file, or independently guarantee filesystem symlink isolation. A desktop
adapter with stronger file-opening guarantees can enforce those separately.
No manifest-supplied path can escape the selected directory.

Checksums establish integrity of the captured bytes, not origin, account
authority, current permissions, delivery status or permission to import. Payloads
and pending actions are retained as data and must not be passed directly to
delivery workers. An applying importer must revalidate the selected capture,
review destination/account/identity mapping, reconcile uncertain operations,
deduplicate and commit selected changes transactionally. Those applying controls
and the review UI remain unfinished.

Verification includes actual store exports, immutable inspection, malformed and
corrupt archives, missing completion, unsupported versions, duplicate IDs/keys,
invalid dependencies, unsafe picture paths, oversized/growing files, cancellation,
changed completion and sanitized I/O failures. Independent read-only inspection
also accepts two previously created native Obsidian recovery copies; every read
file remains byte-for-byte unchanged. Both native copies contain one text draft
and no pictures; picture coverage comes from the actual exporter/adapter tests.
