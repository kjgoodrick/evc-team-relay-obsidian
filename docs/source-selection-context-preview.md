# Journal-selected source constructors

`SourceSelectionContext.open(scope)` reads one durable journal choice before
constructing a folder session. Any pending review, preparation or installation
refuses an active context. The input scope, active choice, revision and generation
are captured independently of caller mutations. Foreign folder/child addresses
and server IDs are rejected. A failed current-journal check latches that session
unavailable; cancelling the review requires a fresh session with the new revision.

An explicitly supplied context now reaches `VaultShare`, `Document`,
`CanvasDocument` and `ProviderBacked`:

| State | Inventory, source and buffer behavior |
| --- | --- |
| Legacy choice | Retains existing inventory/document/Canvas, upload-claim and buffer keys; captured verification metadata still checks the current server endpoint. |
| Committed source choice, including null generation | Uses identified inventory and Markdown/Canvas histories, separate upload claims and a generation-specific Markdown buffer key. |
| Pending journal | No active context is constructed. |
| Journal revision changes during a session | The next durable check rejects and disconnects the provider; reopening is required. A change during token acquisition rejects its late result. |

Child generation comparisons use the immutable selected generation instead of
pausing every non-null parent snapshot. Cache identities still gate provider
tokens, and identified caches require explicit selection. An empty saved buffer
is real content; it no longer falls back to older native bytes. Failed buffer
reads also propagate instead of pretending the buffer is missing. Existing
asynchronous buffer save/clear error presentation remains separate follow-up work.

Synchronous descriptor helpers let constructors choose their namespace before
opening persistence. They hash only bounded identity metadata with the existing
`lib0` SHA-256 implementation; document and inventory names/identity formats stay
byte-compatible with the prior WebCrypto implementation. A browser bundle test
selects the pure browser implementation and compares its hashes to WebCrypto for
both namespaces, null/non-null generations, Unicode and maximum-length vault IDs.
No file-content hashing is moved onto the synchronous constructor path.

This is explicit constructor integration, not automatic startup or installation.
The main factory still omits the context. It must first become able to await a
journal read for restored and newly connected shares, handle blocked/corrupt
journals in the UI, recheck current configuration and dispose contexts correctly.
Direct and retained grant-renewal callbacks now recheck the journal before
applying a selected token; token requests await their initial callback and reject
late results. An already-connected socket or another window is not continuously
fenced by occasional journal reads. Complete network/native writer
quiescence, shared admission coordination, verified installation artifacts and
startup handling must be connected before activating the restore action. These
APIs do not verify native files or permit a pending journal to be committed.

The full regression passes 4,076 tests across 290 suites (40 tests/26 suites
skipped). Main types, changed-source lint and the preview build pass (15 existing
build warnings); the frozen test-type ratchet remains 205 errors/44 signatures
against 207/46. Focused checks include actual Markdown/Canvas construction,
separate histories across reopen/later selection, late token results, endpoint
changes, pending phases, namespaced empty buffers and browser digest compatibility.
Canvas here is existing source-sync recovery; Canvas comments remain out of scope.
