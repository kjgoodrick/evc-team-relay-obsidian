# Source installation plan artifacts

`SourceInstallationPlan` adds a versioned, hash-bound staging manifest for the
recovery coordinator. Its ID and SHA-256 fit the existing selection journal's
prepared-plan reference. It records the exact review, vault/server/folder source
identity and restore generation, original-work recovery archive, original root,
proposed new root, inventory update, file records, native bytes and editing-history
artifacts. It has no credentials or transient login identity.

The first format supports a **new folder** disjoint from both the original folder
and the local recovery directory. This is the working restore default while the
optional destination preference is reviewed. It cannot represent replacement of
an existing folder. A vault-root original needs a separate destination/vault flow
and is refused by this format. The coordinator still must establish that the
proposed destination is new and isolated; a path in a plan does not prove that.

Native paths are validated separately from artifact locations. Staging always
uses `Relay Recovery (local only)/Source installations/<plan UUID>` with
`plan.json`, `inventory.yjs`, `files/<entry UUID>.bin`, and
`sources/<entry UUID>.yjs`. Untrusted native paths never select staging files.
Markdown/Canvas records require both native and source artifacts; attachments
require native bytes whose digest agrees with their inventory hash. Folder
records cannot carry file bytes. This covers existing sync formats; it does not
add Canvas or PDF commenting.

Validation rejects duplicate identities, unknown fields/versions, missing source
generation, noncanonical endpoints/IDs, unsafe paths, Unicode/case aliases in
files or parent directories, file/directory collisions, hidden/system paths and
common Windows filename hazards. Path components are limited to 255 UTF-8 bytes;
whole native destination paths are bounded to 4,096 characters. Plans are limited
to 10,000 entries and 16 MiB JSON, each source/inventory update to 16 MiB, each
native artifact to 256 MiB and all staged bytes to 64 GiB. Larger inputs need a
future streaming path; they cannot silently create a partial installation plan.

`encodeSourceInstallationPlan` snapshots and validates input before its first
asynchronous operation and returns bytes plus an immutable digest reference.
It does not write a manifest. `verifySourceInstallationPlan` reopens against the
separately retained journal reference and checks the expected source, review and
archive. It re-verifies the original-work archive, checks each staged artifact's
stat/size/digest sequentially, and checks the plan again at the end. Extra files
are ignored. Storage/hash operations have a 30-second timeout (lowerable), caller
context checks and cancellation; popout ArrayBuffers are supported.

The verifier is read-only and returns data, not activation authority. It proves
artifact integrity, not complete Yjs dependencies, agreement between native text
and editing history, current server permission/generation, or stopped writers.
Those semantic checks, exclusive staging publication, the native installer,
resumable installation and user-facing activation still need connection. Every
write must recheck the journal, destination isolation and bytes; an earlier
verification cannot prevent later filesystem changes.

Verification: 119 focused installation-plan/archive/journal tests pass with real
temporary files and IndexedDB journal reopen. Cases include corrupt/missing/
directory artifacts, changed associations, bad recovery archives, resource
bounds, late completion after cancellation, stalled reads, changing context,
manifest replacement, popout buffers, empty inventories and preservation of the
original native file. Main types, changed-source lint, build and the unchanged
test-type ratchet pass (15 existing build warnings). Native desktop/mobile and
full installer acceptance remain pending; no activation UI is enabled here.
