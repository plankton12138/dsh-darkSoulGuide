# Savecraft Overview

## What Savecraft Is

Savecraft connects video game knowledge and game state to AI assistants -- Claude, ChatGPT, Gemini -- via MCP (Model Context Protocol). Three layers:

1. **Expert modules.** Rules engines, item databases, build planners, economy trackers. Available for every supported game (Magic, Path of Exile, Factorio, etc.); the user connects an MCP URL, no install.
2. **Save-file integration.** For games like Diablo II, RimWorld, Factorio, Stellaris, and Stardew Valley, an optional local daemon watches save files, parses them with sandboxed WASM plugins, and pushes the parsed state to the cloud.
3. **Account integration.** For games with public APIs (World of Warcraft via Battle.net, more later), server-side adapters connect through OAuth. No local install.

A game can have any combination. Most have expert modules; some have save integration; a few have account integration.

The result: Claude, ChatGPT, and Gemini become something that knows your game the way a co-op partner would. They can optimize your build, track your goals, and react when you vent about Countess dropping nothing for the fifteenth run in a row.

Most of these games are played solo. The best moments — the lucky drop, the build finally clicking, the boss that took twenty attempts — happen with nobody watching. Savecraft means there's always someone who knows the context. You don't explain what a Shael is or why Perfection matters. The AI already knows your character, your gear, your goals. It's Player 2.

Two modes of use emerge naturally from the same data:

- **Companion.** "Another Countess run and ZERO SHAELS. Wtf." / "I JUST FOUND A BER RUNE." / "I think I'm burned out on this character." The AI knows your actual state and can react with context — commiserate, celebrate, suggest what to do next.
- **Optimizer.** "What should I upgrade?" / "Am I hitting the 125% FCR breakpoint?" / "Compare my build to the Maxroll guide." The AI reads your sections, compares to game knowledge and attached notes, and gives specific advice.

Both modes use the same MCP tools, the same save data, the same notes. The architecture doesn't distinguish between them — it just serves structured state and lets the conversation go wherever the player takes it.

**Domains:** savecraft.gg (primary), savecraft.ai (redirect)
**Creator:** [Josh Symonds](https://joshsymonds.com)

## System Architecture

Savecraft has two fully separate components that share a user account and a data contract.

```
┌─────────────────────┐         ┌──────────────────────────────┐
│   Gaming Device      │         │   Cloud (Cloudflare)         │
│   (PC / Steam Deck)  │         │                              │
│                      │   WS    │  ┌────────────────────────┐  │
│  ┌────────────────┐  │ ──────> │  │  SourceHub DO          │  │
│  │  Daemon         │  │ binary │  │  - validates protobuf  │  │
│  │  - fs watcher   │  │ proto  │  │  - writes to D1        │  │
│  │  - WASM runtime │  │        │  └────────────────────────┘  │
│  │  - plugin loader│  │        │                              │
│  └────────────────┘  │        │  ┌────────────────────────┐  │
│                      │        │  │  D1 (SQLite at edge)   │  │
│  Save files:         │        │  │  - sources + users      │  │
│  - D2R .d2s          │        │  │  - saves + sections    │  │
│  - Stardew XML       │        │  │  - notes               │  │
│  - etc.              │        │  │  - plugin registry     │  │
│                      │        │  └────────────────────────┘  │
│  Some games need no  │        │                              │
│  daemon — API-backed │        │  ┌────────────────────────┐  │
│  games (WoW, PoE2)   │        │  │  API Adapters (Worker)  │  │
│  are served directly │        │  │  - fetch game APIs     │  │
│  by the Worker.      │        │  │  - storePush → D1      │  │
└─────────────────────┘         │  └────────────────────────┘  │
                                │                              │
┌─────────────────────┐         │  ┌────────────────────────┐  │
│   AI Client          │  HTTPS  │  │  MCP Server (Worker)   │  │
│   (Claude, ChatGPT,  │ <────> │  │  - OAuth AS (own keys) │  │
│    Gemini)           │  MCP   │  │  - serves MCP tools    │  │
└─────────────────────┘         │  │  - reads from D1       │  │
                                │  └────────────────────────┘  │
                                │                              │
                                │  ┌────────────────────────┐  │
                                │  │  R2 Object Store       │  │
                                │  │  - plugin .wasm bins   │  │
                                │  └────────────────────────┘  │
                                └──────────────────────────────┘
```

### Source-Centric Architecture

Savecraft uses a source-centric ownership model. A "source" is any authenticated entity that sends save data over WebSocket — the local daemon, a server-side API adapter, or a game mod. Sources own saves; users own sources. The daemon self-registers as a source on first boot, receives a source token (`sct_*`), and pushes saves under its own source UUID. Users link sources to their account via a 6-digit link code displayed by the daemon.

**Ownership chain:** `User → Sources → Saves`. MCP and web UI access saves by JOINing through the user's linked sources. A user with two sources (PC daemon + Steam Deck daemon) sees saves from both.

**Source lifecycle:**
1. **Register:** Daemon connects to `/ws/register` (unauthenticated WebSocket), sends a `Register` proto message. Server creates a source row, issues a `sct_*` token, and generates a 6-digit link code (20-minute TTL).
2. **Link:** User enters the 6-digit code at `savecraft.gg/setup` (or the web dashboard). The server notifies the daemon via `SourceLinked` over the existing WebSocket connection.
3. **Push:** Daemon sends `PushSave` proto messages over the authenticated WebSocket. Save metadata and section data are stored in D1.
4. **Reap:** Unlinked sources with no push activity for 7+ days are automatically cleaned up by a daily Cron Trigger.

### Component 1: Local Daemon

Runs on the gaming device (Windows PC, Linux PC, Steam Deck). Background process that watches save file directories, parses saves using WASM plugins, and pushes structured save data over WebSocket. Self-registers as a source on first boot, then maintains a persistent binary protobuf WebSocket connection to a per-source SourceHub Durable Object for real-time config updates, status reporting, and save push.

- **No MCP involvement.** Pure background service.
- **Linux / Steam Deck:** Static binary installed to `~/.local/bin/` + systemd user unit. Sandboxed via systemd directives. See `docs/infrastructure.md`.
- **First boot:** Daemon connects to `/ws/register` WebSocket to get a source token. Displays a 6-digit link code for the user to enter in the web UI. Token is persisted locally; subsequent boots use the existing token.
- **Configuration:** All configuration happens via the web dashboard at my.savecraft.gg. Config changes push to daemon in real time via binary protobuf WebSocket (`Message` envelope). Per-source configs stored server-side in D1.

### Component 2: Remote MCP Server

Cloud-hosted HTTPS endpoint that serves game state to AI clients. This is a standard remote MCP server — Claude, ChatGPT, and Gemini connect directly via their built-in MCP connector/plugin systems.

- **Claude.ai:** Custom connector via Settings → Connectors → "Add custom connector." Requires OAuth with Dynamic Client Registration (RFC 7591) + PKCE.
- **ChatGPT:** Developer Mode on Business/Enterprise/Edu. Remote MCP via SSE/HTTP with OAuth.
- **Gemini:** CLI and SDK support OAuth for remote servers.

### Shared Server Binary

The MCP server, WebSocket endpoints, and API adapters run as a **single Cloudflare Worker**. Route groups on the same deployment:

- `/api/v1/source/link` — Link source to user account via 6-digit code (Clerk session auth)
- `/api/v1/notes/*` — Note CRUD for web UI and MCP write tools (Clerk session or OAuth)
- `/mcp/*` — MCP tool-serving endpoint (OAuth access token from our AS)
- `/oauth/authorize` — Redirects to Clerk for user login, then completes authorization
- `/oauth/callback` — Receives Clerk auth code, exchanges for Clerk token, issues our own OAuth grant
- `/oauth/token` — Token endpoint (authorization code → access token exchange, refresh token support)
- `/oauth/register` — Dynamic Client Registration (RFC 7591) for AI clients
- `/.well-known/oauth-authorization-server` — AS metadata (auto-served by library)
- `/.well-known/oauth-protected-resource` — Protected resource metadata (auto-served by library)
- `/ws/register` — WebSocket source self-registration (unauthenticated, binary protobuf `Register` message, returns source token)
- `/ws/daemon` — WebSocket for daemon real-time connection (source token auth, binary protobuf `Message`, handles save push via `PushSave`, routed to per-source SourceHub DO)
- `/ws/ui` — WebSocket upgrade for web UI live status (Clerk session, binary protobuf `RelayedMessage`, routed to per-user UserHub DO)

This is not microservices. One binary, shared auth middleware, shared D1 client. The Durable Objects (SourceHub, UserHub) are separate classes in the same Worker bundle.

## Repository Structure

Monorepo. Single Go module.

```
savecraft/
├── proto/
│   └── savecraft/v1/
│       └── protocol.proto       # Canonical WebSocket message types (Message + RelayedMessage)
├── buf.yaml                     # buf module config
├── buf.gen.yaml                 # buf codegen config (Go + TypeScript targets)
├── Justfile                     # Command runner targets
├── cmd/
│   ├── savecraftd/              # Local daemon binary (headless, no GUI)
│   │   └── main.go
│   └── savecraft-tray/          # System tray app (polls daemon, shows status)
├── internal/
│   ├── proto/                   # Generated Go code from protobuf (do not edit)
│   │   └── savecraft/v1/
│   │       └── protocol.pb.go
│   ├── daemon/                  # Daemon orchestrator, domain types (GameState), interfaces
│   │   ├── daemon.go            # Daemon struct, Run loop, event handling
│   │   └── daemon_test.go       # Tests with hand-written fakes
│   ├── runner/                  # WASM plugin execution via wazero
│   │   └── wazero.go            # WazeroRunner: ndjson stdout parsing, 2MB limit
│   ├── watcher/                 # Filesystem watcher: fsnotify + debounce + hash
│   │   └── watcher.go
│   ├── pluginmgr/              # Plugin download, verification, caching, manifest access
│   ├── wsconn/                  # WebSocket client for /ws/daemon (status events + save push)
│   │   └── client.go
│   ├── localapi/               # Localhost HTTP API (server + client for tray↔daemon IPC)
│   └── svcmgr/                 # Cross-platform service management (systemd, launchd, registry)
├── worker/                      # Cloudflare Worker + Durable Object (TypeScript)
│   ├── src/
│   │   ├── index.ts             # Worker routes, request handling
│   │   ├── hub.ts               # SourceHub Durable Object class (per-source)
│   │   ├── user-hub.ts          # UserHub Durable Object class (per-user, UI WebSocket)
│   │   └── proto/               # Generated TypeScript from protobuf (do not edit)
│   │       └── savecraft/v1/
│   │           └── protocol.ts
│   ├── wrangler.toml
│   └── package.json
├── plugins/
│   ├── echo/                    # Reference/test plugin: reflects input as GameState
│   │   ├── main.go
│   │   └── Justfile             # just build → parser.wasm
│   └── d2r/                     # D2R plugin
│       ├── parser/              # Daemon-side: save file parsing
│       │   └── main.go          # stdin bytes → ndjson stdout
│       ├── reference/           # Worker-side: reference data computation
│       │   └── main.go          # JSON query on stdin → ndjson result
│       ├── d2s/                 # Shared parsing + data tables
│       ├── Justfile             # just build → parser.wasm + reference.wasm
│       └── plugin.toml
├── install/
│   ├── install.sh               # Linux/Steam Deck curl installer
│   ├── windows/                 # WiX MSI installer definition
│   │   └── savecraft.wxs
│   └── worker/                  # Cloudflare Worker (UA-based install router)
│       └── src/index.ts
├── views/                       # MCP Apps view build infra + Storybook (port 6007)
│   ├── .storybook/              # Storybook config (globs worker/ + plugins/)
│   ├── scripts/build.ts         # Build script → worker/src/mcp/views.gen.ts
│   └── src/
│       ├── bridge.ts            # @modelcontextprotocol/ext-apps App class bridge
│       └── view.css             # Design system tokens
├── web/                         # SvelteKit frontend: source status, settings, notes
├── go.mod
└── go.sum
```

Cross-compilation:
```bash
# Daemon (CGO_ENABLED=0 on all platforms — no GUI dependencies)
just build-daemon linux amd64
just build-daemon darwin arm64
just build-daemon windows amd64

# Tray app (CGO only needed on macOS for Cocoa; pure Go on Linux/Windows)
just build-tray linux amd64
just build-tray darwin arm64
just build-tray windows amd64
```

Go `internal/` packages are daemon-only. The server is a TypeScript Cloudflare Worker (`worker/`), not a Go binary.

## Data Schema

### GameState (plugin output)

All plugins emit a `result` line on stdout conforming to this structure (the `type: "result"` field is stripped by the daemon before storage):

**Character save** (most common — one save per character/playthrough):

```json
{
  "identity": {
    "saveName": "Hammerdin",
    "gameId": "d2r",
    "extra": {
      "class": "Paladin",
      "level": 89
    }
  },
  "summary": "Hammerdin, Level 89 Paladin",
  "sections": {
    "character_overview": {
      "description": "Level, class, difficulty, play time",
      "data": {
        "name": "Hammerdin",
        "class": "Paladin",
        "level": 89,
        "experience": 2345678901,
        "difficulty": "Hell",
        "play_time": 86400,
        "strength": 156,
        "dexterity": 75,
        "vitality": 300,
        "energy": 15
      }
    },
    "equipped_gear": {
      "description": "All equipped items with stats, sockets, runewords",
      "data": {
        "helmet": { "name": "Harlequin Crest", "base": "Shako", "...": "..." },
        "body_armor": { "name": "Enigma", "base": "Mage Plate", "...": "..." }
      }
    }
  }
}
```

**Game save** (shared state across all characters — shared stash, meta-progression, unlocks):

```json
{
  "identity": {
    "saveName": "Shared Stash (Softcore)",
    "gameId":   "d2r"
  },
  "summary": "Shared Stash (3 tabs, 47 items)",
  "sections": {
    "stash": {
      "description": "Shared stash contents across all characters",
      "data": { "tabs": [ { "items": ["..."] } ] }
    }
  }
}
```

Every save has a `saveName` provided by the plugin. For character saves this is the character name (e.g. "Hammerdin"). For game-scoped saves it's a descriptive label (e.g. "Shared Stash (Softcore)"). The unique identity is always `(source_uuid, game_id, save_name)` — saves belong to the source that pushes them, and are accessible to the user who has linked that source.

**Design principles:**

- **Self-describing.** Every section carries a `description` field. The AI uses these to decide which sections to request.
- **Section-level granularity.** Stardew Valley farm state can be megabytes. The AI requests only the sections it needs for the question.
- **Plugin-defined schema.** The server does not validate section contents. Each game's sections have different shapes. The plugin is the authority on what data looks like.
- **No cross-game normalization.** D2R gear and Stardew crops are fundamentally different data. Attempting to normalize into a universal schema would lose information and add complexity for zero benefit.
- **Plugin-authored summaries.** The `summary` field is a human-readable display string authored by the plugin. Examples: `"Hammerdin, Level 89 Paladin"` (D2R), `"Berry Merry Farm, Year 3 Fall — 69% Perfection"` (Stardew), `"Emperor Halfdan of Scandinavia, 847 AD"` (CK3). The server stores summaries in D1 for fast UI rendering and MCP tool responses.
- **Plugin-named saves.** Every save is identified by `(source_uuid, game_id, save_name)`. The plugin always provides a `saveName`. Saves belong to the source that pushes them; the user accesses saves through their linked sources.
- **Section data in D1.** After push, section data is stored in the D1 `sections` table. Each section row references a save UUID and contains the section name, description, and JSON data. MCP tools read section data directly from D1.

### R2 Storage

One R2 bucket per environment for plugin binaries:

| Bucket | Binding | Contents |
|--------|---------|----------|
| `savecraft-plugins` | `PLUGINS` | Plugin binaries and manifests — public-read via API |

Staging uses `-staging` suffix (`savecraft-plugins-staging`).

**Plugins bucket layout:**

```
plugins/{game_id}/manifest.json
plugins/{game_id}/parser.wasm
plugins/{game_id}/parser.wasm.sig
plugins/{game_id}/reference.wasm        # optional, if plugin has reference modules
plugins/{game_id}/reference.wasm.sig
```
