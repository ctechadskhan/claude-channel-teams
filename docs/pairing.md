# Pairing

End-user-facing description of how access is bootstrapped, mirroring the
Telegram model. This is the document you point a colleague at when you
want to add them as a sender.

## TL;DR

1. The operator gives you the bot's Teams handle.
2. You DM the bot. The bot replies with a 6-character pairing code.
3. The operator runs `/teams:access pair <code>` in their terminal.
4. The bot DMs you "Paired. Say hi to Claude." Subsequent DMs go through.

That's the whole flow.

## Why a code?

The bot has no way to know in advance which Entra ID Object ID belongs to
which person. Pairing captures that ID automatically: the bot sees your
identity on your first DM and offers it to the operator for approval.

The operator types the code in their own terminal session — not in Teams —
so a stranger who happens to find the bot's handle can't talk themselves
into the allowlist. Approval is operator-driven.

## What can go wrong

| Symptom | Cause |
| --- | --- |
| Bot says "Pairing required" again on every DM | The operator hasn't run `/teams:access pair <code>` yet. The bot is patient — give them a heads-up. |
| Bot stops replying with a code after a few tries | Anti-spam cap. After 2 reminder replies for the same sender, the bot goes silent until the code is approved or expires (1 hour). |
| Bot doesn't reply at all | The operator's Claude Code session may not be running with channels enabled, or the bot is in `allowlist`/`disabled` policy. Ask them. |
| Different code each time you DM | Earlier codes expired (1 hour TTL). The new one is fine; tell the operator the latest one. |

## What the operator sees

```
You (Teams):       hi
Bot:               Pairing required — run in Claude Code: /teams:access pair a4f91c

Operator types in their terminal:
  /teams:access pair a4f91c

Bot:               Paired. Say hi to Claude.
```

## After pairing

Subsequent DMs from your account flow straight into the operator's
running Claude Code session. The operator may also lock the bot to
`allowlist` policy at this point — no behavioural difference for you,
but it stops the bot replying with pairing codes to other Teams users.

## Permission prompts (optional)

If the operator has enabled permission relay (a per-deployment choice),
the bot may DM you something like:

> 🔐 Permission: Bash — Claude wants to run: `git push origin main`
>
> Reply `yes <id>` or `no <id>`

Where `<id>` is a five-letter code. Reply with the exact format — `yes
abcde` or `no abcde` — and Claude Code applies your verdict. Allowlist
senders carry session-equivalent trust here: only the operator should
allowlist people they want to be able to authorise that kind of action.

## Revocation

The operator can revoke your access with `/teams:access remove
<aad-object-id>`. Your DMs will be dropped silently from that point. You
won't be notified.

## Privacy

The bot only sees messages addressed to it (DMs in v1; groups in a future
release would have stricter @-mention requirements). It does not read
your other Teams conversations or your inbox. The operator does see every
message you DM the bot — that's the whole point of the bridge.
