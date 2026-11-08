# Separate source histories for restore generations

The source-cache API now opens a separate IndexedDB history for a selected
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
document and generation before token use. A restored provider attached to a
legacy unbound cache is refused. The normal automatic `Document` and
`CanvasDocument` paths still select their original lineage and remain paused
after a restore; this change does not migrate their data or enable a Resume
button.

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
generation-rotation evidence, not a full backup/restore of server bytes.

Remaining integration includes the reviewed activation decision, separate folder
inventory and source-buffer selection, recovery discovery/export of all new
namespaces, native file replacement, and draining or isolating older workers
that still know original vault paths. Cache names alone cannot stop an old
window writing a native file. Coherent service backup/restore, original-request
reconciliation and desktop/mobile acceptance remain required.
