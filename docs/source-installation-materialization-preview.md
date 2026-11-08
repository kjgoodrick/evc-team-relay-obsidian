# Resumable native source installation

`materializeSourceInstallation` connects a prepared source-selection journal to
real files in the planned **new folder**. It verifies the saved plan, original-work
archive, source histories and native projections before copying. It confirms the
exact journal revision around each operation, holds and drains registered writers
for both the original and destination folders, and moves the journal to `applying`
before any native destination mutation.

The original folder and its retained source artifacts stay unchanged. This step
does **not activate synchronization**: the journal remains `applying`, and ordinary
source admission stays closed. Importing the selected source caches, changing the
shared-folder mapping, checking current server admission/generation and committing
the selected source still belong to the activation coordinator.

## Desktop filesystem behavior

`createDesktopSourceMaterializationIO` requires a desktop `FileSystemAdapter` and
native no-follow file opens. It loads Node built-ins only after checking the host.
Obsidian's separate existence-check/write APIs are not used. Native operations
must run through the materialization coordinator's write hold.

The destination parent must already exist. The destination itself is created
exclusively, then receives a hidden `.relay-source-installation/owner.json` marker
bound to the plan digest, review, source scope and exact destination. The plan
format already excludes hidden native source paths, so this metadata cannot
collide with a restored entry. It contains no credentials or comment content.

Each file is written to a UUID-named temporary file in that ownership directory,
flushed and closed, then published with an exclusive filesystem hard link. The
temporary link is removed and relevant directories are flushed. Existing final
paths are never replaced. A filesystem without hard-link or directory-flush
support fails explicitly; there is no overwrite fallback. Reads use bounded
buffers and no-follow opens; directory enumeration has a count limit.

On restart, the exact ownership marker is required. Only recognized regular
temporary files beneath that verified directory may be reclaimed. This covers a
crash during temporary writing and between link publication and unlink. Existing
final files must match the plan's size and SHA-256 before being reused. Unexpected
files/folders, changed bytes, symlinks, unexplained extra hard links, replaced
directories and changed vault identity stop installation without replacing the
content. Implicit parent directories and explicit empty folders are preserved.

A crash between exclusive root creation and a durable marker leaves an ambiguous
folder. It is intentionally not adopted, even if empty. It must be preserved and
a new destination selected through the recovery flow; that flow is not wired yet.
The ownership directory remains after materialization. Cleanup after activation
must be part of the final coordinator, not inferred from successful copying.

## Cancellation and isolation

Cancellation/context checks run around filesystem operations. An admitted native
mutation is awaited rather than raced against cancellation: its write holds are
released only after it settles. A partial new folder remains available for
inspection and restart, while the durable applying state keeps ordinary sync
paused. A lost journal-start response requires reading the saved journal before
retrying; copying is not started after an uncertain response.

Registered holds cover this plugin in one host realm. They do not lock other
processes, older plugins or arbitrary native editors. The final user-facing
coordinator must establish their isolation before materialization/activation.
Filesystem identity and link checks detect ordinary changes but are not an OS
lock against a concurrent process replacing a parent between system calls.
Native writes may wait for the filesystem to settle; cancellation cannot undo
an OS write already in progress.

## Verification and remaining integration

Real temporary-directory tests exercise new installation, journal/adapter reopen,
lost file-completion responses, publication failure, temporary-file crash cleanup,
changed content, destination collisions, ownership mismatch, symbolic/hard links,
vault/destination replacement, staged corruption and cancellation with both write
holds retained. The tests check original bytes and the still-paused journal.

The full regression checkpoint passed 4,454 tests across 306 suites (41 tests in
27 opt-in suites skipped). The final focused suite passes 21 tests, including an
additional lost journal-start response case and the final open-file identity
check. Main types, changed-source lint, unchanged test-type ratchet, production
preview build and an isolated browser bundle of the desktop installer pass. The
existing 15 production-build warnings remain.

Native Obsidian acceptance, mobile exclusive installation, selected-cache imports,
mapping activation, restart UI, external-writer isolation and final server
admission remain unfinished. This module is not enabled by a user-facing action.
