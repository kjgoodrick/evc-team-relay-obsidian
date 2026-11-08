# Separate source histories for restore generations

The source-cache APIs open separate IndexedDB histories for a selected
server and restore generation. Its durable identity includes the vault/app ID,
configured server ID, normalized control-plane endpoint, canonical document
address (including share and Markdown/Canvas kind), and generation. SHA-256 of
that identity keeps names short; the full identity is also stored and checked.
Credentials and transient login sessions are excluded, so signing in again does
not discard retained offline work. Server access is checked separately.

Opening the cache claims an empty database atomically or validates its exact
existing identity before replaying any history or accepting queued writes. A
populated database without identity is rejected, including one containing only
metadata. A mismatched or unbound open cannot load or append to an identified
cache. Normal metadata methods cannot replace or remove its identity. Startup
failure rejects the load promise and closes the database instead of leaving a
caller waiting indefinitely. Concurrent matching opens retain both editors.

`ProviderBacked` accepts an immutable explicit generation at construction and
uses it for token acquisition, cached-grant checks, renewals, unsubscribe and
restore pauses. An attached source cache must match the current server endpoint,
document and generation before token use. An identified cache requires an
explicit selection even when selecting the original, null generation. A restored provider attached to a
legacy unbound cache is refused. The normal automatic `Document` and
`CanvasDocument` paths still select their original lineage and remain paused
after a restore; this change does not migrate their data or enable a Resume
button.

Folder inventories now have a separate `team-relay-inventory-cache` identity and
`relay-inventory-v1-<sha256>` namespace. Their canonical folder address cannot be
used as a document cache, and a document identity cannot be used as an inventory.
The existing document descriptor/hash format remains unchanged. An inventory
provider carries its fixed selection through `YSweetProvider` into
`ManagedIndexTransport`; refreshing a folder observation grant does not change
the selection. Even an empty selected cache refuses a different first generation.
Pending changes before its first snapshot require a matching server read before
any write. Later restores preserve the previous snapshot, local moves, activity
and durable review while withdrawing permissions. An incompatible persisted
snapshot cannot authorize claims, publication or transfers.

The descriptor provides a distinct unsaved-buffer key in the existing buffer
store. Tests verify that old and new histories, quarantine markers and buffers
survive independently across reopen. The API does not read or import old cache
or buffer keys. Its caller supplies the new document and explicitly selected
identity; it must not transplant the previous document's state into that new
document. Existing automatic source code still uses its legacy buffer keys.

The actual disposable FastAPI/Rust scenario rotates a share generation, pauses
the original automatic client, and opens a separate source using the normal
provider and credential cache. That source synchronizes, writes and reconnects
after reopening its cache while original offline edits remain local. This is
generation-rotation evidence. The separate actual application cold-restore and
rollback rehearsal now verifies CRDT/comment/picture/ACL preservation. The HTTP
inventory fixture additionally verifies selected claims/moves/activity, refusal
of an empty original-generation selection, and persisted inventory reopening.

Paused-share recovery now discovers and exports matching source namespaces as
[separate generation histories](managed-recovery-backup-preview.md), including
their own buffers and private inventories. Identity and catalog changes during
capture require a retry.

Remaining integration includes the reviewed activation decision and durable
selection journal, automatic folder/document/buffer selection, native file
replacement, and draining or isolating older workers
that still know original vault paths. Cache names alone cannot stop an old
window writing a native file. Production maintenance/admission/cutover, original-request
reconciliation and desktop/mobile acceptance remain required.

The inventory increment passes 183 focused tests, the actual disposable HTTP
restore fixture (four tests), and the full plugin regression (3,987 tests across
285 suites; 40 tests/26 suites skipped). Main types, changed-source lint and the
production preview build pass with 15 existing build warnings. The test-type
ratchet remains 205 errors/44 existing signatures against the frozen 207/46
baseline. These checks use fake IndexedDB and the actual HTTP boundary; they do
not substitute for native IndexedDB, two-client or mobile acceptance.
