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
[plugin: restify route]
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
  ▼ gate({ aadObjectId, conversation })
    │
    ├─ drop      ──→ stderr audit line; nothing else
    ├─ pair      ──→ send "Pairing required: /teams:access pair <code>"
    └─ deliver   ──→ build channel notification (next box)
                       │
                       ▼ permission-reply regex match?
                       ├─ yes ─→ notifications/claude/channel/permission
                       └─ no  ─→ notifications/claude/channel
```

## Message flow — outbound

```
Claude
  │
  ▼ calls reply tool { conversation_id, text, reply_to? }
[plugin: CallToolRequestSchema handler]
  │
  ▼ assertAllowedConversation(conversation_id)   ──fail──→ return isError: true
  │
  ▼ restore ConversationReference from access.json (keyed by aadObjectId)
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
├── access.json          # allowlist + pairings (0600)
├── approved/            # drop dir — set by /teams:access
│   └── <aadObjectId>    # contents = ConversationReference JSON
└── inbox/               # attachment downloads (Phase 3)
    └── <ts>-<unique>.<ext>
```

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
│   ├── server.ts           # MCP + tool registration
│   ├── config.ts           # env loader + validator
│   ├── types.ts            # shared types
│   ├── teams/
│   │   ├── adapter.ts      # HTTP listener + turn handler
│   │   ├── auth.ts         # CloudAdapter wiring
│   │   └── reply.ts        # outbound tools
│   └── pairing/
│       ├── allowlist.ts    # access.json r/w
│       └── pair.ts         # gate + code generation + approval polling
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
| Operator approves pairing | `/teams:access` skill drops a file at `approved/<id>`. Plugin's poll loop picks it up within ~5s, sends confirm, removes file. |
| Operator runs `/reload-plugins` | Claude Code restarts MCP subprocesses. Plugin re-reads `.env` and `access.json`. |
| Operator quits Claude Code | stdio closes. Plugin's shutdown handler fires. Listener unbinds, process exits. |
| Plugin crash (unhandled error) | `process.on('uncaughtException')` logs, process exits. Claude Code surfaces "MCP server disconnected" — operator restarts. |
