# Pocket ID presence pictures (0.2.4)

The file-title presence stack and its active-user list now use the profile
picture supplied by the share's own authenticated account. Initials remain
visible while loading and when a picture is absent, unreachable or rejected.
The picture URL travels in transient document awareness, not the note contents.

The matching server change is
[`7afb42bfa7ea82e18bc38c0133211e1115dd3780`](https://github.com/kjgoodrick/evc-team-relay/commit/7afb42bfa7ea82e18bc38c0133211e1115dd3780).
It returns name/picture in native OAuth completion and `/v1/auth/me`, and updates
the matching provider/subject's display metadata on subsequent sign-in. No
database migration or permissions change is required. The plugin loads an
existing session's profile on startup without requiring another sign-in; a
failed or timed-out lookup retains the saved profile and session.

## Automated verification

- Full plugin suite: 1,402 tests passed in 137 suites; the real-stack test is
  separately gated and passed against the actual FastAPI/Rust relay.
- Real-socket checks include picture delivery, replacement and removal between
  independent clients, alongside existing collaboration and permission checks.
- Production Svelte components are compiled and mounted in a DOM test covering
  image loading, error fallback, changing a failed URL, the active-user popover,
  unsafe URL rejection and cleanup. These assertions simulate load/error events;
  they do not prove that a browser downloaded or decoded an image.
- Saved-profile lookup, persistence, token refresh, offline startup and late
  timeout responses are covered. Profile changes do not mutate document history.
- Backend: 70 tests passed across native OAuth, existing OAuth and auth/share
  tests, including metadata refresh/removal and user/provider isolation.
- Production TypeScript/build passed; Svelte type checking has zero errors.
  The test type gate has no new errors beyond the inherited baseline.

## Browser harness

Run `node tests/presence/serve.mjs` with the project's dependencies installed.
It bundles the actual `CollaboratorAwareness`, `AvatarStack`, `UserPopover` and
`PresenceAvatar` components with the production Svelte configuration, uses real
Yjs awareness and includes production plugin CSS. It serves only
`http://127.0.0.1:4177/`; stop the other mobile harness first if it uses that port.
After edits run `node tests/presence/serve.mjs --build-only`, then reload.

The harness supplies seven synthetic identities, a generated SVG portrait,
missing/broken image cases and a long display name. The only substituted host
global is Obsidian's `activeDocument`, mapped to the page document; these
components import no other Obsidian APIs. Results/errors are displayed and saved
in localStorage. No real credentials, profiles or vault files are used.

Tap the stack to open the list; check scrolling, image cropping, display-name
overflow and picture replacement/removal in portrait and landscape, light and
dark appearance. `Run checks` exercises browser image decoding and fallback.
There are no changed forms, date/time inputs, drag actions or persisted editor
drafts in this feature. Image/profile updates have no Undo action.

Actual Obsidian integration and iOS Simulator visual checks are pending access
to the unlocked Mac. A standalone Safari pass would cover WebKit with a
substitute host, not native Obsidian on iPhone. Native plugin loading, vault
access, background/resume and device performance remain separate checks.
