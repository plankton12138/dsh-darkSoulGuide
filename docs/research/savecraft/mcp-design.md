# MCP tool definition best practices across platforms

**The single most impactful thing you can do when building an MCP server is treat every tool name, description, and parameter as a prompt for the LLM — not documentation for a human developer.** This insight, echoed across Anthropic's directory policy, OpenAI's submission guidelines, Block Engineering's playbook, and hundreds of community discussions, fundamentally distinguishes good MCP servers from bad ones. Both the Claude Connectors Directory and ChatGPT App Directory now enforce strict requirements around tool annotations, description accuracy, and data minimization — and **missing or incorrect annotations account for 30% of all rejections at Anthropic** and are called a "common cause of rejection" by OpenAI. This guide synthesizes official platform requirements, the MCP protocol specification (revision 2025-06-18), and hard-won community lessons into actionable guidance for every aspect of MCP tool design.

---

## Tool naming: 64 characters, snake_case, and intent over implementation

The MCP specification defines tool names as unique string identifiers used in `tools/call` requests. Anthropic's Software Directory Policy caps names at **64 characters**. Gemini's API is stricter: **63 characters maximum**, with only alphanumeric characters, underscores, hyphens, and dots permitted — invalid characters are silently replaced with underscores. OpenAI requires names be "human-readable, specific, and descriptive" and "unique within your app."

Community consensus and the emerging SEP-986 proposal recommend the pattern **`{service}_{action}_{resource}`** in snake_case — for example, `slack_send_message`, `linear_list_issues`, or `sentry_get_error_details`. Service-prefixing prevents collisions when users run multiple MCP servers (both GitHub and Jira might expose `create_issue`). Snyk's research found that **snake_case works best with GPT-4o's tokenizer**, while dots, brackets, and spaces can cause LLMs to fail to call tools entirely due to tokenization issues.

OpenAI's submission guidelines add a critical constraint: "Once your app is published, **tool names, signatures, and descriptions are locked** for safety. To add or update your app's tools or metadata, you must resubmit the app for review." This means names need to be stable from the start.

The protocol's `title` field (added in the 2025-06-18 revision) provides a human-readable display name separate from the programmatic `name`. Both platforms recommend setting it. Display precedence for tools is: `title` → `annotations.title` → `name`. Name the tool for what it accomplishes, not how it's implemented: `getCampaignInsights` over `runReport`, as the community's most-upvoted guide (214 upvotes on r/mcp) puts it. Avoid generic single-word dictionary terms — OpenAI explicitly rejects these unless "clearly tied to your brand."

**Security note:** Research from Qi-anxin Technology (SEP-1395) found that 19+ mainstream MCP clients implement different naming normalization rules, creating exploitable inconsistencies. High-risk characters like `;`, `[`, `]`, `/`, and `:` can enable tool overriding attacks. Encoding version in tool names (`get_info_v1`) is explicitly discouraged by the specification when `version` fields and `tool_requirements` are available.

---

## Descriptions that help LLMs choose the right tool

Tool descriptions serve as the primary mechanism by which LLMs decide whether to invoke a tool. Anthropic's policy requires "**narrow, unambiguous natural language** that specifies what it does and when it should be invoked" and that descriptions "**precisely match actual functionality**." OpenAI states that "if a tool's behavior is unclear or incomplete from its description, your app **may be rejected**."

The emerging best practice, formalized in GitHub SEP-1382, separates concerns between two description levels:

- **Tool-level `description`**: High-level explanation of what the tool accomplishes. Purpose: tool selection. Should avoid parameter-specific details. Example: *"Read the contents of multiple files simultaneously. More efficient than reading files individually when analyzing or comparing multiple files."*
- **`inputSchema` property descriptions**: Parameter-specific documentation guiding correct invocation. Example: *"Array of file paths to read. Each path must be a valid absolute or relative file path."*

Community testing shows that **front-loading the most important information** matters — LLMs may not read the entire description. Merge.dev's analysis of production servers found most effective descriptions are 1-2 sentences structured around a verb and a resource. But descriptions should not be too short either: the AgentDX linter flags descriptions under ~10 characters as "too vague."

Both platforms explicitly prohibit manipulative descriptions. Anthropic's policy states descriptions "**must not create confusion or conflict** with other Software in our Directories." OpenAI prohibits any description that "manipulates how the model selects or uses other apps" or "interferes with fair discovery." Descriptions "must not include hidden, obfuscated, or encoded instructions" — all behavioral guidance must be human-readable.

Markdown formatting is supported in Anthropic's connector descriptions. An interesting community finding suggests that Claude may work better with XML-encoded tool descriptions while ChatGPT may prefer markdown ones, though this hasn't been officially confirmed.

The `instructions` field in the server's initialization response provides server-level context that "can be used by clients to improve the LLM's understanding of available tools." Anthropic's FAQ notes that "only tool-level descriptions are currently supported" for directory connectors — no separate server-level description exists, requiring "repeating steering guidance across individual tool descriptions."

---

## Parameter design: flatten, constrain, and minimize

The MCP spec requires every tool define an `inputSchema` with `type: "object"`. Both platforms enforce strict data minimization. OpenAI's guidelines are explicit: "Tools should request the **minimum information necessary** to complete their task. Do not request the full conversation history, raw chat transcripts, or broad contextual fields 'just in case.'" Anthropic's policy requires software "**only collect data from the user's context that is necessary** to perform their function."

The community's strongest consensus on parameter design centers on **flattening arguments**. Phil Schmid's widely-cited best practices guide contrasts:

- **Bad**: `def search_orders(filters: dict)` — agent guesses structure, hallucinates keys
- **Good**: `def search_orders(email: str, status: Literal["pending","shipped","delivered"] = "pending", limit: int = 10)` — clear, typed, constrained

Use `enum` values to constrain choices — this "reduces the chance of the model inventing categories that do not exist in your database." Consider enum over boolean for clearer semantics (the AgentDX linter specifically recommends this). Every parameter must have a description. Sensible defaults reduce the number of decisions the LLM must make.

**Cross-platform schema compatibility is a minefield.** Testing by Stainless revealed critical differences:

- **OpenAI Agents**: Only supports `anyOf` (not `allOf` or `oneOf`); cannot have `anyOf` at root level
- **Claude Desktop**: Supports `anyOf` at root; Claude Code does **not**
- **Gemini API**: Strips `$schema`, `additionalProperties`, `exclusiveMaximum`/`exclusiveMinimum`; `$defs` references cause **400 errors** (a major issue since the MCP Python SDK generates these automatically)
- **Claude quirk**: Sometimes provides object/array properties as JSON-serialized strings

The practical recommendation: **generate lowest-common-denominator schemas.** Avoid `allOf`, `oneOf`, deeply nested `$ref`, and complex constructs. Stick to flat objects with primitive types, explicit `required` arrays, and thorough descriptions.

For OpenAI's deep research and company knowledge compatibility, two specific tool schemas are mandatory: `search` (takes `query: string`, returns `{results: [{id, title, url}]}`) and `fetch` (takes `id: string`, returns `{id, title, text, url, metadata}`). These exact schemas are required — not approximate.

**Data boundary rules from OpenAI**: Avoid requesting raw location fields in your input schema. Don't pull or reconstruct the full chat log. Operate only on explicit snippets and resources the client sends. Anthropic prohibits tools from querying "Claude's memory, chat history, conversation summaries, or user-generated or uploaded files."

---

## Return values: token-efficient, structured, and actionable

Anthropic enforces a hard limit of **25,000 tokens per tool result** and requires that "the amount of tokens a given tool call uses should be roughly commensurate with the complexity or impact of the task." OpenAI requires tool responses to "return only data that is **directly relevant** to the user's request" and explicitly prohibits including "diagnostic, telemetry, or internal identifiers—such as session IDs, trace IDs, request IDs, timestamps, or logging metadata."

The MCP spec (2025-06-18) introduced `outputSchema` and `structuredContent` alongside the existing `content` array. When `outputSchema` is defined, servers **MUST** provide structured results that conform to it, and for backwards compatibility, **SHOULD** also return serialized JSON in a `TextContent` block. OpenAI extends this with a `_meta` field that is "delivered only to the component" and "**hidden from the model**" — useful for hydrating UI without token cost.

Community-tested response optimization techniques (achieving **+30% goal attainment, -50% runtime, -80% tokens** in evaluations) include:

- **Response filtering**: Let the LLM request subsets via parameters like `includeTransactions: false`
- **Response projection**: LLM specifies which fields to return
- **Response compression**: Remove blank fields, collapse repeated content (30-40% reduction); convert to markdown tables (additional 20-30% reduction)
- **Pagination with metadata**: Respect `limit` parameter (default 20-50), return `has_more`, `next_offset`, `total_count`

For error handling, the spec distinguishes **protocol errors** (JSON-RPC error responses for unknown tools or invalid arguments) from **tool execution errors** (reported inside the result with `isError: true`). The spec is clear: "Any errors that originate from the tool **SHOULD** be reported inside the result object, not as an MCP protocol-level error response." This ensures the LLM sees the error and can recover. Error messages should guide recovery: *"User not found. Please try searching by email address instead"* rather than a raw stack trace. Block Engineering's Goose implementation throws a `ToolError` for files over 400KB with a suggestion to use `sed -n` or `head`/`tail` instead.

---

## Tool granularity: design for workflows, not API endpoints

The community's most passionate and well-established consensus — with the top post on r/mcp at 214 upvotes — is that **mapping REST API endpoints 1:1 to MCP tools is the cardinal sin of MCP design**. As one commenter put it: "Instead of giving a new hire tools like 'open oven door', 'close oven door', 'roll out dough', give them one tool called 'make pepperoni pizza.'"

Block Engineering documented the definitive evolution pattern from production systems. Their Linear integration went from **30+ tools mirroring GraphQL operations** (v1) to consolidated `get_issue_info` with a category parameter (v2) to just two tools — `execute_readonly_query` and `execute_mutation_query` taking raw GraphQL (v3). Their Google Calendar integration moved from 4 API-wrapping tools to a single `query_database(sql)` powered by DuckDB with macros like `free_slots()`.

Phil Schmid recommends **5-15 tools per server**. Anthropic's FAQ states there is "no minimum or maximum requirement" but recommends starting with a useful set and expanding over time. The key metric is token cost: at **~200-400 tokens per tool definition**, 50 tools consume 20,000-25,000 tokens of context before a single user message. Platform-specific limits compound this problem: Cursor caps at ~40 MCP tools total, GitHub Copilot at 128, and the GitHub MCP server alone consumed ~22.2% of claude-sonnet-4's 200k context window with its 91 tools.

Four design patterns have emerged for managing large tool surfaces:

1. **Progressive discovery**: A first tool like `get_category_or_action` reveals sub-tools dynamically. Adds 1-2 LLM rounds but dramatically improves accuracy.
2. **Category parameter pattern**: Bundle related read-only actions into one tool with an `info_category` enum parameter. Block Engineering's `get_issue_info(issue_id, info_category)` accepts "details", "comments", "labels", "subscribers", etc.
3. **Code mode**: Instead of exposing many tools, expose a single execution environment. Anthropic Engineering reported **98.7% context savings** (from ~150k tokens to ~2k) using this approach.
4. **Workflow-based tools**: Compound tools that execute multi-step sequences internally, exposing only the intent and final result.

**The dissenting view deserves mention**: Some argue that well-documented APIs can work as 1:1 mappings, and that the real problem is clients "handling the tool list lazily, simply feeding the entire set to the LLM." This is technically correct — but until client-side progressive disclosure becomes universal, server-side curation remains essential.

---

## OAuth and authentication: PKCE is non-negotiable

Both platforms require **OAuth 2.0 with Authorization Code flow and PKCE (S256)** for authenticated MCP servers. Neither supports machine-to-machine grants (client credentials, service accounts, or JWT bearer assertions).

**Anthropic requirements:**
- Must allowlist callback URLs: `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, and localhost variants
- Supports Dynamic Client Registration (DCR) and, as of July, the 6/18 auth spec alongside the 3/26 spec
- Users can specify custom client_id/client_secret for servers that don't support DCR
- OAuth is per-server-connection, not per-tool. Per-tool permissions must be enforced server-side after connection
- OAuth is the **only way to uniquely identify users** — Anthropic does not forward IP addresses, user IDs, or other metadata

**OpenAI requirements:**
- Must expose Protected Resource Metadata at `/.well-known/oauth-protected-resource`
- Identity provider must serve OAuth discovery at `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration`
- `code_challenge_methods_supported` **must include `S256`** or "ChatGPT will refuse to complete the flow"
- Must allowlist redirect URLs: `https://chatgpt.com/connector_platform_oauth_redirect` (production), `https://platform.openai.com/apps-manage/oauth` (review)
- ChatGPT appends `resource=<url>` to authorization and token requests — configure your authorization server to copy this into the access token's `aud` claim
- Per-tool security schemes can be declared: `noauth` for anonymous tools, `oauth2` with specific scopes for protected tools

**A common gotcha**: OpenAI's OAuth `state` parameter can exceed 400 characters, breaking `VARCHAR(255)` database columns. OpenAI also probes for `/.well-known/oauth-protected-resource` endpoints that may generate 404s in server logs.

Both platforms support DCR, but OpenAI notes that "CMID is still in draft, so continue supporting DCR until CMID has landed." Gemini CLI supports three auth provider types: `dynamic_discovery`, `google_credentials` (ADC), and `service_account_impersonation`.

---

## Submission checklists for both directories

### Claude Connectors Directory

Anthropic requires a Google Form submission with these prerequisites:

- All tools have `readOnlyHint` **OR** `destructiveHint` annotations (hard requirement — 30% of rejections)
- OAuth 2.0 implemented correctly (if auth required)
- Server accessible via HTTPS with valid certificates
- Privacy policy published at a stable HTTPS URL on your domain (missing = immediate rejection)
- Dedicated support channel (email or web)
- Test account with sample data prepared
- **Minimum 3 usage examples** documented with realistic prompts and expected behavior
- Server is production-ready (GA status — beta/development servers cannot be included)
- Comprehensive documentation covering: description, features, setup, authentication, examples, privacy policy, support
- Performance tested under realistic load; error handling with helpful messages
- Streamable HTTP transport (SSE support may be deprecated)
- Claude IP addresses allowlisted if behind a firewall

**Common rejection reasons (accounting for 90% of revision requests):** Missing tool annotations (30%), OAuth implementation issues (missing callback URLs, firewall misconfiguration), incomplete documentation (fewer than 3 examples), production readiness concerns, and missing/inaccessible privacy policy.

### ChatGPT App Directory

OpenAI requires submission through the Platform Dashboard:

- **Identity verification** completed (individual or business — publishing under an unverified name = rejection)
- Owner role in the organization
- MCP server hosted on a publicly accessible domain (not local/testing)
- Content Security Policy (CSP) defined with exact allowed domains
- Test credentials for a **fully-featured demo account** with sample data — apps requiring 2FA through an inaccessible account will be rejected
- App names must be clear, accurate, and not overly generic
- Privacy policy explaining categories of data collected, purposes, recipients, and user controls
- Customer support contact details
- All tool annotations correctly set with **detailed justification for each** at submission time
- 5+ positive test cases, 3+ negative test cases (prompts where app should NOT trigger)
- Testing verified on **both ChatGPT web and mobile apps**

**Common rejection reasons:** Unable to connect to MCP server or authenticate with provided credentials, test case failures (mismatch between actual and expected tool behavior), undisclosed user-related data types in tool responses (including nested fields and debug payloads), incorrect or missing action labels, and unverified publisher identity.

**Key difference**: Anthropic's process uses Google Forms; OpenAI's uses their Platform Dashboard. OpenAI requires both positive and negative test cases. Anthropic explicitly checks tool annotations first; OpenAI requires written justifications for each annotation. Both require privacy policies, test accounts, and production-ready servers. Both may remove apps at any time for non-compliance or inactivity.

---

## Security and privacy: data minimization is the shared principle

Both platforms converge on aggressive data minimization as the core security requirement. Anthropic's policy: collect "**only data from the user's context that is necessary** to perform their function" and "must not collect extraneous conversation data, even for logging purposes." OpenAI: "Gather only the minimum data required to perform the tool's function."

**OpenAI's restricted data list — NEVER collect:**
- Payment card data (PCI DSS)
- Protected health information (PHI)
- Government identifiers (SSNs)
- Access credentials and authentication secrets (API keys, MFA/OTP codes, passwords)

**Both platforms prohibit:**
- Surveillance, tracking, or behavioral profiling without explicit disclosure and user control
- Returning internal telemetry, session IDs, trace IDs, or logging metadata in tool responses
- Querying the AI's memory, chat history, or uploaded files
- Evading or circumventing the AI's safety guardrails

**Rate limiting is your responsibility.** Anthropic states: "MCP server owners must implement their own rate limiting and abuse prevention measures." OpenAI provides `_meta["openai/subject"]` (anonymized user ID) and `_meta["openai/session"]` (anonymized conversation ID) specifically for rate limiting — but these are "hints only; servers should **never rely on them for authorization decisions**."

**Privacy policy requirements differ slightly.** Anthropic requires it on your own domain (not third-party hosting) at a stable HTTPS URL. OpenAI requires it to explain "at minimum the categories of personal data collected, the purposes of use, the categories of recipients, and any controls offered." Both require a Terms of Service display through the OAuth consent screen.

**Prompt injection risk is real and documented.** OpenAI explicitly warns that malicious content in MCP-accessible data can override ChatGPT's behavior, and attackers may trick the AI into exfiltrating data via write actions. Even read actions can leak data if the MCP server logs parameters. Anthropic's policy addresses this by prohibiting tools from "dynamically pulling behavioral instructions from external sources."

---

## Tool annotations: the required metadata both platforms enforce

Tool annotations were introduced in the MCP spec's 2025-03-26 revision (PR #185) and have become **the most impactful requirement for directory submissions**. The full schema from the specification:

```
annotations: {
  title?: string          // Human-readable title for UI display
  readOnlyHint?: boolean  // Tool does not modify environment (default: false)
  destructiveHint?: boolean // May perform destructive updates (default: true)
  idempotentHint?: boolean  // Repeated calls have no additional effect (default: false)
  openWorldHint?: boolean   // Interacts with external entities (default: true)
}
```

**Anthropic makes annotations a hard requirement**: "Every tool MUST have accurate safety annotations." The policy specifically mandates `readOnlyHint`, `destructiveHint`, and `title`. Missing annotations cause 30% of all rejections. **OpenAI makes `readOnlyHint`, `destructiveHint`, and `openWorldHint` required** and demands "a detailed justification for each at submission time." Incorrect labels are called "a common cause of rejection."

The annotation decision matrix is consistent across platforms:

- **Read-only tools** (search, get, list, fetch): `readOnlyHint: true, destructiveHint: false`
- **Write/modify tools** (create, update, send): `readOnlyHint: false, destructiveHint: true` (or `false` for non-destructive creates)
- **Delete tools**: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`
- **External-facing tools** (post to social media, send emails): `openWorldHint: true`

Critical nuances: `destructiveHint` and `idempotentHint` are **only meaningful when `readOnlyHint` is false** — the spec is explicit about this. Even temporary file writes or internal caching that modifies state should be marked `destructiveHint: true`. Annotations are "hints" not guarantees — OpenAI warns that "write actions can occur even if the MCP server has tagged the action as read only," so servers must enforce their own authorization.

OpenAI uses annotations to determine whether to show a read or write badge and whether to require manual confirmation. ChatGPT currently requires **manual user confirmation before any write action**. Company knowledge features (Business, Enterprise, Edu) can only automatically call tools marked `readOnlyHint: true`.

**Gemini notably lacks documented support for MCP tool annotations.** The Gemini CLI's trust/confirmation system (`trust: true` per-server or per-tool allowlisting) operates independently of MCP annotations. This is a significant gap for cross-platform design.

---

## Cross-platform compatibility: the lowest common denominator wins

Designing an MCP server that works well across Claude, ChatGPT, and Gemini simultaneously requires navigating meaningful differences in JSON Schema support, transport preferences, authentication flows, and tool limits.

**Transport**: Both Anthropic and OpenAI recommend **Streamable HTTP** and signal SSE deprecation. Gemini CLI supports stdio, SSE, and Streamable HTTP with priority order: `httpUrl` > `url` > `command`. For maximum compatibility, implement Streamable HTTP as primary and stdio for local/development use.

**JSON Schema is the critical compatibility battleground.** The safest approach is to avoid all advanced schema constructs. Use only flat objects with primitive types (`string`, `number`, `integer`, `boolean`), `enum` arrays for constrained values, explicit `required` arrays, and thorough per-property descriptions. Avoid `allOf`, `oneOf`, `$ref` with `$defs`, `anyOf` at root level, `additionalProperties`, and `exclusiveMinimum`/`exclusiveMaximum`.

**Tool name limits** vary: Anthropic policy says 64 characters, Gemini API enforces 63 characters with restricted character sets. **Safe rule: stay under 63 characters using only `a-z`, `0-9`, and `_`.**

**Authentication** follows the same OAuth 2.0 + PKCE pattern everywhere, but callback URLs differ per platform. Servers must allowlist all three platforms' redirect URIs. OpenAI uniquely requires the `resource` parameter echoed in tokens and Protected Resource Metadata at a well-known endpoint.

**Content support varies**: Claude supports text and image tool results. OpenAI primarily uses text with `structuredContent`. Gemini CLI supports text, image, audio, resource, and resource_link. For cross-platform compatibility, always return a `text` content type as the primary result.

**Platform-specific features to use carefully**: OpenAI's `_meta` namespace provides ChatGPT-specific UI capabilities (`openai/outputTemplate`, `openai/visibility`, etc.) and follows the MCP Apps open standard. Anthropic supports markdown in descriptions. Gemini CLI uniquely supports MCP prompts as slash commands and appends server `instructions` to system instructions. Use platform-specific extensions only after the base MCP implementation works universally.

---

## The eleven anti-patterns that sabotage MCP servers

**1. One-to-one API endpoint mapping.** The most discussed anti-pattern in the community. REST APIs are organized around endpoints; MCP tools should be organized around user intents. Generating an MCP server directly from an OpenAPI spec creates "tool fatigue" where the LLM burns context trying to chain dozens of granular operations.

**2. Tool overload.** Five MCP servers with 30 tools each produces 150 total tools consuming 30,000-60,000 tokens of context metadata alone. Research shows tool-calling accuracy declines measurably as tools increase. Cursor hard-limits at ~40 tools, GitHub Copilot at 128.

**3. Descriptions that describe the API, not the intent.** API documentation assumes context that LLMs lack. MCP tool descriptions need more detail about *when* and *why* to use a tool than typical API docs provide. A description like "Gets weather" tells the LLM nothing about when to invoke it.

**4. Making the server "too smart."** MCP servers should be "research assistants, not competing analysts." Return rich structured raw data and let the LLM reason about it. Servers that try to do heavy analytical lifting produce brittle, limited outputs.

**5. Complex nested parameters.** `filters: dict` forces the LLM to guess structure and hallucinate keys. Flat parameters with explicit types and constrained enums work dramatically better.

**6. Returning excessive data.** Raw API responses with every field, debug payloads, and internal identifiers waste tokens and risk rejection from both directories. Filter server-side, paginate, and strip unnecessary fields.

**7. Similar or ambiguous tool names.** When `get_status`, `fetch_status`, and `query_status` all appear, models frequently select the wrong one. Use service-prefixed, action-specific names.

**8. Hidden side effects.** Both platforms require all external actions to be transparent from the tool definition. Anthropic's policy: descriptions "must not include unexpected functionality." OpenAI: "Side effects should never be hidden or implicit."

**9. `console.log()` in stdio servers.** Writing to stdout in stdio-based servers corrupts the JSON-RPC communication channel. Use stderr or file-based logging exclusively.

**10. Mixing read and write operations in one tool.** This confuses permission management and makes accurate annotations impossible. Each tool should stick to one risk level.

**11. Ignoring resources and prompts.** "Early adopters only wired tools and ignored the rest of the spec." MCP also includes resources (for context injection), prompts (for structured interactions), and elicitations (for user input) as first-class concepts that can reduce tool count.

---

## Real-world examples of effective tool design

The best production MCP servers share common patterns. Block Engineering's **Google Calendar MCP v2** collapsed 4 API-wrapping tools into a single `query_database(sql, time_min, time_max)` powered by DuckDB with macros like `free_slots()`. Their **Linear MCP v3** reduced 30+ tools to `execute_readonly_query(query, variables)` and `execute_mutation_query(query, variables)` taking raw GraphQL.

Phil Schmid's **Gmail MCP** exemplifies clean separation: `gmail_search(query, limit)` returns compact summaries `[{id, subject, sender, date, snippet}]`, `gmail_read(message_id)` returns full content, and `gmail_send(to, subject, body, reply_to_id)` handles composition. Three tools covering the primary use cases with clear boundaries.

The **Kubernetes MCP Server** demonstrates proper annotation usage in Go:

```go
mcp.NewTool("helm_list",
  mcp.WithDescription("List all Helm releases..."),
  mcp.WithTitleAnnotation("Helm: List"),
  mcp.WithReadOnlyHintAnnotation(true),
  mcp.WithDestructiveHintAnnotation(false),
  mcp.WithOpenWorldHintAnnotation(true),
)
```

The **GitHub MCP Server** demonstrates dynamic tool management: a `--dynamic-toolsets` flag for selective loading, `--read-only` mode for restricted environments, and a `minimal_output` boolean parameter on search tools to control response verbosity. Its search tool embeds query syntax examples directly in parameter descriptions: *"Search query using GitHub's powerful code search syntax. Examples: 'content:Skill language:Java org:github', 'NOT is:archived language:Python OR language:go'"*.

Arcade.dev's analysis of 8,000+ production tools across 100+ integrations identified the **parameter coercion pattern** as critical: accept multiple input formats (e.g., "2024-01-15", "January 15", "yesterday") and normalize internally. Design for how LLMs actually provide data, not how APIs traditionally expect it. Their **async job pattern** handles long-running operations by returning a job ID, with the agent polling `check_status(job_id)` rather than blocking.

---

## Conclusion: the principles that matter most

Three principles underpin every specific recommendation in this guide. First, **every string the LLM reads is a prompt** — tool names, descriptions, parameter descriptions, and error messages all compete in a finite context window and directly influence tool selection accuracy. Second, **data minimization is both a security requirement and a performance optimization** — fewer tokens in, fewer tokens out, faster and more accurate tool use. Third, **annotations are infrastructure, not decoration** — they determine whether your server gets accepted, whether users see confirmation dialogs, and whether enterprise features can auto-invoke your tools.

The platforms are converging on requirements but diverge on specifics. Both mandate OAuth 2.0 with PKCE. Both require accurate tool annotations. Both reject servers with excessive data collection. But Gemini's strict JSON Schema validation, OpenAI's requirement for written annotation justifications, and Anthropic's 25,000-token response limit each impose unique constraints. The safest path is designing to the lowest common denominator: flat schemas, snake_case names under 63 characters, Streamable HTTP transport, and annotations on every tool.

The community has moved beyond debating whether to map APIs 1:1 (don't) and is now actively developing the next generation of patterns: progressive disclosure, code execution environments, and workflow-level tools that dramatically reduce both tool count and token consumption. The servers getting accepted to both directories in 2026 are the ones that treat MCP tool definitions as a user experience problem, not a plumbing problem.
