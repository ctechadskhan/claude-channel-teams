/**
 * Outbound reply path — the tools registered for Claude to call.
 *
 * Phase 1 stub. Tools planned for v1:
 *
 *   - reply        — send a text message to a Teams conversation.
 *                    Args: { conversation_id, text, reply_to? }
 *                    Auto-chunks at the Teams message-length limit (currently
 *                    no documented hard cap; chunk on readability ~3000 chars).
 *
 *   - react        — apply a Teams reaction to a previous message.
 *                    Args: { conversation_id, message_id, reaction }
 *                    Teams accepts: like, heart, laugh, surprised, sad, angry.
 *
 *   - typing       — fire a typing indicator (no-arg helper, scoped to the
 *                    current conversation_id). Useful around long tool runs.
 *
 * All outbound paths must call assertAllowedConversation(conversation_id)
 * first — mirrors Telegram's assertAllowedChat. A compromised or
 * mis-prompted Claude must not be able to send to an arbitrary unsolicited
 * tenant user. The conversation must already be in the allowlist (DMs) or
 * groups map.
 *
 * Adaptive Card support is deferred to Phase 5. The shape is small enough
 * we could land it earlier if Adnan wants it — note in design.md open
 * questions.
 */

export {}
