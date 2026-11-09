# Resumable file operations at the existing path

`applyDesktopSameFolderFileOperation` adds the desktop filesystem step needed by
same-folder recovery. It can create a file, replace a reviewed file, or remove a
reviewed file while retaining its original inode in recovery storage. This is an
internal primitive, **not a complete recovery action or an enabled UI**.

The descriptor binds an operation UUID to the selected plan ID/digest, review ID,
native root, relative file path, and exact before/after sizes and hashes. Both
absent and identical before/after states are refused as non-operations. Paths and
artifacts use the source-plan limits. The coordinator must separately verify the
selected plan, original-work archive, reviewed decisions, current access and
applying source-selection journal; a descriptor alone grants no write authority.

## Publication and restart

The caller supplies an already-drained native write hold and a context/isolation
check. The entire operation is awaited inside that hold. It never imports caches,
changes mappings, releases source admission or starts a provider.

1. Validate and copy replacement bytes before touching the filesystem.
2. Create or reopen an operation directory beneath the existing staging area:
   `Source installations/<plan UUID>/native-operations/<operation UUID>`.
   `intent.json` binds the descriptor and vault/root/parent/control-directory
   identities. A missing, corrupt or mismatched intent is not adopted.
3. Durably stage the selected bytes in `after.bin`. No-follow reads check content,
   identity and timestamps; writes flush the file and containing directory.
   A replacement retains the original file's ordinary permission bits.
4. Check the current file against the reviewed before-state, then rename its
   actual inode to `before.bin` and flush both affected directories. Recheck its
   content after capture. It is never automatically deleted by this primitive.
5. Publish the staged inode at the original path using an exclusive hard link.
   A file arriving at that path prevents publication instead of being overwritten.
   A removal leaves the original only in recovery storage.
6. Flush the destination directory and durably record its inode in
   `published.json`, then remove the extra staging link. Metadata uses temporary
   writes and exclusive publication; recognized private leftovers can be
   reconciled after restart.

Saved state and filesystem evidence distinguish interruption before capture,
after capture, after publication, after receipt, and after staging-link removal.
A native file sharing the staged inode proves interrupted publication; equal
content in an unrelated inode does not. An exact receipt retry verifies the
published identity/content and preserved original without republishing anything.
Later edits, replacements and deletions cause a stop and remain untouched.
The complete coordinator must retain its separate rule that an already committed
whole-folder activation reconciles only its receipt, without reinstalling files.

## Limits that the coordinator must handle

Capture followed by exclusive publication can briefly leave the native path
absent. This is not an atomic whole-folder swap or a transparent editor save.
Editor buffers, watchers and old instances require coordination before exposing
the flow. Parent directories must already exist. The [saved whole-folder review](same-folder-review-preview.md)
now defines operation order, including directory creation/removal, renames, case
changes and file/directory transitions. Their physical execution and final tree
and retained-original verification now have a [native coordinator](same-folder-materialization-preview.md);
same-root activation and editor handoff remain separate unfinished work.

If an untracked writer changes the original at the capture boundary, the actual
new inode/bytes are retained in `before.bin`, verification fails, and the selected
content is not published. The original path may remain absent. The recovery UI
must show the retained work and offer an explicit recovery/review path, not claim
success. If another file appears after capture, both that file and the retained
original remain available. An external editor holding the old inode may still
write to the retained file; this implementation cannot lock arbitrary processes.

Same-realm native holds cover registered plugin writers. They do not establish
production server maintenance, isolation from other windows/processes, or a
cross-process filesystem lock. Identity/link checks detect ordinary changes;
they cannot make arbitrary parent replacement between system calls impossible.
The owner must keep recovery fenced while an OS write is in flight. Cancellation
or context loss does not release the hold before the admitted operation settles.

There is no fallback to overwriting a conflicting destination or copying across
filesystems. Unsupported/mobile hosts, unsafe links, absent parents, changed
ownership, damaged control files and exhausted storage fail with available work
retained. An ambiguous operation directory without a valid intent needs review.
The retention files use `.bin`, but the older full recovery archive still needs
private packaged storage to avoid duplicate indexed notes.

## Evidence and remaining integration

Real temporary-filesystem tests cover create/replace/remove/empty content;
original inode and permission preservation; each restart boundary; owned
temporary links; unexplained intent links; changed originals; racing external
changes; occupied publication paths; disk/publication failures; context loss;
later native edits/replacements/deletions; registered-writer fencing; symlinks,
hard links and directory conflicts; changed review/root; corrupt receipts; and
invalid operations or hosts.

The actual HTTP/Rust restore fixture downloads and verifies the selected source,
prepares a separate disposable client's same-folder journal and immutable review,
enters `applying`, and applies all operations in that file/directory review using
the production native coordinator. It verifies retained original files and
directories, selected native bytes, ordered journal progress and retry protection for
a later local edit. The journal remains `applying`; this is not evidence that
the complete folder is ready for activation. The HTTP/MinIO fixture runs the same
proof with actual managed attachment downloads.

The file-operation checkpoint passes **35 focused native-operation tests** and **4,657
tests across 311 suites** in the full regression (41 tests in 27 opt-in suites
skipped). Main types, changed-source lint, browser bundles and the production
preview build pass, with 15 existing warnings. The test-type ratchet remains
205 errors/44 signatures against the frozen 207/46 baseline. Immediate external
replacement/deletion after publication is covered: the receipt keeps the inode
actually published, and retry preserves the later change rather than adopting
an unrelated inode or recreating a deleted file.

Durable review binding and ordered completion metadata now have their own
[implementation and evidence](same-folder-review-preview.md). Directory execution
and complete-tree verification now have [coordinator evidence](same-folder-materialization-preview.md).
Next: ambiguous-operation/local-edit recovery, private archive storage, same-root cache/editor/
registry handoff, recovery UI, and native desktop/mobile acceptance. No live
vault or production service has been changed.

Related: [same-folder preparation and comparison](same-folder-source-inspection-preview.md),
[source activation](source-installation-activation-preview.md).
