# claude-channel-teams

Microsoft Teams channel plugin for [Claude Code][cc] — bridge a Teams bot
into a running Claude Code session, in the same style as the official
[Telegram][tg], [Discord][dc], and [iMessage][im] channels.

> **Status: feature-complete v1.** The plugin is in active production
> use. It boots, authenticates Bot Framework inbound, gates by Entra ID
> Object ID, replies via the `reply` tool, drives the full pairing flow
> through the `/teams:access` operator skill, and relays tool-approval
> prompts from Claude Code to Teams as text-reply verdicts. Not yet
> submitted to the official `claude-plugins-official` marketplace —
> community plugin until then.

## What it does

Send a 1:1 chat to your Teams bot from any device signed into Teams. The
message arrives in your Claude Code session as a `<channel>` event.
Claude reads it, does the work against your local files, and replies
through the same Teams thread.

- **Inbound** — Bot Framework activities are JWT-validated by the
  framework, gated against an Entra ID Object ID allowlist, and pushed
  into the session as `notifications/claude/channel`.
- **Outbound** — Claude calls the `reply` tool; the plugin posts back
  through Bot Framework. The outbound side enforces
  `assertAllowedConversation` so a prompt-injected Claude can't be
  tricked into talking to a non-allowlisted conversation.
- **Pairing** — an unknown DM triggers a one-time pairing code. The
  operator reviews and approves it from their Claude Code terminal with
  `/teams:access pair <pair_id> <code>`. Two halves are required (one
  from terminal listing, one from the user's DM) so no single
  prompt-injected message can supply both.
- **Permission relay** — tool-approval prompts from Claude Code are
  relayed to the primary allowlisted Teams conversation. The operator
  replies `yes <id>` or `no <id>` from Teams and the verdict is fed
  back to Claude.

## Prerequisites

- An Entra ID tenant where you can register an application
- An Azure subscription with permission to create an Azure Bot resource
- A reachable HTTPS endpoint (your own reverse proxy or tunnel)
- [Bun][bun] on the machine running Claude Code
- A persistent session manager if you want self-healing (the included
  `examples/systemd/` shows a supervisor + tmux pattern)

See [`docs/installation.md`](docs/installation.md) for the end-to-end
walkthrough and [`docs/azure-setup.md`](docs/azure-setup.md) for the
Azure portal / `az` CLI steps.

## Install

```sh
# 1. Register the plugin's marketplace (a local directory containing this
#    repo as a plugin entry — see docs/installation.md for the layout).
/plugin marketplace add <your-marketplace-name> <local-marketplace-dir>

# 2. Install and reload.
/plugin install teams@<your-marketplace-name>
/reload-plugins
```

Launch Claude Code with the channel attached:

```sh
claude --channels plugin:teams@<your-marketplace-name>
```

Until this plugin is on the official Anthropic allowlist (or you
whitelist it yourself in managed settings under
`allowedChannelPlugins`), it must be loaded with
`--dangerously-load-development-channels` — see the Claude Code
[channels reference][cref] and [`docs/installation.md`](docs/installation.md)
for the headless-friendly managed-settings pattern.

## Security

The threat model and hardening guidance live in
[`docs/security.md`](docs/security.md). Short version:

- Never run an ungated Teams bot — anyone with a routable identity in an
  addressable tenant could DM it.
- The plugin defaults to pairing (closed-door) policy and refuses
  outbound replies to conversations not in the allowlist.
- The `/teams:access` operator skill is the only path that mutates the
  allowlist; it explicitly refuses to act on requests that arrived via
  channel notifications (prompt-injection fence in the SKILL.md
  front-matter).

## Project layout

```
src/                  # MCP server + Bot Framework wiring + permission relay
skills/               # /teams:access operator skill
tests/                # Bun test suite (39 tests)
docs/                 # Design, security, install, architecture, pairing
examples/             # settings.json snippet + systemd unit + supervisor
scripts/              # Optional helper scripts
.claude-plugin/       # Anthropic plugin manifest
.mcp.json             # MCP server entry consumed by Claude Code
```

## Contributing

PRs welcome on bug fixes, docs, threat-model gaps, dependency hardening,
group / channel-scope support (currently `personal` scope only),
Adaptive Card variants of the permission prompt, or marketplace
submission paperwork.

If you find a corner the canonical Telegram / Discord / iMessage plugins
handle that we don't — flag it. Cross-pollination between channels
makes the whole feature better.

## Licence

MIT. See [`LICENSE`](LICENSE).

[cc]: https://code.claude.com/docs/en/overview
[tg]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
[dc]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord
[im]: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage
[cref]: https://code.claude.com/docs/en/channels-reference
[bun]: https://bun.sh
