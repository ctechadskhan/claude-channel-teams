# claude-channel-teams

Microsoft Teams channel plugin for [Claude Code][cc] — bridge a Teams bot
into a running Claude Code session, in the same style as the official
[Telegram][tg], [Discord][dc], and [iMessage][im] channels.

> **Status: Phase 1 — scaffold and design only.** Implementation lands in
> Phase 2. The skeleton compiles; nothing is wired to Teams yet. See
> [`docs/design.md`](docs/design.md) for the design currently under review.

## What it does (target behaviour)

Send a 1:1 chat to your Teams bot from any device signed into Teams. The
message arrives in your Claude Code session wrapped in a `<channel>` tag.
Claude reads it, does the work against your local files, and replies through
the same Teams thread.

- **Inbound**: Bot Framework activities → JWT-validated by the framework →
  gated against an Entra ID Object ID allowlist → pushed into the session as
  `notifications/claude/channel`.
- **Outbound**: Claude calls the `reply` tool; the plugin posts back through
  Bot Framework.
- **Pairing**: an unknown DM triggers a one-time pairing code. The operator
  approves it from their Claude Code terminal with `/teams:access pair <code>`.
- **Permission relay**: tool-approval prompts can optionally be answered from
  Teams (`yes <id>` / `no <id>`).

## Prerequisites

- An Entra ID tenant where you can register an application.
- An Azure subscription with permission to create an Azure Bot resource.
- A reachable HTTPS endpoint (your own reverse proxy or tunnel).
- [Bun][bun] on the machine running Claude Code.

See [`docs/installation.md`](docs/installation.md) for the end-to-end
walkthrough and [`docs/azure-setup.md`](docs/azure-setup.md) for the Azure
portal / `az` CLI steps.

## Install (planned)

```
/plugin marketplace add <future-marketplace>
/plugin install teams@<future-marketplace>
/reload-plugins
/teams:configure
```

Then restart with channels enabled:

```sh
claude --channels plugin:teams@<future-marketplace>
```

Until this plugin is on the official approved allowlist it must be loaded with
`--dangerously-load-development-channels` — see the Claude Code
[channels reference][cref].

## Security

The threat model and hardening guidance live in [`docs/security.md`](docs/security.md).
Short version: never run an ungated Teams bot — anyone in an addressable
tenant can DM it. The plugin defaults to `pairing` policy and refuses
outbound replies to conversations not in the allowlist.

## Project layout

```
src/                  # MCP server + Bot Framework wiring (Phase 1: stubs)
docs/                 # Design, security, install, architecture, pairing
examples/             # settings.json snippet + systemd unit
scripts/              # Optional helper scripts
.claude-plugin/       # Anthropic plugin manifest
.mcp.json             # MCP server entry consumed by Claude Code
```

## Contributing

Phase 1 is research and design; PRs are welcome on `docs/design.md` and
adjacent material. Implementation contributions wait until the design is
approved.

## Licence

MIT. See [`LICENSE`](LICENSE).

[cc]: https://code.claude.com/docs/en/overview
[tg]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
[dc]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord
[im]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage
[cref]: https://code.claude.com/docs/en/channels-reference
[bun]: https://bun.sh
