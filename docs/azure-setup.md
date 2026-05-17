# Azure setup

How to register the Entra ID application, create the Azure Bot resource,
and add the Microsoft Teams channel. Placeholders in angle brackets.

This document is generalised — substitute your own tenant, subscription, and
hostnames. Nothing here is specific to any one organisation.

## Prerequisites

- An Entra ID tenant where you can register applications.
- An Azure subscription with rights to create an *Azure Bot* resource.
- A reachable public HTTPS hostname at `<bot-public-hostname>`.
- The `az` CLI (`az --version` ≥ 2.55) signed in with
  `az login --tenant <tenant-id>`.

## Path A: Portal walkthrough

1. **Register the application.** Azure portal → *Microsoft Entra ID* →
   *App registrations* → *New registration*.
   - Name: `<bot-display-name>` (operator's choice — appears nowhere
     end-user-facing).
   - Supported account types: *Accounts in this organizational directory
     only* (single tenant).
   - Redirect URI: leave blank.
   - On creation, note the **Application (client) ID** → `<app-id>` and
     **Directory (tenant) ID** → `<tenant-id>`.
2. **Create a client secret.** *Certificates & secrets* → *New client secret*.
   - Description: `<bot-handle>-secret-<yyyy-mm>`.
   - Expiry: per your tenant policy. 6 or 12 months is typical; calendar
     a rotation reminder.
   - **Copy the value immediately** → `<app-secret>`. You cannot see it
     again.
3. **Create the Azure Bot resource.** Portal → *Create a resource* →
   search "Azure Bot" → *Create*.
   - Bot handle: `<bot-handle>` (must be unique across Azure).
   - Subscription / resource group: your choice.
   - Pricing tier: F0 (free) is enough for personal use.
   - Type of App: **Single Tenant**.
   - App ID: existing → `<app-id>`.
   - Tenant ID: `<tenant-id>`.
4. **Set the messaging endpoint.** Once the Bot is provisioned → *Settings*
   → *Configuration* → *Messaging endpoint*:
   `https://<bot-public-hostname>/api/messages` → *Apply*.
5. **Add the Microsoft Teams channel.** *Channels* → *Microsoft Teams* →
   accept terms → *Save*.

## Path B: `az` CLI

```sh
# Variables — substitute your own
TENANT_ID=<tenant-id>
SUBSCRIPTION=<subscription-id>
RESOURCE_GROUP=<resource-group>
BOT_NAME=<bot-handle>
APP_NAME=<bot-display-name>
ENDPOINT=https://<bot-public-hostname>/api/messages

az login --tenant "$TENANT_ID"
az account set --subscription "$SUBSCRIPTION"

# 1. Register the app + create a secret
APP_ID=$(az ad app create \
  --display-name "$APP_NAME" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)

APP_SECRET=$(az ad app credential reset \
  --id "$APP_ID" --append \
  --years 1 \
  --query password -o tsv)

echo "APP_ID=$APP_ID"
echo "APP_SECRET=$APP_SECRET"   # capture immediately

# 2. Service principal (required for Bot Service)
az ad sp create --id "$APP_ID"

# 3. Create the Azure Bot resource
az bot create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --app-type SingleTenant \
  --appid "$APP_ID" \
  --tenant-id "$TENANT_ID" \
  --endpoint "$ENDPOINT" \
  --sku F0

# 4. Enable the Microsoft Teams channel
az bot msteams create \
  --name "$BOT_NAME" \
  --resource-group "$RESOURCE_GROUP"
```

## Teams app manifest

Microsoft Teams needs an "app package" (`manifest.json` + two icons,
zipped) before users can install the bot. Minimal template:

```jsonc
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "<manifest-guid>",
  "developer": {
    "name": "<your-name-or-org>",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "name": {
    "short": "<bot-display-name>",
    "full": "<bot-display-name>"
  },
  "description": {
    "short": "Bridge to Claude Code",
    "full": "Personal bridge between Microsoft Teams and a running Claude Code session."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "accentColor": "#4F46E5",
  "bots": [
    {
      "botId": "<app-id>",
      "scopes": ["personal"],
      "supportsFiles": false,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": ["<bot-public-hostname>"]
}
```

- `<manifest-guid>` is a freshly generated GUID — `uuidgen` or
  `python -c 'import uuid; print(uuid.uuid4())'`.
- `<app-id>` must match the Entra ID application's client ID.
- Icons are PNG; the colour icon is 192×192, outline 32×32.

Zip `manifest.json` + the two icons (flat, no subdir) into
`<bot-handle>.zip` and upload via *Teams → Apps → Manage your apps →
Upload an app for me or my teams*.

## What goes into `.env`

After Path A or B you have everything needed for
`~/.claude/channels/teams/.env`:

```env
TEAMS_BOT_APP_ID=<app-id>
TEAMS_BOT_APP_PASSWORD=<app-secret>
TEAMS_BOT_APP_TYPE=SingleTenant
TEAMS_BOT_TENANT_ID=<tenant-id>
TEAMS_BOT_ENDPOINT_URL=https://<bot-public-hostname>/api/messages
```

`chmod 600 ~/.claude/channels/teams/.env` once written.

## Multi-tenant variation

Not recommended for v1, but supported for advanced use:

- Path A: at registration, choose *Accounts in any organizational directory*.
- Path B: `--sign-in-audience AzureADMultipleOrgs` and
  `--app-type MultiTenant` (omit `--tenant-id`).
- `.env`: `TEAMS_BOT_APP_TYPE=MultiTenant`, omit `TEAMS_BOT_TENANT_ID`.

See [`docs/security.md`](security.md#multi-tenant-considerations) for the
extra hardening this requires.
