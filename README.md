# Team Relay permissions preview

Experimental self-hosted fork of EVC Team Relay. It adds server-enforced file/folder permissions and a browser-based Pocket ID sign-in flow for Obsidian desktop/mobile APIs. Physical mobile validation is still pending.

Use the matching [server fork and setup guide](https://github.com/kjgoodrick/evc-team-relay/blob/main/docs/permissions-preview.md). Build the installable `dist/` bundle with `npm ci --ignore-scripts` followed by `npm run build:preview`. Start in a disposable vault. This retains the upstream plugin ID, so it replaces the original plugin within that vault.

The guide records the security model, test coverage, and known preview limitations. The upstream documentation follows; legacy publishing and agent-key features are unavailable for managed shares.

---

# Team Relay Sync

[**Install from Obsidian community plugins →**](https://community.obsidian.md/plugins/team-relay-sync)

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

### From Obsidian community plugins (recommended)

Open [**Team Relay Sync** in the community plugin directory](https://community.obsidian.md/plugins/team-relay-sync) and click **Add to Obsidian**,
or open `obsidian://show-plugin?id=team-relay-sync`, or search for "Team Relay Sync" in
*Settings → Community plugins → Browse*. Then enable **Team Relay Sync**.

### Manual install

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/entire-vc/evc-team-relay-obsidian/releases)
2. Create `<your vault>/.obsidian/plugins/team-relay-sync/` and copy the three
   files into it
3. Restart Obsidian, then enable **Team Relay Sync** in
   *Settings → Community plugins*

As a fallback, [BRAT](https://github.com/TfTHacker/obsidian42-brat) can install it from `entire-vc/evc-team-relay-obsidian`.

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
