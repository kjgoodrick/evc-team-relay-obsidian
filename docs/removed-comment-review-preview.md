# Administrative removed-comment review preview

November 7, 2026. Moderators can explicitly inspect retained removed comments
through an audited online review. Ordinary discussion/history/picture views keep
the removed-content boundary for every role. This preview does not restore
comments or recreate erased data. Native Obsidian/mobile acceptance remains.

## Workflow

With both server recovery capabilities enabled, readable note/image/saved Bases
scopes show **Review removed comments** for a current moderator. A deleted-message
tombstone also offers **Review removed comment**. The review requires a plain-text
reason before making any request. Merely opening it performs no recovery read.

The inventory shows removal metadata, author and retention deadline. Selecting
**Review history** loads up to ten immutable rich revisions, with actor/timestamp
and removal reasons. First/next controls and a revision-number field navigate
without retaining prior pages. Inventory pages scan up to twenty candidates;
an empty eligible page can still have a next page. Restart the inventory to find
an older message removed since the current scan began.

Pictures appear as explicit **Review picture** buttons. Each click makes audited
metadata and thumbnail requests; **Review full-size picture** makes fresh
metadata/content requests. Only one decoded picture is held at a time. Ordinary
picture loaders, downloaded caches, saved drafts and the outbox are not used.

## Access and lifecycle

Each page/file request is a POST with the supplied reason and gets a distinct
server audit ID, which the review displays. A lost response can still leave a
committed audit. There are no automatic recovery retries or polling. Server
authorization and audit commit are required independently for every request.
The inventory itself returns no body, anchor or removal reason.

Responses must identify the requested entry, saved view, thread/message and
picture, and advertise `no-store`. Picture bytes require an audit header plus
the expected hash, MIME type and byte count. Requests recheck their visible
review/account context after credential refresh and before disclosure. The
session also fences authentication and local scope-generation changes.

The current page and decoded picture clear on hiding the document, losing known
access/online status, switching target/account, editing the reason, an unavailable
read or closing the review. An open page expires after two minutes or at its
retention deadline, whichever is sooner. Start again for a fresh authorized
review. Clearing the UI releases picture URLs, timers and subscriptions. It is
not forensic erasure of already delivered bytes or user-made copies.

Bases inventories remain tied to the selected saved view. Current target
dependencies still authorize individual reads. A removed thread whose target
has already been purged cannot be listed or recovered. The preview provides no
cross-vault recovery, restoration, private threads or offline recovery browsing.

## Verification

The focused client suite passes 142 tests, covering explicit reason gating,
scoped/audited responses, bounded pagination, permission/authentication/cache
generation races, delayed reads, no ordinary-cache/outbox writes, explicit
picture loading, URL release, two-minute expiry and absence of automatic reads.
All 3,421 plugin tests in 257 suites pass; 29 tests in 20 opt-in suites skip.
Build/main types pass with the 15 existing warnings. Changed-source lint passes;
test types remain 206 errors across 45 signatures against the frozen 207/46
baseline, with no new signatures.

Actual TypeScript/HTTP tests exercise the session's inventory/history paths and
reader denial. Actual HTTP/MinIO tests verify the typed metadata/byte paths and
subsequent SQL purge/object reclamation. PostgreSQL verifies the inventory query
and committed metadata audit alongside recovery transaction/revocation behavior.
Disposable services and containers stop/remove themselves after these drills.
Native checks could not start because the Mac was locked; this is implementation
and automated evidence, not native desktop/mobile acceptance or production rollout.
