# Exclusive local staging I/O

`createSourceInstallationHostIO` implements staging's filesystem contract using
an explicit host capability for exclusive directory/file creation. It is not a
wrapper around raw Obsidian `createFolder`/`createBinary`: the installed Obsidian
1.13.7 implementation checks existence separately from the subsequent write, so
it cannot establish exclusion against a competing creator.

Reads stay within the local recovery directory. Writes are restricted to fixed
plan, inventory, source-history and native-byte artifacts beneath a random staging
root exclusively created by this adapter instance. Existing files are never
overwritten. A newly opened adapter can verify older staged files but cannot
claim or rewrite their directories. Input bytes are copied before asynchronous
work. Native mutation tracking uses the actual host/vault owner, so existing
recovery holds can fence and drain these operations.

`createDesktopSourceInstallationIO` supplies that capability for desktop
`FileSystemAdapter` vaults. It loads Node filesystem built-ins only after the
desktop capability check, uses non-recursive `mkdir` and `open("wx")`, flushes
file contents and closes handles. It captures the vault adapter/path and checks
the resolved root identity; linked or non-directory recovery parents are refused.
It uses public vault metadata and ordinary filesystem APIs, without calling
undocumented Obsidian adapter methods. Filesystem watching may discover the new
local recovery artifacts asynchronously; verification reads actual disk bytes.

These checks do not provide an OS lock against another process replacing a
directory between checks and a filesystem call. The installation coordinator's
writer-isolation and final verification requirements still apply. Native
Obsidian acceptance is pending while the Mac is locked. Mobile/non-filesystem
adapters are refused by the desktop factory; a verified mobile equivalent is
still needed. No native destination or activation path is enabled here.

Thirty-three focused host/staging checks pass with real temporary filesystem
operations. They cover concurrent creation, refusing existing files and symlink
targets, reopened read-only ownership, invalid paths, native holds, copied input
bytes, late context changes, replaced vault roots and unsupported hosts. The
production desktop adapter also stages and verifies a complete source plan while
preserving the original native note and leaving its new destination absent.
Main types, changed-source lint, the unchanged test-type ratchet and an isolated
browser-target bundle pass. The ratchet remains 205 errors/44 signatures against
the frozen 207/46 baseline. No live vault was modified for these checks.
