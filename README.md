# Team Relay permissions preview

Experimental self-hosted fork of EVC Team Relay. It adds server-enforced file/folder permissions and a browser-based Pocket ID sign-in flow for Obsidian desktop/mobile APIs. It also recovers safe inventory conflicts automatically and provides a persisted conflict queue with verified local backups for decisions. Physical mobile validation is still pending.

Download the tested [0.2.2 plugin ZIP](https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/download/0.2.2/team-relay-sync-permissions-preview-0.2.2.zip) from the [GitHub prerelease](https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/tag/0.2.2). It contains the exact tested bundle, with published SHA-256 checksums and installation notes.

Use the matching [server fork and setup guide](https://github.com/kjgoodrick/evc-team-relay/blob/main/docs/permissions-preview.md). To build from source, run `npm ci --ignore-scripts` followed by `npm run build:preview`. Start in a disposable vault. This retains the upstream plugin ID, so it replaces the original plugin within that vault.

The guide records the security model, test coverage, and known preview limitations. The upstream documentation follows; legacy publishing and agent-key features are unavailable for managed shares.

Preview 0.2.2 includes mobile layout/draft fixes and stable Yjs inventory client IDs. See the [mobile verification report and screenshots](tests/mobile/results/2026-11-03/README.md) and [reusable Simulator harness](tests/mobile/README.md). Desktop Obsidian mobile emulation and iOS Simulator Safari passed the documented checks; native Obsidian on a physical phone remains unverified.

---

# Team Relay Sync

[**Download the permissions-preview prerelease →**](https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/tag/0.2.2)

**Real-time collaboration and web publishing for Obsidian.**

> Edit notes together. Share folders with your team. Publish to the web. Self-hosted or hosted — your choice.

---

## The Problem

You love Obsidian, but your team needs more:
- **Sharing a note** means exporting, copy/pasting, or screenshotting
- **Collaborating** means switching to Notion or Google Docs
- **Publishing** means paying $8/month for Obsidian Publish with limited control
- **Git sync** works until two people edit the same file

## The Solution

**Team Relay** adds multiplayer mode to Obsidian. CRDT-based real-time sync — no merge conflicts, works offline, your data stays on your server (or ours).

---

## What You Get

### 🔄 Real-time Collaboration
- Edit the same note simultaneously — changes merge automatically
- Share entire folders with viewer or editor permissions
- Works offline — edits sync when you reconnect

### 🌐 Web Publishing
- Publish notes as a website with one click
- Three modes: **public**, **protected** (link + token), **private** (login required)
- Custom domains supported
- Perfect for: internal wikis, client portals, project docs, personal sites
- [Live example →](https://docs.entire.vc/team-relay/Demo)

### 🔒 Your Data, Your Server
- **Self-hosted:** deploy on your VPS with Docker Compose ([server repo](https://github.com/entire-vc/evc-team-relay))
- **Hosted:** zero ops, connect and go ([entire.vc](https://entire.vc))

---

## Install

1. Download the [tested 0.2.2 ZIP](https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/download/0.2.2/team-relay-sync-permissions-preview-0.2.2.zip).
2. Unzip it and copy the included `team-relay-sync` folder into
   `<your vault>/.obsidian/plugins/`. The plugin folder must contain `main.js`,
   `manifest.json` and `styles.css`.
3. Restart Obsidian and enable **Team Relay Sync (permissions preview)** under
   *Settings → Community plugins*.
4. Add your control-plane URL in the plugin settings, leave the optional relay
   URL blank, and sign in. To join an existing share, choose **Shares → select
   share → Connect to local folder** and select the local vault root (`/`).

The [release page](https://github.com/kjgoodrick/evc-team-relay-obsidian/releases/tag/0.2.2)
also provides the three individual installation files and `SHA256SUMS`.
The community-directory version is the upstream plugin and does not contain
this fork's permissions and recovery changes. Keep automatic upstream updates
off for this pilot.

---

## Quickstart

1. **Connect:** Plugin settings → Add server → enter your relay URL (or sign up at [entire.vc](https://entire.vc))
2. **Share:** Right-click a folder → Share → invite by email
3. **Collaborate:** Open a shared note — edits sync in real-time
4. **Publish:** Right-click a note or folder → Publish to web

---

## Who Is This For?

### Small Teams (5-20 people)
Replace Notion/Confluence. Keep Obsidian. Real-time collaboration without $8/user/month.

### Consultants & Freelancers
Share deliverables with clients via protected web publish. No "can you export that as PDF?"

### Dev Teams
Documentation that lives in Obsidian, accessible to the whole team. Pair with [Local Sync](https://github.com/entire-vc/evc-local-sync-plugin) for repo `/docs` ↔ vault sync.

### Content Creators
Publish your vault as a beautiful website. Better than Obsidian Publish — custom domains, access control, flat pricing.

---

## Comparison

| | Obsidian Sync | Notion | Google Docs | **Team Relay** |
|---|---|---|---|---|
| Real-time collab | ✗ | ✅ | ✅ | ✅ |
| Works in Obsidian | ✅ | ✗ | ✗ | ✅ |
| Web publish | via Publish | ✅ | ✅ | ✅ |
| Self-hosted option | ✗ | ✗ | ✗ | ✅ |
| Offline editing | ✅ | ✗ | ✗ | ✅ |
| Your data, your server | ✗ | ✗ | ✗ | ✅ |

---

## Feedback

- [Report a bug →](https://github.com/entire-vc/evc-team-relay-obsidian/issues/new?template=bug-report.yml)
- [Request a feature →](https://github.com/entire-vc/evc-team-relay-obsidian/issues/new?template=feature-request.yml)
- [Report a web publish issue →](https://github.com/entire-vc/evc-team-relay-obsidian/issues/new?template=web-publish.yml)

---

## Solo Workflow? No Server Needed

→ [**EVC Local Sync**](https://github.com/entire-vc/evc-local-sync-plugin) — bidirectional vault ↔ local folder sync for AI-assisted coding workflows.

---



## Network Usage

This plugin makes network requests to **user-configured servers only**. No data is sent to third parties.

| Connection | Protocol | Purpose | When |
|------------|----------|---------|------|
| Control plane server | HTTPS | Authentication (login, token refresh), share management (list, create, invite), server info, billing | On login, share operations, periodic token refresh |
| Relay server | WebSocket (WSS) | Real-time CRDT document synchronization between collaborators | While editing shared documents |
| Control plane server | HTTPS | Relay token issuance (Ed25519-signed) | Before opening a WebSocket connection |
| OAuth callback (localhost) | HTTP | Receives OAuth redirect on `127.0.0.1` (desktop only) | During OAuth login flow |

**All server URLs are configured by the user** in plugin settings. The default configuration includes `https://cp.tr.entire.vc` (Team Relay hosted), but the user can add, remove, or change servers.

**No telemetry or analytics data is collected.** The plugin does not phone home, track usage, or send any data to third-party services.

## Community

- 🌐 [entire.vc](https://entire.vc)
- 💬 [Discussions](https://github.com/entire-vc/.github/discussions)
- 📧 <support@entire.vc>
- 🛟 [Where to get help and what to expect](https://github.com/entire-vc/evc-team-relay-obsidian/blob/main/SUPPORT.md)

## License

MIT — Copyright (c) 2024-2026 Entire VC. See [LICENSE](LICENSE).

This plugin bundles third-party components that keep their own licences.
Each ships its own `LICENSE` next to the code, and [NOTICE](NOTICE) lists them.
Those files are reproduced as received and are not edited.
