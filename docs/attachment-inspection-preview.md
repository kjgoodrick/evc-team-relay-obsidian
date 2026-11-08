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

`readManagedAttachment` now consumes the fresh grant using an abortable streaming
GET, with no ordinary attachment object, local write, upload or cache renewal.
It requires the exact configured endpoint/share/file, refuses redirects and
omits cookies/referrers. It checks the captured account/server/caller context and
grant expiry while reading, bounds decoded bytes to the caller's budget and the
server's 25 MiB attachment limit, and verifies SHA-256 before returning content.
Identity responses with a declared length must match it exactly; compressed or
chunked responses grow a bounded buffer and still verify the decoded digest.
Timeout/cancellation abort the request and release its reader; late credentials
or responses cannot deliver content. Server inspection content uses `no-store`.

This helper is not connected to native recovery preparation/activation yet.
Its default streaming `fetch` requires a host with streaming support and a server
CORS configuration allowing that native host's origin. Those desktop/mobile
conditions still need verification; no origin policy or live configuration was
changed. The current Obsidian `platformFetch` adapter buffers responses through
`requestUrl` and cannot substitute for this helper's streaming transport. There
is no buffered fallback. The ordinary attachment synchronization path is unchanged.

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

The subsequent streaming helper adds coverage for exact and unknown lengths,
compressed decoded bytes, a larger multi-chunk body, empty files, digest
mismatches, byte limits before/during reads, refused/redirected URLs, expired
grants, cancellation during authentication, stalled/late responses and account
changes while reading. The real HTTP/MinIO fixture also exercises the helper's
successful selected-revision download and a lower caller-budget refusal.
