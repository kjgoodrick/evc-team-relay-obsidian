# Current-state discussion synchronization

Capable servers now supply a complete current-state baseline before normal
change polling. Initial sync and expired-cursor recovery avoid replaying every
historical edit to reconstruct current comments. `DiscussionSession` negotiates
the independent `discussion_snapshot` capability; old servers keep event replay.

The baseline is checked against the exact entry/saved view and observed server
restore generation. Its remote cache and catch-up cursor commit atomically.
Original pictures, drafts and queued work stay intact. Downloaded pictures for
the affected scope are cleared, stale cache writers are fenced, and newer reads
or removal tombstones survive a baseline captured earlier. Permission revocation
clears remote data while retaining unsent work. Cursor reset reauthorizes first.

Responses are bounded to 8 MiB and 5,000 thread/message records. Fetch streams
cancel when over budget; Obsidian's native HTTP adapter can materialize a response
before the plugin checks its size. An explicit disabled/too-large response falls
back to retained events. Other failures retain normal retry, authentication or
unavailable behavior. No event pruning is enabled by this change.

See the [server contract, limits and verification](../../evc-team-relay/docs/discussion-snapshot-preview.md)
for protocol and integration details. Native/mobile acceptance and larger
resumable baselines remain pending. This is synchronization cache replacement,
not a file-history activation or permission to resend saved operations.

Validation: 4,218 plugin tests across 296 suites pass (41 tests/27 opt-in suites
skipped), including 64 focused snapshot/transport tests. Main types, changed-source
lint, production build and the unchanged test-type ratchet pass. The build has 15
existing warnings; test types remain at 205 errors/44 existing signatures against
the frozen 207/46 baseline. The separate real HTTP snapshot scenario also passes.
