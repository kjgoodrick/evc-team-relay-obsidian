# Staging a reviewed source generation

`stageSourceInstallation` assembles a new local installation artifact directory
from a captured, explicitly selected server generation. It validates and copies
review metadata before the first asynchronous operation, builds a fresh inventory,
re-verifies the original-work recovery archive, and creates a unique staging
directory using an I/O operation that must fail if the directory already exists.
It never reuses or empties an existing directory.

Downloads are sequential and receive detached entry metadata plus the exact
vault/server/folder/generation identity. Markdown and existing Canvas sources
are projected from complete editing histories using the native save projection.
Attachments must match the captured inventory hash. Each artifact is saved under
its generated entry ID. The final plan manifest is written only after all entries
are staged, and the complete archive, manifest, artifact digests and content
semantics are read back before a result is returned.

The adapter contract requires read-only, generation-bound downloads and exclusive
directory creation. A [preparation coordinator](source-installation-preparation-preview.md)
now connects verified staging and a fresh inventory read to the journal.
Production host/transport adapters are not connected yet; synthetic tests exercise this contract on a
real temporary filesystem. The primitive does not select a source, advance the
selection journal, create the proposed native destination, touch originals,
import a source cache or replay saved work. A returned artifact still needs current
server, journal and writer-isolation checks before installation.

Each storage, hash or download operation has a 30-second timeout, lowerable by
the caller. Cancellation and caller-context checks surround asynchronous work.
Already-started native staging I/O may finish after cancellation, but cannot
continue to another download/write or return success. Incomplete artifacts remain
for inspection; a retry creates a new ID and preserves the previous directory.
No cleanup/discard action is automatic.

Capture metadata is bounded to 16 MiB. Source/inventory updates and projected
source files are bounded to 16 MiB, individual attachments to 256 MiB, all staged
artifacts to 64 GiB and entries to 10,000. Download adapters must enforce supplied
budgets while receiving bytes; the primitive also checks lengths on receipt.
Staging retains one entry at a time, but individual buffers, copies and verification
reads are still materialized. Streaming, worker/heap limits and physical mobile
measurements remain pending.

Verification: 91 focused staging/content/plan tests pass, covering real-file
readback, original preservation, repeat staging, immutable capture/callback
inputs, exclusive-directory conflict, damaged backups, changed generations,
attachment mismatches, corrupt native/manifest writes, timeout, changing context,
late download/write completion after cancellation, oversized input and incomplete
source dependencies. Main types, changed-source lint, build and the unchanged
test-type ratchet pass (15 existing build warnings). Full native installer,
restart coordination and UI acceptance remain unfinished.
