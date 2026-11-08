# Read-only attachment inspection

Recovery inspection requests a fresh `read_only: true` file grant. It bypasses
ordinary attachment credential caches, server mappings and renewal queues, so an
owner's cached synchronization credential cannot become a recovery credential.
The server response must explicitly acknowledge read-only support, restore
guarding and the requested generation; old or mismatched responses fail closed.

The server signs the read-only restriction and, for managed shares, the observed
restore generation, including an explicit null for the original generation.
Both upload-URL issuance and direct content uploads reject these grants even for
owners. HEAD, download-URL and content reads recheck current membership, entry
access, login session and generation. Object reads run outside the database lock;
authority is checked again before returning their result. Normal file grants
retain their existing request-bound write behavior.

The client freezes the requested generation before authentication and checks the
account/server/caller context before transmission and after asynchronous response
parsing. Inspection responses and transport failures do not enter network body
diagnostics. A caller-supplied context check fences cancellation; the eventual
download coordinator must supply a deadline and discard late results.

This is the credential boundary, not a completed native recovery downloader or
activation UI. The current Obsidian `platformFetch` adapter buffers responses
through `requestUrl`; a streaming transport or another genuinely bounded transfer
mechanism is still required before the staging download adapter can promise
receive-time limits. The ordinary attachment synchronization path is unchanged.

Validation includes managed and legacy grants, owner/read-only member access,
both upload paths, explicit null and restored generations, permission/session
changes during object reads, strict boolean parsing, fresh grant/cache isolation,
account changes during response parsing, cancellation before transmission and
sanitized failures. The actual plugin/loopback HTTP/MinIO fixture downloads the
chosen revision and verifies both owner upload attempts return 403 with no extra
objects. All fixture resources are removed after the run.

The focused server suite passes 60 tests; client credential/context checks pass
43. The full plugin regression passes 4,338 tests in 300 suites (41 tests and
27 opt-in suites skipped). Main types, changed-source lint, unchanged test-type
ratchet (205 errors/44 signatures versus 207/46) and production preview build
pass, with 15 existing build warnings.
