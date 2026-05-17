# Architecture

Reference for how the plugin fits together. Diagrams are ASCII for
portability — Phase 4 replaces them with SVG before marketplace submission.

## Component diagram

```
External                  Boundary                  Local process
────────                  ────────                  ─────────────

Teams client ─→ MS Teams ─→ Bot Connector ─HTTPS POST→ reverse proxy
                                                            │
                                                            ▼ HTTP loopback
                                                  ┌─────────────────┐
                                                  │ teams plugin    │
                                                  │  ┌───────────┐  │
                                                  │  │ HTTP recv │  │
                                                  │  └─────┬─────┘  │
                                                  │        ▼        │
                                                  │  ┌───────────┐  │
                                                  │  │CloudAdapt │  │ JWT
                                                  │  └─────┬─────┘  │ tenant pin
                                                  │        ▼        │
                                                  │  ┌───────────┐  │
                                                  │  │  gate()   │  │ allowlist
                                                  │  └─────┬─────┘  │ pairing
                                                  │        ▼        │
                                                  │  ┌───────────┐  │
                                                  │  │MCP notify │  │
                                                  │  └─────┬─────┘  │
                                                  └────────┼────────┘
                                                           ▼ stdio
                                                  ┌─────────────────┐
                                                  │  Claude Code    │
                                                  │  session        │
                                                  └─────────────────┘
```

The plugin process is a single Bun binary spawned by Claude Code. Its
lifetime equals the Claude Code session: when stdio closes, the plugin
shuts down.

## Message flow — inbound

```
Teams user
  │
  ▼ sends DM
[MS Teams service]
  │
  ▼ POST /api/messages  (Bearer JWT from Microsoft's JWKS)
[reverse proxy]
  │
  ▼ HTTP /api/messages
[plugin: Bun.serve route]
  │
  ▼ JSON parse + activity.type sanity check   ──fail──→ 400 (info-log)
  │
  ▼ CloudAdapter.process(req, res, turnHandler)
    │
    ▼ JWT validation       ──fail──→ 401 → bot connector
    │
    ▼ ok
[turnHandler(ctx)]
  │
  ▼ tenantId === TEAMS_BOT_TENANT_ID?    ──no──→ drop, log
  │
  ▼ allowlist.isAllowed(aadObjectId)?
    │
    ├─ no ──→ pending.recordIncoming()
    │           ├─ send_initial / send_reminder ──→ sendPairingDm(...)
    │           └─ suppress                       ──→ stderr line, drop
    │
    └─ yes ──→ refs.put(conversationId, ref, aadObjectId)
                │
                ▼ PERMISSION_REPLY_RE.exec(text)
                ├─ match for known id ──→ permission.resolve()
                │                          → notifications/claude/channel/permission
                ├─ match for unknown id ──→ fall through to channel event
                └─ no match              ──→ notifications/claude/channel
```

## Message flow — permission relay (server-initiated outbound)

```
Claude Code
  │
  ▼ notifications/claude/channel/permission_request
[plugin: mcp.setNotificationHandler]
  │
  ▼ permission.onRequest({ request_id, tool_name, ... })
    │
    ▼ refs.mostRecentConversationId() && allowlist.isAllowed()?
    ├─ no  ──→ drop, stderr line ("no allowlisted conversation seen")
    └─ yes ──→ sendDm(conv, formatPromptText(req))
                │
                ▼ setTimeout(5min) — clears slot on no-reply
                ▼ pending.set(request_id, { conv, askedAt, ... })
```

The reverse direction (operator's `yes <id>` / `no <id>` reply) is the
"permission-reply intercept" branch in the inbound flow above.

## Message flow — outbound

```
Claude
  │
  ▼ calls reply tool { conversation_id, text, reply_to? }
[plugin: CallToolRequestSchema handler]
  │
  ▼ assertAllowedConversation(conversation_id)   ──fail──→ return isError: true
  │
  ▼ restore ConversationReference from in-memory store (keyed by conversation_id)
  │
  ▼ adapter.continueConversation(ref, async ctx => {
      await ctx.sendActivity({ type: 'message', text, replyToId: reply_to })
    })
  │
  ▼ return { content: [{ type: 'text', text: 'sent (id=<activity-id>)' }] }
```

## File layout (runtime)

```
~/.claude/channels/teams/
├── .env                 # credentials (0600)
├── allowlist.json       # AAD ObjectID allowlist (0600, atomic writes)
├── pending.json         # in-flight pairing requests (0600, atomic writes)
└── inbox/               # attachment downloads (Phase 5)
    └── <ts>-<unique>.<ext>
```

Note: there is no `approved/` drop directory in this plugin. The Telegram
plugin uses a file-drop hand-off because the access skill there only
writes JSON. We expose the pairing flow as MCP tools instead, so the
skill calls `approve_pair` and the server does the allowlist update +
confirmation DM in one transaction.

## File layout (repo)

```
claude-channel-teams/
├── .claude-plugin/
│   └── plugin.json         # Anthropic plugin manifest
├── .mcp.json               # MCP server entry — used by Claude Code
├── package.json            # Bun + TS, minimal deps
├── tsconfig.json
├── .env.example
├── .gitignore
├── LICENSE                 # MIT
├── README.md
├── src/
│   ├── server.ts           # MCP wiring — tools, permission relay, boot
│   ├── config.ts           # env loader + validator
│   ├── types.ts            # shared types
│   ├── teams/
│   │   ├── adapter.ts      # HTTP listener + turn handler + intercepts
│   │   ├── auth.ts         # CloudAdapter wiring
│   │   ├── conversationRefs.ts # in-memory ConversationReference cache
│   │   └── reply.ts        # `reply` tool, outbound gate
│   ├── pairing/
│   │   ├── allowlist.ts    # allowlist.json r/w
│   │   └── pair.ts         # pending.json r/w, gate decision logic
│   └── permission/
│       └── relay.ts        # permission_request → DM, yes/no → verdict
├── skills/
│   └── teams/
│       └── access/
│           └── SKILL.md    # /teams:access operator skill (Phase 3)
├── docs/
│   ├── installation.md
│   ├── azure-setup.md
│   ├── security.md
│   ├── architecture.md     ← this file
│   ├── pairing.md
│   ├── research-notes.md
│   └── design.md           # Phase 1 reviewer-facing
├── examples/
│   ├── settings.json.example
│   └── systemd/
│       └── claude-channel-teams.service
└── scripts/
    └── setup.sh
```

## Deployment shapes

We support three operator deployment patterns. The plugin's local
behaviour is identical in all three — only TLS termination differs.

### Shape A — VPS with reverse proxy (recommended for steady use)

```
Internet ─→ <bot-public-hostname> ─→ Caddy/nginx ─→ 127.0.0.1:3978 ─→ plugin
```

Pros: stable, simple to reason about, no third party in the trust chain.
Cons: needs a public IP / DNS, certificate lifecycle (handled by Caddy/
ACME).

### Shape B — Cloudflare Tunnel

```
Internet ─→ <bot-public-hostname> ─→ Cloudflare edge ─→ cloudflared (local) ─→ 127.0.0.1:3978 ─→ plugin
```

Pros: no public ingress on the host, Cloudflare handles TLS.
Cons: third party in the trust chain. Acceptable for personal use.

### Shape C — ngrok / dev tunnel (development only)

```
Internet ─→ <random>.ngrok.io ─→ ngrok edge ─→ ngrok agent ─→ 127.0.0.1:3978 ─→ plugin
```

Useful for first-bring-up. Don't leave a dev tunnel running long-term.

## Lifecycle

| Event | Behaviour |
| --- | --- |
| Claude Code spawns the plugin | Bun runs `start` script → `bun install` → `bun src/server.ts`. Plugin connects MCP over stdio, binds local listener, prints startup line. |
| First inbound activity | CloudAdapter validates the JWT, turn handler runs, gate evaluates, notification or drop. |
| Operator approves pairing | `/teams:access pair <pair_id> <code>` calls `approve_pair` over MCP. Server transfers the entry from `pending.json` to `allowlist.json` and sends the "Paired" confirm via the live ConversationReference, all in one tool call. |
| Operator runs `/reload-plugins` | Claude Code restarts MCP subprocesses. Plugin re-reads `.env`, `allowlist.json`, and `pending.json`. In-memory ConversationReferences are lost — users may need to send a fresh DM to re-seed. |
| Operator quits Claude Code | stdio closes. Plugin's shutdown handler fires. Listener unbinds, process exits. |
| Plugin crash (unhandled error) | `process.on('uncaughtException')` logs, process exits. Claude Code surfaces "MCP server disconnected" — operator restarts. |
