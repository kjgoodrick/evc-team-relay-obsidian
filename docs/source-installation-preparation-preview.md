# Preparing a source installation in the recovery journal

`prepareSourceInstallation` connects the local staging primitive to the durable
selection journal's **review → prepared** transition. The request carries the
review ID, observed review revision, stable operation ID and captured source,
archive, roots and visible server inventory. It must belong to the exact journal
scope and pending generation; wrong, cancelled or superseded reviews fail before
staging starts.

The coordinator rechecks the journal around each read-only source/attachment
download. Staging verifies the saved archive, files, inventory and source/native
content agreement. A separate authenticated `revalidate` callback then reads the
current server inventory for the same captured identity. Normalized visible
records, permissions, owner flag, activity and restore generation must agree with
the verified staged inventory. Changed access, files, activity or generation
leaves the journal in review and retains staged artifacts for inspection.

Only after those checks does a version-checked journal command record the exact
archive reference and installation-plan digest. The active source choice remains
unchanged, pending state still denies ordinary synchronization, and no native
destination, source cache or original file is modified. Competing preparations
may retain separate staged directories; only one journal decision can win.

Caller context checks and cancellation fence asynchronous work; the final server
read has a 30-second timeout, lowerable by the caller. A cancelled or timed-out
server read cannot advance the journal after returning late. A journal save can
commit just before cancellation or a lost acknowledgment: the caller must read
the durable state and reconcile its saved command, rather than blindly creating
another plan or assuming cancellation undid the save. The journal's existing
exact-command receipt handles known retries. Cancellation never rewinds a
committed decision.

This proves preparation against a fresh **inventory** read, not a global server
freeze or a simultaneous snapshot of every editing document. Current server
admission, relevant editing-history freshness, writer isolation and native-byte
checks remain required at installation. The
[download adapters](source-installation-downloads-preview.md) now supply isolated
sources, bounded attachments and fresh read-only inventory, with native transport
acceptance still pending. Production host I/O, persisting the UI's operation intent,
prepared-state resume/reconciliation UI,
native installation and final activation are not connected yet. No user-facing
activation control is enabled by this API.

Focused coverage includes real staging files and journal transactions/reopen,
wrong scope/review/revision/generation, concurrent preparation, cancelling a
review during download, corrupt readback, changed fresh inventory/access,
stalled/late reads and cancellation at the commit boundary. Original native files
and active source choice remain unchanged throughout these tests.

Validation: **133 focused tests** pass across preparation, staging, content,
plan and journal checks. The full plugin suite passes **4,325 tests across 300
suites** (41 tests/27 opt-in suites skipped). Main types, changed-source lint,
unchanged test-type ratchet and preview build pass (205 errors/44 existing
signatures against 207/46; 15 existing build warnings).
