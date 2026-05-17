/**
 * Bot Framework adapter wrapper — the inbound side.
 *
 * Phase 1 stub. Real implementation:
 *
 *   - Spins up a restify (or Bun.serve) listener on TEAMS_BOT_LISTEN_HOST:PORT.
 *   - Routes POST /api/messages through the CloudAdapter so JWT validation runs
 *     before any user code touches the payload.
 *   - For each authenticated Activity:
 *       1. Extract { aadObjectId, conversation.id, conversation.tenantId, text }.
 *       2. Run the gate (pairing / allowlist / disabled).
 *       3. On deliver → emit notifications/claude/channel with content + meta.
 *       4. On pair    → send the pairing code as a reply (single-shot, no
 *                       multiple chases).
 *       5. On drop    → silent, with a stderr audit line including reason.
 *   - Persist ConversationReferences for paired users so the plugin can send
 *     proactive replies and pairing-approval confirmations.
 *
 * The listener should also expose:
 *   - GET /healthz — liveness, no auth required, returns 200 if process up.
 *
 * Nothing else. The bot's command surface (commands inside DMs) lives in
 * reply.ts to keep responsibilities split.
 */

export {}
