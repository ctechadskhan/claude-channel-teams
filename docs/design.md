# Design — claude-channel-teams (Phase 1)

> Reviewer-facing document. Read [`research-notes.md`](research-notes.md)
> first if the Telegram / Discord / channels-reference material isn't fresh.
> Open questions are collected in [Section F](#f-open-questions) — those
> are the ones requiring an explicit decision before Phase 2 begins.

---

## A. Architecture overview

### Components

```
              ┌──────────────────────────────────────────┐
              │      Microsoft Teams client (any)        │
              │     (mobile / desktop / web — DM bot)    │
              └──────────────────┬───────────────────────┘
                                 │ user types
                                 ▼
              ┌──────────────────────────────────────────┐
              │   Microsoft Teams service (Microsoft)    │
              │   Resolves @<bot-handle> → bot resource  │
              └──────────────────┬───────────────────────┘
                                 │ Activity payload
                                 ▼
              ┌──────────────────────────────────────────┐
              │       Azure Bot Service / Bot            │
              │       Framework Connector                │
              │  Signs payload with bearer JWT, POSTs    │
              │  to the configured messaging endpoint    │
              └──────────────────┬───────────────────────┘
                                 │ HTTPS POST  (Bearer JWT)
                                 ▼
              ┌──────────────────────────────────────────┐
              │   Operator's reverse proxy / tunnel      │
              │ (Caddy / nginx / Cloudflare Tunnel /     │
              │  Azure App Gateway — operator's choice)  │
              └──────────────────┬───────────────────────┘
                                 │ HTTP   (loopback only)
                                 ▼
              ┌──────────────────────────────────────────┐
              │      claude-channel-teams plugin         │
              │  ┌────────────────────────────────────┐  │
              │  │  Restify / Bun.serve on 127.0.0.1  │  │
              │  └────────────────┬───────────────────┘  │
              │                   ▼                      │
              │  ┌────────────────────────────────────┐  │
              │  │ CloudAdapter — JWT + tenant check  │  │
              │  └────────────────┬───────────────────┘  │
              │                   ▼                      │
              │  ┌────────────────────────────────────┐  │
              │  │ gate(): aadObjectId allowlist      │  │
              │  │   → drop / pair / deliver          │  │
              │  └────────────────┬───────────────────┘  │
              │                   ▼                      │
              │  ┌────────────────────────────────────┐  │
              │  │ MCP notification over stdio        │  │
              │  └────────────────┬───────────────────┘  │
              └───────────────────┼──────────────────────┘
                                  │ notifications/claude/channel
                                  ▼
              ┌──────────────────────────────────────────┐
              │            Claude Code session           │
              │   Reads <channel> tag, does the work,    │
              │   calls reply tool → back up the stack   │
              └──────────────────────────────────────────┘
```

### Process model

- Claude Code spawns the plugin as a subprocess (stdio MCP) when the user
  passes `--channels plugin:teams@<marketplace>`. Lifetime == Claude Code
  session.
- The plugin opens an HTTPS-bound listener on a local loopback port. It
  does **not** terminate TLS, manage certificates, or publish DNS. That is
  the operator's responsibility — see [`docs/azure-setup.md`](azure-setup.md)
  for the deployment shapes we document.
- Recommendation: a small persistent reverse proxy (Caddy is the simplest
  config) that terminates TLS using the operator's hostname and forwards to
  `127.0.0.1:3978`. For dev work, a tunnel (Cloudflare Tunnel, ngrok) is
  documented as an alternative.
- Why no built-in TLS listener: TLS termination drags in certificate
  lifecycle (ACME, renewal, file permissions on the private key). Out of
  scope for a per-user plugin. We do document the systemd unit for the
  reverse proxy as an example.

### Stdio split

- **stdout** → MCP transport. Nothing else writes there.
- **stderr** → audit log (delivered + dropped activities, errors, startup
  notice). Inherited from the parent — Claude Code surfaces it in
  `~/.claude/debug/<session-id>.txt`.

---

## B. Configuration model

### Environment variables

All loaded from `~/.claude/channels/teams/.env` at boot, with real
environment winning. `.env` is chmod-0600 on every load.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `TEAMS_BOT_APP_ID` | Yes | — | App (client) ID of the Entra ID app backing the bot. GUID. |
| `TEAMS_BOT_APP_PASSWORD` | Yes | — | Client secret. Treat as a high-value credential. |
| `TEAMS_BOT_APP_TYPE` | Yes | `SingleTenant` | One of `SingleTenant`, `MultiTenant`, `UserAssignedMSI`. |
| `TEAMS_BOT_TENANT_ID` | When SingleTenant | — | Tenant GUID. |
| `TEAMS_BOT_LISTEN_HOST` | No | `127.0.0.1` | Loopback by default. |
| `TEAMS_BOT_LISTEN_PORT` | No | `3978` | Standard Bot Framework default. |
| `TEAMS_BOT_ENDPOINT_URL` | No (recommended) | — | Public HTTPS URL on the Azure Bot resource. Diagnostics + status output. |
| `TEAMS_STATE_DIR` | No | `~/.claude/channels/teams` | For multi-instance setups. |
| `TEAMS_ACCESS_MODE` | No | — | `static` pins access at boot, disables pairing. |

### User-data directory

```
~/.claude/channels/teams/
├── .env                      # credentials (mode 0600)
├── access.json               # allowlist + pending pairings (mode 0600)
├── approved/                 # drop dir — terminal-side approvals land here
│   └── <aadObjectId>         #   file contents = serialised ConversationReference
└── inbox/                    # downloaded attachments, if/when implemented
```

Location matches the official channels' convention
(`~/.claude/channels/<name>/`). The plugin discovers this by reading
`HOME` — Claude Code itself doesn't pass a "plugin data dir" through the
MCP wire. Telegram's source confirms this: `homedir()` + path join, no
helper from the SDK.

### `~/.claude/settings.json` snippet (operator-side)

```jsonc
{
  // Master switch. Required on Team/Enterprise plans (admins set it).
  // Pro/Max users without an org skip this check entirely.
  "channelsEnabled": true,

  // Optional: limit which plugins can act as channels. Omit to use the
  // Anthropic default allowlist (which this plugin isn't on, yet).
  "allowedChannelPlugins": [
    { "marketplace": "<your-marketplace>", "plugin": "teams" }
  ]
}
```

Until this plugin is on Anthropic's approved allowlist, individual
operators on Pro/Max launch with
`--dangerously-load-development-channels plugin:teams@<marketplace>`. See
[`docs/installation.md`](installation.md).

---

## C. Pairing flow

Mirrors the Telegram model. Differences are noted inline.

### Step by step

1. **Operator adds the bot to Teams.** Either by installing the bot app
   package (manifest .zip) into their Teams client, or by sideloading
   through "Apps → Manage your apps → Upload an app". The bot is `personal`
   scope only in v1.
2. **Operator DMs the bot** for the first time.
3. **CloudAdapter validates the inbound JWT.** Failure = 401 returned to
   the Bot Connector, activity dropped.
4. **gate() examines `activity.from.aadObjectId`.** Not in `allowFrom`,
   `dmPolicy === 'pairing'`. The gate:
   - Caps `pending` at 3.
   - Generates `randomBytes(3).toString('hex')` — 6 hex chars.
   - Persists the ConversationReference (returned by the SDK's
     `TurnContext.getConversationReference`). Used later to send the
     "paired" confirmation proactively.
   - Sends a single reply: *"Pairing required — run in Claude Code:
     `/teams:access pair <code>`"*.
   - Drops the message itself.
5. **Operator approves in their terminal**: `/teams:access pair <code>`.
   The skill (terminal-side, not channel-side):
   - Reads `access.json`.
   - Looks up `pending[<code>]`. If expired or missing, refuses.
   - Adds `aadObjectId` to `allowFrom`, deletes the `pending` entry.
   - Writes a file at `approved/<aadObjectId>` containing the serialised
     ConversationReference.
6. **Plugin polls `approved/` every 5s.** For each file:
   - Restore the ConversationReference.
   - `adapter.continueConversation(ref, ctx => ctx.sendActivity('Paired. Say hi to Claude.'))`.
   - `rm` the file regardless of send outcome.
7. **Subsequent DMs flow.**

### Allowlist storage

JSON file, atomic write via `<file>.tmp` + `rename`. Schema in
[`docs/security.md`](security.md#allowlist-schema). SQLite considered and
rejected for v1 — operator should be able to hand-edit, and the file is
tiny.

### Revocation

`/teams:access remove <aadObjectId>` deletes from `allowFrom`. Next
inbound activity from that user is dropped silently. There is no
notification to the revoked user — silent revocation is correct.

For a destructive "kill switch":

```
/teams:access policy disabled
```

Drops every inbound activity, including from previously allowlisted users.

### Per-conversation vs global allowlist

v1: **global to DMs**. Once `aadObjectId` is allowlisted, every DM from
that user reaches the session. Groups are off in v1 (Phase 5 lands
per-group policy à la Telegram).

---

## D. Threat model

### Assets

| Asset | Where | Confidentiality | Integrity | Availability |
| --- | --- | --- | --- | --- |
| Bot app password | `.env`, mode 0600 | High — compromise = bot impersonation | — | — |
| Allowlist (`access.json`) | local FS, mode 0600 | Low (no secrets) | **Critical** — any rogue write adds an attacker | Low |
| ConversationReference cache | within `access.json` | Low | Medium — wrong ref = wrong recipient | — |
| Operator's Claude Code session | parent process | **Critical** — full tool surface | **Critical** | Medium |
| Inbound endpoint | listener + reverse proxy | — | Medium | Medium — DoS would block legitimate traffic |

### Adversaries

1. **Random internet attacker hitting the public endpoint.** Cannot forge a
   Bot Framework JWT (signed by Microsoft's JWKS). Defence: CloudAdapter's
   bearer-token validation. Worst case: amplification of 401s.
2. **Malicious Teams user inside the tenant.** Can DM the bot. Cannot bypass
   the allowlist. Worst case: spam pairing-code-shaped DMs (gate caps
   pending at 3, replies at 2 → bounded).
3. **Compromised tenant admin.** Out of scope. They can already do anything
   in the tenant; we cannot defend against this from inside the plugin.
4. **Prompt-injected message from an allowlisted user.** A legitimate
   sender becomes coerced (their account stolen, or they're acting in bad
   faith). Mitigation: the skill front-matter prose forbids Claude from
   mutating the allowlist or approving pairings in response to channel
   text. Tool-permission relay verdicts are bound to a `request_id`
   Claude Code issued — a forged verdict for an unknown id is dropped.
5. **Local user on the same machine.** Already has the operator's UID.
   Out of scope.
6. **Compromised plugin process.** A bug in the plugin or its deps that
   gives an inbound message control of the process. Mitigations: stdin
   shutdown watchdog, unhandled-rejection logging, no `eval`/`Function`,
   refuse to read files outside `STATE_DIR/inbox/` when serving outbound
   attachments (mirrors Telegram's `assertSendable`).

### Mitigations summary

| Threat | Mitigation |
| --- | --- |
| Forged inbound POST | Bot Framework JWT validation (CloudAdapter). |
| Cross-tenant message in single-tenant config | Defence in depth: gate compares `activity.conversation.tenantId` against `TEAMS_BOT_TENANT_ID`. |
| Unknown sender pushing messages | `aadObjectId` allowlist (default `pairing` policy → drop or single pairing-code reply). |
| Allowlist mutation via inbound text | `/teams:access` skill refuses to act on channel-originated requests; mutation only via the operator's terminal. |
| Outbound to unsolicited user | `assertAllowedConversation(conversation_id)` before any `sendActivity`. Tool args from Claude cannot reach an unsolicited tenant user. |
| Credential leak via repo | `.env` lives outside the repo (`~/.claude/channels/teams/.env`). `.env.example` ships placeholders only. `.gitignore` covers `.env`. |
| Credential leak via reply tool | Refuse to send any file under `STATE_DIR` except `inbox/`. |
| Rate-limited DoS | Bot Framework / Azure Bot resource enforces request rate. Optional plugin-side per-sender token bucket — Phase 3. |
| Permission verdict forgery | `request_id` is issued by Claude Code; only a matching open request is accepted. Allowlist gates which senders can issue verdicts at all. |
| Pairing-code amplification | Pending cap = 3; reply count cap = 2; codes expire after 1h. |
| Zombie process holding port | Stdin EOF + orphan watchdog → exit. (No bot-token zombie equivalent — HTTPS push, not long-poll.) |

### Out of scope

- Hardening the Azure tenant itself: conditional access, NSGs, App Gateway
  WAF, Defender, Sentinel alerting.
- TLS / certificate management at the reverse proxy.
- Tenant-side message-retention / DLP policies.
- Endpoint detection on the host running Claude Code.

We point at Microsoft's documentation for these in
[`docs/security.md`](security.md) and stay in our lane.

---

## E. Message flow

### Inbound (Teams → Claude)

1. Teams client sends activity to Microsoft.
2. Bot Connector signs and POSTs to `<TEAMS_BOT_ENDPOINT_URL>/api/messages`.
3. Operator's reverse proxy forwards to `127.0.0.1:<TEAMS_BOT_LISTEN_PORT>`.
4. CloudAdapter handles JWT validation. Failure → 401 / drop.
5. Plugin's turn handler reads `{ from.aadObjectId, conversation.id,
   conversation.tenantId, text, attachments, id, timestamp }`.
6. Defence-in-depth tenant check: if `TEAMS_BOT_APP_TYPE === 'SingleTenant'`
   and `conversation.tenantId !== TEAMS_BOT_TENANT_ID`, drop and log.
7. `gate({ aadObjectId, conversation })` evaluates:
   - `drop`: silent (log to stderr with reason).
   - `pair`: send pairing-code reply, persist `pending` entry.
   - `deliver`: continue.
8. Build the channel notification:
   - `content` = `activity.text` (or `(image)`-style placeholder when only
     attachments — Phase 2 detail).
   - `meta`:
     - `conversation_id` (snake_case — meta keys must be `[A-Za-z0-9_]+`).
     - `message_id` (activity.id).
     - `user` (sanitised `activity.from.name`).
     - `aad_object_id`.
     - `ts` (ISO-8601 from `activity.timestamp`).
9. Permission-reply intercept: if the text matches the
   `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$` regex, emit
   `notifications/claude/channel/permission` with the parsed verdict —
   never forward as chat. (Sender is already gate-approved; allowlist
   members are trusted with permission verdicts.)
10. Otherwise emit `notifications/claude/channel`.

### Outbound (Claude → Teams)

1. Claude calls `reply` tool with `{ conversation_id, text, reply_to? }`.
2. `assertAllowedConversation(conversation_id)` — refuse if it's not in
   `allowFrom` (DMs) or `groups` (Phase 5).
3. Restore the ConversationReference (recorded on first allowlisted
   inbound; persisted in `access.json` keyed by `aadObjectId`).
4. `adapter.continueConversation(ref, async ctx => { ... })`.
5. Inside the turn, `await ctx.sendActivity({ type: 'message', text })` —
   optionally with `replyToId` when `reply_to` is set.
6. Return the activity ID to Claude as the tool result.

### Error paths

| Condition | Behaviour |
| --- | --- |
| Unauthorised sender (not allowlisted, not pairing) | Silent drop, stderr line. |
| CloudAdapter token verification failure | 401 returned to Bot Connector, no notification, stderr line. |
| Cross-tenant activity in single-tenant config | Silent drop, stderr line. |
| `reply` tool called with non-allowlisted `conversation_id` | Tool returns `isError: true` with reason. No outbound. |
| `reply` to a conversation the bot no longer has access to (user uninstalled) | Bot Framework returns 403 / 404 → tool returns `isError: true` with the framework's message. |
| Claude Code not connected | Notifications are dropped by Claude Code with no error to us (docs explicit). No retry; we don't queue. |
| Plugin process killed | Stdin shutdown handler runs → exit. Any outbound activities mid-flight are dropped. |
| Permission verdict for unknown / closed `request_id` | Notification emitted; Claude Code silently drops. |

---

## F. Open questions

The following decisions are unresolved. Adnan to pick before Phase 2 starts.

### F.1 — Multi-tenant support in v1?

**Default**: single-tenant only, with `allowedTenantId` enforced in the
gate. Multi-tenant is harder to reason about (any tenant could DM, and
the JWT path treats them as legitimate). The Telegram analogue ships with
no tenant model at all, so we'd be ahead either way.

**Alternative**: support `TEAMS_BOT_APP_TYPE=MultiTenant` from v1 for users
who run a cross-tenant bot. Phase 1 docs would need a clearer warning
about the broader threat surface.

**Recommendation**: single-tenant only in v1. Multi-tenant as a Phase 4
config-only flag once the security review has approved single-tenant.

### F.2 — Entra group allowlist?

**Default**: allowlist is a flat list of `aadObjectId` values.

**Alternative**: allowlist entries can be either an Object ID or an Entra
group ID. The gate resolves group membership via Microsoft Graph
(`GET /groups/{id}/members`). Cached locally with a TTL. More
enterprise-friendly (HR-managed groups), but adds Graph API perms
(`GroupMember.Read.All`) to the app registration — a meaningful step up in
the principal's privileges.

**Recommendation**: defer to Phase 4. Ship flat list in v1; add group
resolution as an opt-in feature once we've validated the threat surface
of the broader Graph permission.

### F.3 — Pairing UX: self-service DM vs terminal-confirm

Both Telegram and Discord settled on "DM bot → code → operator types
`/<channel>:access pair <code>`". This document specifies the same.

**Alternative considered**: bot replies with an Adaptive Card "request
access" button, the click POSTs to the plugin, which forwards a
yes/no-style permission relay to Claude. Tighter UX but introduces a
button-based mutation path — exactly the surface the prompt-injection
fence is designed to keep out of the channel.

**Recommendation**: stick with the Telegram pattern. The friction is the
feature — the only mutation path runs through the operator's terminal.

### F.4 — Adaptive Cards in v1?

Teams' first-class structured reply primitive. Two questions:

- **Inbound cards**: low value in v1 — DMs are predominantly text.
  Attachment-style cards (form submissions) carry their own auth model.
  Skip.
- **Outbound cards**: Claude could return a card for richer responses
  (code blocks, links, expand-collapse). Genuine value, but the schema is
  large and easy to get wrong. Adds surface.

**Recommendation**: v1 ships plain text only. `reply` tool stays simple.
Phase 5 adds an opt-in `format: 'card'` mode.

### F.5 — Per-conversation vs global allowlist

For DMs this is a non-question — a DM is between one user and the bot,
and the conversation is uniquely keyed by `aadObjectId`. For groups
(Phase 5) the choice matters: do we allowlist whole conversations, or
each member within a group?

**Recommendation**: defer to Phase 5. Use Telegram's pattern — per-group
config (`requireMention`, `allowFrom: aadObjectId[]`).

### F.6 — Webhook hosting in the plugin vs operator-provided reverse proxy

This document says the operator provides the reverse proxy. Alternative:
the plugin embeds an HTTPS listener and the operator provides only a
certificate path. We'd avoid the deployment-shape doc but pull in TLS
lifecycle.

**Recommendation**: keep TLS outside the plugin. Document the reverse
proxy / tunnel options. The Bot Framework SDK's expected deployment
pattern is also "listener behind something" — App Service does the TLS,
not the bot code.

### F.7 — Permission relay verdict via card buttons vs text?

Telegram uses inline buttons (callback queries). The channels reference
text-reply path (`yes <id>` / `no <id>`) is universally supported.

**Recommendation**: ship the text-reply path in v1, add a card-button
variant in Phase 5 alongside Adaptive Card support. Phase 2 must
*authenticate the replier* before declaring the `claude/channel/permission`
capability — covered by the allowlist gate.

### F.8 — Single-shot pairing-code reply vs follow-up reminders

Telegram chases up to 2 times (initial + one reminder). The same
behaviour is reasonable here.

**Recommendation**: match Telegram. `replies: 1` on creation, capped at 2.

---

## G. Phased delivery plan

### Phase 1 — Research & design *(this deliverable)*

- ✅ Repo scaffold (`/home/ccuser/workspace/claude-channel-teams/`)
- ✅ Reference reading + write-up ([`research-notes.md`](research-notes.md))
- ✅ Design doc (this file) + threat model
- ✅ Stubs that compile, no behaviour
- ☐ Adnan reviews and answers the open questions

### Phase 2 — Core wire

- `config.ts` — env loader, validator, `.env` permissions hardening
- `teams/auth.ts` — CloudAdapter, tenant pinning, defence-in-depth check
- `teams/adapter.ts` — listener + JWT-validated turn handler
- `pairing/allowlist.ts` — `access.json` r/w, atomic save, prune
- `pairing/pair.ts` — gate logic, code generation, approval polling
- `teams/reply.ts` — `reply` tool, outbound gate, ConversationReference
  restore
- `server.ts` — wire MCP capabilities to tool + notification handlers
- Manual test against a real Azure Bot resource (Adnan's tenant). Exit:
  one full round trip: DM → pair → DM → response → reply lands in Teams.

### Phase 3 — Hardening + pairing UX polish

- Permission relay (`claude/channel/permission`)
- `/teams:configure` skill (writes `.env`, drives lockdown nudge)
- `/teams:access` skill (pair/deny/allow/remove/policy)
- Pairing rate-limit caps (pending=3, replies=2, code TTL=1h)
- Tenant ID defence-in-depth audit log
- `STATIC` access mode
- Attachment handling for inbound (download to `inbox/`, `image_path` meta)
- Outbound file attachments via `reply`'s `files` arg
- Audit-log lines for every gate decision

### Phase 4 — Docs & marketplace submission

- Polished install guide for a fresh Azure tenant
- Architecture diagram (replace ASCII with real SVG)
- Security review checklist for Anthropic submission
- Conformance check against Telegram / Discord / iMessage published patterns
- CI: typecheck + lint + minimal integration test
- Submit to `claude-plugins-official` marketplace

### Phase 5 — Stretch

- Adaptive Card support (inbound + outbound)
- Group / channel-scope bot (Teams `team` and `groupChat` scopes)
- `mentionPatterns` for groups (mirrors Telegram)
- Entra group-membership allowlist (resolved via Graph, cached)
- Reactions (`react` tool — Teams' six standard reactions)
- Message editing (`edit_message` tool — useful for "working…" progress
  updates)
- Multi-instance / multi-tenant config

---

## H. Conformance checklist (for marketplace submission)

For reference — Phase 4 will work through this against the actual
submission process. Drawn from the channels reference and the official
plugins' patterns:

- [ ] `experimental['claude/channel']: {}` declared on the MCP server.
- [ ] `tools` capability declared (two-way channel).
- [ ] `instructions` string warns against prompt-injection-driven access
      mutation.
- [ ] `instructions` documents the `<channel>` tag attributes and how to
      route replies back.
- [ ] Sender allowlist enforced before any `mcp.notification()` call.
- [ ] Allowlist mutation possible only via terminal-side skill.
- [ ] `claude/channel/permission` declared only after the sender check is
      verified.
- [ ] Permission-reply regex matches the canonical
      `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$` shape.
- [ ] No stdout writes outside the MCP transport.
- [ ] Credentials read from `.env` in the plugin's state dir, mode 0600.
- [ ] Atomic writes for `access.json`.
- [ ] Graceful shutdown on stdin EOF + SIGTERM/INT/HUP.
- [ ] Orphan watchdog (`process.ppid` change / stdin destroyed).
- [ ] Outbound gate (`assertAllowedConversation`) mirrors inbound gate.
- [ ] Attachment sending refuses paths inside the plugin's state dir.
- [ ] No third-party telemetry / phone-home.
- [ ] License: MIT or Apache 2.0.
- [ ] Generalised docs — no hard-coded tenant IDs, bot names, hostnames.
