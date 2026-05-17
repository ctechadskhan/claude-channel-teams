# claude-channel-teams

Microsoft Teams channel plugin for [Claude Code][cc] — bridge a Teams bot
into a running Claude Code session, in the same style as the official
[Telegram][tg], [Discord][dc], and [iMessage][im] channels.

> **Status: Phase 3 — pairing skill and permission relay complete.** The
> plugin boots, authenticates Bot Framework inbound, gates by Entra ID
> Object ID, replies via the `reply` tool, drives the full pairing flow
> through the `/teams:access` skill, and relays tool-approval prompts from
> Claude Code to Teams (text-reply verdicts). The remaining work for v1 is
> docs polish, conformance audit, and marketplace submission — see
> [`docs/design.md`](docs/design.md).

## What it does

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
  reviews and approves it from their Claude Code terminal with
  `/teams:access pair <pair_id> <code>` — both halves are required as the
  prompt-injection defence.
- **Permission relay**: tool-approval prompts from Claude Code are relayed
  to the primary allowlisted Teams conversation. The operator replies
  `yes <id>` or `no <id>` from Teams and the verdict is fed back to Claude.

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
src/                  # MCP server + Bot Framework wiring + permission relay
skills/               # /teams:access operator skill
tests/                # Bun test suite
docs/                 # Design, security, install, architecture, pairing
examples/             # settings.json snippet + systemd unit
scripts/              # Optional helper scripts
.claude-plugin/       # Anthropic plugin manifest
.mcp.json             # MCP server entry consumed by Claude Code
```

## Contributing

Phase 3 ships the pairing skill, MCP-driven allowlist management, and the
`claude/channel/permission` text-reply relay. PRs welcome on bug fixes,
docs, threat-model gaps, dependency hardening, group / channel-scope
support, or Adaptive Card variants of the permission prompt.

## Licence

MIT. See [`LICENSE`](LICENSE).

[cc]: https://code.claude.com/docs/en/overview
[tg]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
[dc]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord
[im]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage
[cref]: https://code.claude.com/docs/en/channels-reference
[bun]: https://bun.sh
