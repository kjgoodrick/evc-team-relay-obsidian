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
common Windows filename hazards. Unpaired surrogates are rejected so encoding
cannot silently alias another filename. Path components are limited to 255 UTF-8
bytes, relative paths to 2,048 bytes and combined native destinations to 4,096
bytes. A component tree checks aliases and file/directory collisions in either
entry order without constructing every full prefix repeatedly. It is bounded to
100,000 distinct nodes and 1,000,000 visited components per plan. Plans are limited
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

The verifier also checks content semantics in isolated Yjs documents. Updates
with missing insertion/deletion dependencies fail. A fresh inventory builder
uses only the captured visible records, permissions, activity and explicit
restore generation. It omits optional old deletion/Bases catalogs; ordinary sync
fetches current catalogs again. Verification requires exact agreement among the
file records, flat Markdown index, activity and stored server snapshot, and
rejects unknown roots or pending restore/conflict state. Native Markdown bytes
must match the staged editing history's exact UTF-8 projection. Canvas uses the
same export helper as live saves and requires the same native bytes. It never
merges retained local updates into the staged history.

These documents have no providers, persistence, awareness or native writers and
are destroyed after inspection. Applying a bounded Yjs update is synchronous;
the 16 MiB limit is not a hard CPU/heap deadline. Worker isolation and physical
mobile/resource measurements remain to be evaluated for larger histories.

The verifier is read-only and returns data, not activation authority. It proves
artifact integrity and internal content consistency, not current server
permission/generation, trusted download provenance or stopped writers. A
[staging primitive](source-installation-staging-preview.md) now builds and verifies
artifacts in a new directory through an exclusive-creation adapter contract.
[Bounded downloads](source-installation-downloads-preview.md) and an
[exclusive desktop staging adapter](source-installation-host-io-preview.md) are
implemented. A [resumable native installer](source-installation-materialization-preview.md)
now copies verified plans to new desktop folders while keeping sync paused.
Cache/mapping activation and user-facing integration still need connection.
Every write must recheck the journal,
destination isolation and bytes; an earlier verification cannot prevent later
filesystem changes.

The artifact-format checkpoint passed 119 focused installation-plan/archive/
journal tests with real
temporary files and IndexedDB journal reopen. Cases include corrupt/missing/
directory artifacts, changed associations, bad recovery archives, resource
bounds, late completion after cancellation, stalled reads, changing context,
manifest replacement, popout buffers, empty inventories and preservation of the
original native file. Main types, changed-source lint, build and the unchanged
test-type ratchet pass (15 existing build warnings). Native desktop/mobile and
full installer acceptance remain pending; no activation UI is enabled here.

Content checks additionally cover malformed and incomplete updates, changed
inventory maps, wrong/unsupported restore generations, missing or denied access,
unknown activity, exclusion of old optional catalogs, exact Markdown/Canvas
projection, and integrity-valid artifacts with inconsistent content. The tests
exercise both the pure validators and restart verification through real files.

The combined content-verification checkpoint passes the full plugin regression:
**4,297 tests across 298 suites**, with 41 tests/27 opt-in suites skipped. Main
types, changed-source lint, build and the unchanged test-type ratchet pass
(205 errors/44 signatures against 207/46; 15 existing build warnings).
