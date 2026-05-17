/**
 * Outbound reply path — the `reply` tool implementation.
 *
 * Phase 2: plain text replies only. Adaptive Cards, attachments, and the
 * `react` / `edit_message` tools are out of scope (design decisions F.4 /
 * Phase 5).
 *
 * The outbound side mirrors the inbound gate (`assertAllowedConversation`).
 * A compromised or prompt-injected Claude calling `reply` with a
 * `conversation_id` it pulled from elsewhere must be refused — the conversation
 * has to have been seeded by an allowlisted inbound activity at receive time,
 * AND the original sender must still be on the allowlist when the reply fires.
 */

import { type CloudAdapter, type ConversationReference } from 'botbuilder'
import type { Allowlist } from '../pairing/allowlist.js'
import type { Config } from '../config.js'
import type { ConversationRefStore } from './conversationRefs.js'

export class UnknownConversationError extends Error {
  constructor(conversationId: string) {
    super(
      `unknown conversation_id: ${conversationId}. ` +
        `The plugin doesn't have a conversation reference for this thread — ` +
        `likely after a plugin restart. Ask the user to send a fresh Teams message to re-seed.`,
    )
    this.name = 'UnknownConversationError'
  }
}

export class ConversationNotAllowedError extends Error {
  constructor(conversationId: string) {
    super(
      `conversation_id ${conversationId} is not allowlisted — refusing to send. ` +
        `The originating sender must be on the allowlist at the time of reply.`,
    )
    this.name = 'ConversationNotAllowedError'
  }
}

export interface ReplyDeps {
  config: Config
  adapter: CloudAdapter
  allowlist: Allowlist
  refs: ConversationRefStore
}

export function createReplySender(deps: ReplyDeps) {
  /**
   * The outbound gate.
   *
   * A conversation reference is only stored after an inbound activity passes
   * the allowlist (see adapter.ts). But the allowlist can be mutated between
   * receive and reply — an operator can remove an ID while a Claude turn is
   * in flight. We re-check on the way out so a freshly-revoked user can't
   * receive a trailing reply.
   *
   * This is mirrored on Telegram as `assertAllowedChat`.
   */
  function assertAllowedConversation(conversationId: string): {
    ref: Partial<ConversationReference>
  } {
    const stored = deps.refs.get(conversationId)
    if (!stored) throw new UnknownConversationError(conversationId)
    // Re-check the allowlist at send time. Defends against revocations.
    if (!deps.allowlist.isAllowed(stored.aadObjectId)) {
      throw new ConversationNotAllowedError(conversationId)
    }
    return { ref: stored.ref }
  }

  async function sendReply(conversationId: string, text: string): Promise<void> {
    const { ref } = assertAllowedConversation(conversationId)
    // `continueConversationAsync` rehydrates the conversation context using
    // the stored reference and our pinned credentials. The SDK takes care of
    // grabbing a fresh service-to-service token (cached by app id).
    await deps.adapter.continueConversationAsync(
      deps.config.appId,
      ref,
      async turnContext => {
        await turnContext.sendActivity({ type: 'message', text })
      },
    )
    process.stderr.write(
      `teams channel: reply sent conv=${conversationId} len=${text.length}\n`,
    )
  }

  return { sendReply, assertAllowedConversation }
}
