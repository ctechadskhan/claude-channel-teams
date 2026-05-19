# Outbound file transfers — design

**Status:** draft — awaiting implementation
**Date:** 2026-05-19
**Author:** Hermes (under Adnan)

## Problem

The `reply` tool sends plain text or markdown only. Hermes has no way to hand a file to the Teams user. Inbound file transfers (Teams → VPS) shipped with Phase 5 attachments, but the reverse direction is missing.

Teams 1:1 bots have no "send raw bytes into the chat" primitive. The platform offers two routes:

1. **`FileConsentCard`** — the bot asks permission to upload, the user accepts, the file lands in their personal OneDrive, a confirmation card appears in the chat.
2. **Card with download URL** — the bot sends a card whose action targets a URL the Teams client can fetch.

The OneDrive route was explicitly rejected: the user wants files to arrive in Teams and be saveable locally without OneDrive in the loop.

## Solution

A download-URL pattern: the plugin writes the file to a token-gated outbox on the VPS, sends an Adaptive Card whose Download action points at `https://hermes.vcshosted.uk/files/<token>`, and serves the file once before deleting it.

### Tool surface

New MCP tool `send_file`.

```jsonc
{
  "conversation_id": "string",          // required — the inbound channel id
  "path": "string",                     // OR
  "content": "string (base64)",         // one of path|content required
  "filename": "string",                 // required when content is used; optional with path (defaults to basename)
  "caption": "string"                   // optional — short text shown alongside the card
}
```

The tool rejects payloads larger than 50 MB (matching the inbound cap). When `path` is used the file is *copied* into the outbox — the original is not moved, so source files survive.

### Outbox

- Location: `/home/ccuser/workspace/outbox/` (mode 0700).
- Layout: `outbox/<token>/<filename>` — one subdirectory per token so the token gates access by directory rather than just filename.
- Boot-time sweep: on plugin start, the outbox directory is recursively wiped. The sweep refuses to run unless the configured path is a direct child of `/home/ccuser/` (or whatever `SENDABLE_FILES_ROOT` is set to) — defence against a misconfigured `OUTBOX_DIR=/etc` wiping the system. Crashed or restarted plugins do not leak files from previous boots.

### Token store

- Random 32-byte URL-safe string (`crypto.randomBytes(32).toString('base64url')`).
- In-memory `Map<token, { dir, filename, mime, sizeBytes, expiresAt }>`.
- Default TTL: 30 minutes. Env override: `OUTBOX_TTL_SECONDS`.
- **Multi-use within TTL.** Microsoft's link-safety infrastructure server-side-fetches every URL in a card before delivering the card to the recipient (verified in `caddy/access.log` — a `52.x.x.x` Microsoft IP issued a `GET` 12 s before the human click). A single-use token gets consumed by that preview; the user click then hits 410. The token therefore stays live until the TTL expires; the 256-bit secret + short TTL is the security model.
- Periodic sweeper deletes expired entries every minute.

### HTTP endpoint

- New route on the plugin's existing `Bun.serve` listener at `127.0.0.1:3979`.
- `GET /files/<token>` — looks up the token, streams the file with `Content-Type` (from the stored MIME) and `Content-Disposition: attachment; filename="<original>"`. The token remains live; repeat requests within the TTL serve the same file.
- `410 Gone` for unknown or expired tokens. (Discriminating "unknown" vs "expired" leaks information; we collapse them.)
- `HEAD /files/<token>` returns the same status without a body — useful for the Teams client's preflight.
- The route ignores trailing query strings.
- No JWT validation. Teams' client cannot carry bot credentials when fetching a card action URL; the token *is* the secret. The short TTL + single-use semantics are the mitigation.

### Caddy

Add a new handle to `hermes.vcshosted.uk`:

```caddy
handle /files/* {
    reverse_proxy localhost:3979
}
```

Reload: `sudo systemctl reload caddy`.

This is Ares' patch (privileged). Adnan has authorised it for this feature.

### Adaptive Card

Adaptive Card schema v1.4 (the maximum Teams supports).

```jsonc
{
  "type": "AdaptiveCard",
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "version": "1.4",
  "body": [
    { "type": "TextBlock", "text": "<filename>", "weight": "Bolder", "wrap": true },
    { "type": "TextBlock", "text": "<size> · <mime>", "isSubtle": true, "spacing": "None" }
  ],
  "actions": [
    { "type": "Action.OpenUrl", "title": "Download", "url": "https://hermes.vcshosted.uk/files/<token>" }
  ]
}
```

The `caption` (when provided) is sent as the `text` field on the outer `message` activity, so it appears above the card in chat.

### Security model

- `send_file` runs `assertAllowedConversation(conversation_id)` — the same outbound gate `reply` uses. A prompt-injected Claude cannot send files to a conversation that has not been allowlisted.
- The download URL is bearer-tokenised: anyone in possession of `<token>` can fetch the file until it expires or is consumed. Token entropy: 256 bits.
- The Teams client renders the action button URL but does not expose it to other users in the chat (1:1 personal scope only — no group/channel posts in this plugin).
- The `path` argument to `send_file` is canonicalised to an absolute path and checked against a configurable allow-root (`SENDABLE_FILES_ROOT`, defaults to `/home/ccuser/workspace/`). Files outside that root are refused — defence against a prompt-injected Claude being tricked into exfiltrating `/etc/shadow`.

### Errors

- `path` does not exist or is unreadable → tool error, no token minted, no chat message sent.
- `path` is outside `SENDABLE_FILES_ROOT` → tool error.
- File size > 50 MB → tool error, no token minted.
- `conversation_id` not allowlisted at send time → existing `ConversationNotAllowedError` thrown by the gate.
- Download endpoint: any error during file streaming after headers have been sent → connection torn down, token consumed (no retry). This is a deliberate choice — leaving the token live after a partial send invites replays.

## Components

| File | Change |
|---|---|
| `src/teams/outbox.ts` | **new** — token store + outbox directory management |
| `src/teams/files.ts` | **new** — Adaptive Card builder for the download card |
| `src/teams/adapter.ts` | edit — register the `GET /files/<token>` route on `Bun.serve` |
| `src/server.ts` | edit — instantiate outbox, register `send_file` MCP tool, wire outbox shutdown into the existing `shutdown()` |
| `src/config.ts` | edit — read `OUTBOX_TTL_SECONDS`, `SENDABLE_FILES_ROOT` |
| `tests/outbox.test.ts` | **new** — token mint/consume/expire/sweep/path-allow-root |
| `tests/files-route.test.ts` | **new** — HTTP handler happy path + 410 cases |
| `tests/send-file.test.ts` | **new** — tool gate enforcement, size cap, payload shape |
| `/etc/caddy/Caddyfile` | edit — `/files/*` reverse-proxy handle |

## Testing

TDD throughout (per existing plugin convention). The outbox and Adaptive Card builder are pure modules — fully unit-testable without `Bun.serve`. The HTTP route is exercised by injecting a fake outbox into the listener test as we do for the existing gate tests. End-to-end verification: from a Claude prompt over Teams, request a known file, click Download, confirm browser save.

## Out of scope

- Delivery receipts (knowing whether the user actually downloaded).
- Multi-use links — single-use only in v1.
- Re-issuing a token if the link expired before the user clicked.
- Inline image rendering via `Image` adaptive blocks — covered by markdown today.
- Submission of file activity events upstream to Claude (the plugin doesn't surface "Adnan downloaded the file" to me).

## Open questions

None at draft time. Defaults to be reviewed in PR:

| Decision | Default | Override |
|---|---|---|
| Outbox path | `/home/ccuser/workspace/outbox/` | `OUTBOX_DIR` |
| Token TTL | 30 minutes | `OUTBOX_TTL_SECONDS` |
| Send allow-root | `/home/ccuser/workspace/` | `SENDABLE_FILES_ROOT` |
| Max file size | 50 MB | not configurable in v1 |
