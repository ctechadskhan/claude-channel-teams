/**
 * Pairing flow logic — turns an unknown DM into either a pending entry or a
 * drop, and processes terminal-side approvals via the approved/ drop dir.
 *
 * Phase 1 stub. The flow:
 *
 *   1. Unknown sender DMs the bot.
 *   2. gate() sees no entry in access.allowFrom, dmPolicy is 'pairing':
 *      - Cap pending at 3 to avoid amplification spam.
 *      - Generate a 6-char hex code (randomBytes(3).toString('hex')).
 *      - Store: { aadObjectId, conversationReference, createdAt,
 *                 expiresAt: now + 1h, replies: 1 }.
 *      - Reply once with the code, drop the message itself.
 *      - Cap follow-up replies at 2 — after that, silent drop.
 *
 *   3. Operator runs /teams:access pair <code> in their Claude Code terminal.
 *      The skill (not this code) moves the aadObjectId from `pending` to
 *      `allowFrom` and drops a file at <stateDir>/approved/<aadObjectId>
 *      containing the serialised ConversationReference.
 *
 *   4. checkApprovals() polls the approved/ dir every 5s. For each file:
 *      - Restore the ConversationReference.
 *      - adapter.continueConversation(ref, ctx => ctx.sendActivity('Paired.'))
 *      - Remove the file regardless of send outcome.
 *
 *   5. Subsequent DMs from that aadObjectId pass straight through.
 *
 * Pairing codes use a-f0-9 (hex) here, not the 5-letter perm-reply alphabet —
 * those are distinct domains. Permission-reply IDs are issued by Claude Code
 * and read off the wire; pairing codes are issued by us and typed by humans.
 */

export {}
