# Installation

End-to-end install guide. Placeholders in angle brackets — substitute your
own values.

## Prerequisites

- A Microsoft 365 tenant where you can register an Entra ID application.
- Permissions to create an Azure Bot resource (Bot Channels Registration).
- A reachable public HTTPS endpoint at a hostname you control
  (`<bot-public-hostname>`). Options: your own reverse proxy on a VPS,
  a Cloudflare Tunnel, Azure App Service, ngrok (dev only).
- [Bun](https://bun.sh) installed on the host running Claude Code.
- Claude Code v2.1.80 or later (channels feature).
- For Team / Enterprise plans: an admin must enable
  [`channelsEnabled`](https://code.claude.com/docs/en/channels#enterprise-controls)
  and either add this plugin to `allowedChannelPlugins` or use the
  development flag (see step 6).

## Steps

### 1. Register the Entra ID application + Azure Bot resource

Follow [`docs/azure-setup.md`](azure-setup.md) for the portal and `az` CLI
recipe. By the end you should have:

- `<app-id>` — the application (client) ID GUID.
- `<app-secret>` — a client secret value (you only see this once; save it).
- `<tenant-id>` — your Entra ID tenant GUID.
- Azure Bot resource with the **Microsoft Teams** channel enabled.
- Messaging endpoint set to `https://<bot-public-hostname>/api/messages`.

### 2. Add the bot to Teams

Build a Teams app package (`manifest.json` + icons, zipped) and either:

- **Personal use**: in Teams, *Apps* → *Manage your apps* → *Upload an app
  for me or my teams* → upload the .zip.
- **Org-wide**: ask your tenant admin to publish to the org app catalogue.

The bot must be `personal` scope only for v1 of this plugin.

A sample manifest template lives in
[`docs/azure-setup.md`](azure-setup.md#teams-app-manifest).

### 3. Stand up a reverse proxy

Terminate TLS at your hostname and forward to the plugin's local listener.
Minimal Caddyfile:

```caddyfile
<bot-public-hostname> {
  reverse_proxy 127.0.0.1:3978
}
```

The plugin listens on `127.0.0.1:3978` by default
(`TEAMS_BOT_LISTEN_HOST` / `TEAMS_BOT_LISTEN_PORT`). Run Caddy / nginx as a
system service. See [`examples/systemd/`](../examples/systemd/) for a
template unit covering the plugin (the proxy is your platform's standard
config).

For dev work, `cloudflared tunnel run` or `ngrok http 3978` are quicker.

### 4. Install the plugin

```text
/plugin marketplace add <your-marketplace>
/plugin install teams@<your-marketplace>
/reload-plugins
```

> Until this plugin is on the Anthropic-curated approved list, it will not
> register as a channel without the development flag (step 6).

### 5. Configure the bot credentials

Write the credentials to `~/.claude/channels/teams/.env`. Use
[`.env.example`](../.env.example) as the template, then
`chmod 600 ~/.claude/channels/teams/.env` so the file is operator-only.

Restart Claude Code so the plugin picks up the new file.

### 6. Start Claude Code with channels enabled

During the research preview, custom plugins use the development flag:

```sh
claude --dangerously-load-development-channels plugin:teams@<your-marketplace>
```

If you're an admin who has added this plugin to `allowedChannelPlugins`
the standard `--channels` flag works:

```sh
claude --channels plugin:teams@<your-marketplace>
```

You should see a startup line on stderr:

```
teams channel: listening on 127.0.0.1:3978
teams channel: tenant pinned to <tenant-id> (SingleTenant)
```

### 7. Pair your account

DM the bot from Teams. The bot replies:

> Pairing required — run in Claude Code: `/teams:access pair <code>`

Back in your terminal:

```
/teams:access pair <code>
```

The bot sends a follow-up: *"Paired. Say hi to Claude."* Subsequent DMs
flow into the session.

### 8. Lock down

Once everyone who should be able to reach you is paired, flip the policy:

```
/teams:access policy allowlist
```

After this, unknown senders are dropped silently — no pairing-code replies
go out. This is the steady state. Pairing mode is for capturing IDs, not
for staying on.

## Verification

A successful round-trip:

```
You (Teams):  hey, can you list the files in this directory?
Claude (terminal): [reads the message, calls LS, calls reply]
You (Teams):  <file list arrives>
```

Stderr should show:

```
teams channel: delivered conv=<id> from=<aadObjectId>
teams channel: reply sent conv=<id> id=<activity-id>
```

If the message doesn't arrive: see
[`docs/security.md`](security.md#troubleshooting) and the Claude Code debug
log at `~/.claude/debug/<session-id>.txt`.
