# MCP Server

## OAuth Architecture

The Worker is itself an **OAuth 2.1 Authorization Server**, powered by `@cloudflare/workers-oauth-provider`. Clerk is the upstream Identity Provider — users authenticate via Clerk, but the Worker issues its own opaque access tokens stored in KV. This is a deliberate split-domain architecture: MCP clients (Claude, ChatGPT, Gemini) never interact with Clerk directly.

**Why not use Clerk as the AS directly?** MCP clients need to discover the AS from the MCP server's `/.well-known/oauth-protected-resource` metadata. If that points to Clerk, the MCP client does DCR + authorize + token exchange with Clerk, gets a Clerk JWT, then sends it to our Worker. This fails in practice because Claude Desktop's OAuth flow can't handle the split-domain redirect (MCP server on `mcp.savecraft.gg`, AS on `clerk.accounts.dev`). Making the Worker the AS keeps everything on one origin.

**Components:**
- **`@cloudflare/workers-oauth-provider`** — Library that wraps the Worker as the entry point. Handles DCR (`/oauth/register`), token exchange (`/oauth/token`), AS metadata (`/.well-known/oauth-authorization-server`), protected resource metadata (`/.well-known/oauth-protected-resource`), and token validation on the `/mcp` route.
- **`OAUTH_KV`** (KV namespace) — Stores registered clients, authorization codes, access tokens, refresh tokens. Managed entirely by the library.
- **`OAuthProvider`** — Wraps the entire Worker. Intercepts OAuth protocol routes, validates tokens on the API route (`/mcp`), and passes `ctx.props.userUuid` to the MCP handler after successful validation.

**OAuth Discovery Flow:**

1. AI client hits MCP endpoint unauthenticated.
2. Library returns `401` with `WWW-Authenticate: Bearer` header pointing to `/.well-known/oauth-protected-resource`.
3. AI client fetches protected resource metadata:
   ```json
   {
     "resource": "https://mcp.savecraft.gg",
     "authorization_servers": ["https://mcp.savecraft.gg"],
     "bearer_methods_supported": ["header"],
     "resource_name": "Savecraft MCP Server"
   }
   ```
4. AI client fetches AS metadata from `/.well-known/oauth-authorization-server` (same origin) — gets DCR, authorize, and token endpoints.
5. AI client dynamically registers via RFC 7591 DCR at `/oauth/register`.
6. AI client opens `/oauth/authorize` with PKCE code challenge.
7. Worker redirects to Clerk's OAuth authorize endpoint (scope: `openid profile`).
8. User authenticates via Clerk (magic link email, or Discord OAuth if added later).
9. Clerk redirects back to `/oauth/callback` with authorization code.
10. Worker exchanges Clerk code for Clerk access token (server-to-server, confidential client).
11. Worker calls Clerk's `/oauth/userinfo` to get the user's `sub` claim → Savecraft user UUID.
12. Worker calls `completeAuthorization()` with `props: { userUuid }`, which creates an authorization code in KV.
13. Library redirects back to the AI client's callback with the authorization code.
14. AI client exchanges code + PKCE verifier at `/oauth/token` → receives opaque access token (+ refresh token if `offline_access` scope requested).
15. Subsequent MCP requests include `Authorization: Bearer <access_token>`.
16. Library validates token from KV, injects `ctx.props.userUuid`, passes request to MCP handler.

**Key properties:**
- Zero Clerk interaction after initial login. Token validation is a KV lookup, not a JWT signature check or network call.
- AI clients never see Clerk. The entire OAuth dance happens against `mcp.savecraft.gg`.
- `props.userUuid` flows from Clerk's `sub` claim through to save access (JOINing sources → saves in D1).
- No skip-Clerk code paths in production. The authorize handler returns 503 if Clerk secrets are missing.

### Authentication Provider: Clerk

- **Role:** Upstream Identity Provider for MCP OAuth. Also provides session auth for the web UI and magic link login.
- **Signup/login:** Email magic links. No passwords.
- **Future addition:** Discord OAuth (toggle in Clerk dashboard). High-signal for gaming audience.
- **OAuth app configuration:** One Clerk OAuth Application per environment (staging, production). Confidential client with redirect URI pointing to `/oauth/callback` on the MCP hostname.
- **User identity:** Clerk's `sub` claim from the userinfo endpoint is the Savecraft user UUID.
- **Free tier:** Clerk covers 10K MAU on free plan.

## MCP Tools

### `list_games(filter?)`

Single discovery entry point. Returns all games the player has, with saves (including note titles), and reference modules with parameter schemas. Optional `filter` for case-insensitive substring matching on game ID or name.

```json
{
  "games": [
    {
      "game_id": "d2r",
      "game_name": "Diablo II: Resurrected",
      "saves": [
        {
          "save_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          "name": "Hammerdin",
          "summary": "Hammerdin, Level 89 Paladin",
          "last_updated": "2026-02-25T21:30:00Z",
          "notes": [
            { "note_id": "n1", "title": "Enigma Farming Goals" }
          ]
        }
      ],
      "references": [
        {
          "id": "drop_calc",
          "name": "Drop Calculator",
          "description": "Compute drop probabilities for any item from any farmable source.",
          "parameters": {
            "monster": { "type": "string", "description": "Monster ID" },
            "item": { "type": "string", "description": "Item code for reverse lookup" },
            "difficulty": { "type": "string", "enum": ["normal", "nightmare", "hell"] }
          }
        }
      ]
    }
  ]
}
```

Games without saves but with reference modules still appear. Reference module parameter schemas are embedded at build time from the WASM's self-describing output.

### `get_save(save_id)`

Returns available sections and their descriptions for a save. The AI uses this to decide which sections to fetch.

```json
{
  "save_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "game_id": "d2r",
  "sections": [
    { "name": "character_overview", "description": "Level, class, difficulty, play time" },
    { "name": "equipped_gear", "description": "All equipped items with stats, sockets, runewords" },
    { "name": "skills", "description": "Skill point allocation by tree" }
  ]
}
```

### `get_section(save_id, section)`

Returns a single section's data from D1.

```json
{
  "save_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "section": "equipped_gear",
  "data": { ... }
}
```

### `refresh_save(save_id)`

Requests fresh data for a save. The server routes to the appropriate ingest path based on the save's game type — the MCP client never needs to know which path is taken.

- **Daemon-backed saves** (local files: D2R, Stardew, etc.): The Worker sends `RescanGame` to the save's SourceHub DO (per-source), which forwards it to the daemon over WebSocket. The daemon rescans the save directory, re-parses changed files, and pushes fresh data via `PushSave` over WebSocket.
- **API-backed saves** (remote APIs: PoE2, WoW via Battle.net, etc.): The Worker fetches directly from the game's API using stored credentials, parses the response, and writes to D1 via `storePush`.

Both paths produce the same result: updated save metadata and sections in D1. Subsequent `get_section` calls return the fresh data.

```json
{
  "save_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "refreshed": true,
  "timestamp": "2026-02-25T21:31:15Z"
}
```

**Latency:** API-backed refreshes complete in ~1-2 seconds. Daemon-backed refreshes take ~3-5 seconds (WebSocket command → daemon rescan → parse → WS push). Both are fast enough for conversational use.

**Failure modes:** If the daemon is offline, returns an error with `"daemon_offline": true` so the AI can tell the user to check their daemon. If the game API is rate-limited or down, returns the error from the upstream API. In both cases, the last-known data is still available via normal `get_section` calls.

## Notes

### Overview

Notes are user-supplied reference material attached to a save. They cover the full spectrum from short goals ("farming for Ber rune") to full build guides (15KB of pasted Maxroll content) to progression checklists.

Notes serve both interaction modes. In optimizer mode, the AI compares notes to actual state: "here's what you have vs. what the guide says you should have." In companion mode, notes are the AI's memory of your goals and context — when you say "I found the Ber!" the AI knows that was on your farming list and can react accordingly. The `create_note` and `update_note` tools let the AI maintain this context naturally during conversation.

Notes are **not** vectorized, chunked, or RAG'd. A typical note is 200 bytes to 20KB of markdown. The AI reads individual notes in full after discovering them via search or listing.

### Data Model

```json
{
  "note_id": "f7a8b9c0-d1e2-3456-789a-bcdef0123456",
  "save_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "title": "Maxroll Helltide Warlock Build",
  "content": "## Gear\n\n### Helm\nHarlequin Crest (Shako)...",
  "source": "user",
  "created_at": "2026-02-25T22:00:00Z",
  "updated_at": "2026-02-25T22:00:00Z"
}
```

**Limits:**
- 50KB max per note (generous — most build guides are 10-15KB of markdown)
- 10 notes max per save

**Storage:** Both metadata and content stored in D1 (not R2). Note content is indexed by FTS5 for full-text search alongside save section data.

**Source field:** `"user"` for v1 (user-pasted or AI-created content).

### MCP Tools: Notes

Read tools:

#### `get_note(save_id, note_id)`

Returns one note's full content.

```json
{
  "note_id": "f7a8b9c0-...",
  "title": "Maxroll Helltide Warlock Build",
  "source": "user",
  "content": "## Gear\n\n### Helm\nHarlequin Crest (Shako)..."
}
```

Write tools:

#### `create_note(save_id, title, content)`

Creates a new note attached to a save. The AI calls this when the user says "save this build guide" or "remember that I'm targeting Harlequin Crest." Returns the created `note_id`.

#### `update_note(save_id, note_id, content?, title?)`

Updates an existing note. For "actually, I got the Jah rune, update my farming goals."

#### `delete_note(save_id, note_id)`

Removes a note. Requires confirmation from the user in conversation before the AI calls this.

## MCP Tools: Reference Data

Read-only tool for querying server-side reference modules (drop calculators, breakpoint tables, etc.). Reference modules are WASM plugins that execute server-side via Workers for Platforms — see `docs/plugins.md` for the architecture. Available modules and their parameter schemas are discovered via `list_games`.

### `query_reference(game_id, module, query)`

Computation tool. `module` selects which reference module to query (from `list_games`). `query` is a JSON string with module-specific parameters (schemas are in `list_games` response). The reference WASM module processes the query via stdin/stdout ndjson contract and returns computed results.

```json
{
  "type": "result",
  "data": {
    "item": "Shako",
    "source": "Mephisto",
    "base_chance": "1:1432",
    "with_mf": { "300": "1:676", "400": "1:589" }
  }
}
```

**Error handling:** If the game ID has no reference Worker deployed, returns an error suggesting `list_games`. If the WASM module returns an error, the error message is passed through.

## AI Interaction Patterns

Players interact with Savecraft in two distinct modes — often in the same conversation. The tools are identical; the intent is different.

**Companion mode** — the player is talking about their game, not asking a structured question:

1. "Another Countess run and ZERO SHAELS. Wtf."
   - AI calls `get_section(save_id, "character_overview")` to see current level/difficulty
   - AI calls `search_saves("farming")` to check if there's a farming goal
   - AI commiserates with context: "You've been Hell Countess farming at level 74 — that's rough. She only drops up to Io in Hell. If you need Shaels specifically, Normal Countess is actually more reliable. Want me to update your farming note?"

2. "I JUST FOUND A BER RUNE"
   - AI calls `refresh_save` to get fresh data, then `search("farming")` to find goals
   - AI reacts: "That's your Enigma Ber! One down. You still need Jah and a 3os Mage Plate. Want me to update your farming note?"

3. "I think I'm done with this character for a while."
   - AI calls `get_save` to recap the character's state
   - AI gives a send-off: "Level 89 Hammerdin with Enigma and HotO — that's a complete build. If you come back, your biggest upgrade path is probably torch farming."

**Optimizer mode** — the player wants specific build/progression advice:

1. Call `list_games` to see what's available, or `search(query)` to find specific content across saves.
2. Call `get_save(save_id)` to see available sections for a save.
3. Based on the question, fetch only the relevant sections:
   - "What should I upgrade?" → `equipped_gear` + `inventory` + `skills`
   - "Have I finished Act 3?" → `quest_progress`
   - "Am I following my build guide?" → `search_saves` to find the guide, `get_note` to read it, then relevant sections for comparison
4. If the user indicates something just changed, call `refresh_save` to get fresh data before reading sections.
5. Combine structured save data with the AI's existing game knowledge to give personalized advice.

**The key insight:** the companion mode doesn't require different tools or data. It requires the same context — what character, what gear, what goals — applied with empathy instead of analysis.

### Visual-First Pattern

Every data tool has a visual counterpart: `list_games` → `show_games`, `get_save` → `show_save`, `query_reference` → `show_reference`. The visual tools render interactive cards, charts, and dashboards in the host iframe. **The visual tool is the default whenever a visual component exists.** The player sees a richer result and the AI can still narrate around it.

**The heuristic: visual is default, data is the escape hatch.**

Fall back to the data tool only when:
- The module has no visual component (`visual` is absent or false in the `query_reference` schema)
- The AI needs raw data to answer a pointed question where the response is a sentence, not a view

| Player says | Tool | Why |
|---|---|---|
| "What games do I have?" | `show_games` | Visual — player wants to see the list |
| "Show me my Hammerdin" | `show_save` | Visual — player wants to see the character |
| "Review my last draft" | `show_reference` | Visual — the review is best experienced as an interactive breakdown |
| "What are the drop rates for Shako?" | `show_reference` | Visual — player benefits from seeing the table |
| "Would this card fit in my deck?" | `query_reference` | Data — AI answers with a sentence, visual would be superfluous |
| "Which character should I play next?" | `list_games` | Data — AI needs to reason across characters before advising |

### AI Interaction with Notes

**Optimizer: Reading a build guide:**
1. User: "Am I following my Warlock build correctly?"
2. AI calls `search(query: "warlock build")` → finds the note and the Warlock save
3. AI calls `get_note(save_id, note_id)` → gets the full build guide content
4. AI calls `get_section(save_id, "equipped_gear")` + `get_section(save_id, "skills")`
5. AI compares actual state to guide recommendations, identifies gaps

**Companion: Setting a goal through conversation:**
1. User: "I need to farm for Enigma. Remember that — I need Jah, Ber, and a 3-socket Mage Plate."
2. AI calls `create_note(save_id, "Enigma Farming Goals", "Need: Jah rune, Ber rune, 3os Mage Plate")`
3. Next session, user says "ugh, still no Jah" → AI calls `search_saves("farming")`, knows exactly what they're talking about

**Companion → Optimizer: Celebrating a drop leads to planning:**
1. User: "I JUST FOUND A BER RUNE"
2. AI calls `refresh_save` → `search("farming")` → finds the Enigma note
3. AI: "That's your Enigma Ber! You still need Jah and a 3os Mage Plate. Want me to update the note?"
4. AI calls `update_note(save_id, note_id, "Need: ~~Ber rune~~, Jah rune, 3os Mage Plate\n\nFound: Ber rune (2026-02-25)")`
5. User: "Where should I farm for Jah?"
6. Now in optimizer mode — AI combines game knowledge with the player's actual character level and difficulty

## Search

### Overview

Unified full-text search across all of a user's save data and notes. Enables the AI to find relevant content without loading everything into context, and enables cross-save queries like "which of my characters has a Harlequin Crest?"

### Implementation: SQLite FTS5 in D1

D1 is SQLite at the edge. FTS5 is available out of the box — no external service, no embeddings, no vector DB.

**FTS5 table schema:**

```sql
CREATE VIRTUAL TABLE search_index USING fts5(
  save_id UNINDEXED,
  save_name UNINDEXED,
  type UNINDEXED,           -- 'section' or 'note'
  ref_id UNINDEXED,         -- section name or note_id
  ref_title UNINDEXED,      -- section description or note title
  content,                  -- searchable text (note markdown or section JSON)
  tokenize='porter unicode61'
);
```

User scoping is done via a subquery JOINing through sources: `WHERE save_id IN (SELECT uuid FROM saves JOIN sources ON saves.source_uuid = sources.source_uuid WHERE sources.user_uuid = ?)`.

**Indexing:**
- **Save sections:** Re-indexed on every push. DELETE existing rows for that save, INSERT new rows per section.
- **Notes:** Indexed on create/update/delete.

### MCP Tool: Search

#### `search(query, save_id?)`

Full-text keyword search across a user's saves and notes.

- **With `save_id`:** Scoped to that save's sections and notes.
- **Without `save_id`:** Searches across all the user's saves and notes.

FTS5 provides ranked results, prefix matching, and boolean operators (`hammerdin OR "blessed hammer"`) for free.

```json
{
  "query": "enigma",
  "results": [
    {
      "type": "section",
      "save_id": "a1b2c3d4-...",
      "save_name": "Hammerdin",
      "section": "equipped_gear",
      "matches": ["...body_armor: **Enigma** Mage Plate..."]
    },
    {
      "type": "note",
      "save_id": "a1b2c3d4-...",
      "save_name": "Hammerdin",
      "note_id": "f7a8b9c0-...",
      "note_title": "Maxroll Blessed Hammer Paladin",
      "matches": ["...craft **Enigma** as your first priority runeword..."]
    }
  ]
}
```

The `type` field is critical. The AI must distinguish between "what you have" (section) and "what a note recommends" (note).

Also see `docs/mcp-design.md` for cross-platform MCP tool design best practices.
