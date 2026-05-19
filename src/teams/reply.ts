/**
 * Outbound reply path — the `reply` tool implementation.
 *
 * Phase 2: text replies rendered as markdown (Teams' supported subset:
 * bold, italic, headers, bullet/numbered lists, links, inline code, code
 * blocks, blockquotes — tables and HTML are not reliably supported).
 * Adaptive Cards, attachments, and the `react` / `edit_message` tools are
 * out of scope (design decisions F.4 / Phase 5).
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
import type { TypingPump } from './typingPump.js'

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
  /** Optional typing-indicator pump — stopped when a reply lands. */
  typingPump?: TypingPump
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
    // Stop the typing pump first. We do this before the network send so the
    // indicator clears even if the connector call throws — flapping
    // "is typing…" forever after a failure is worse than the failure itself.
    deps.typingPump?.stop(conversationId)
    // `continueConversationAsync` rehydrates the conversation context using
    // the stored reference and our pinned credentials. The SDK takes care of
    // grabbing a fresh service-to-service token (cached by app id).
    await deps.adapter.continueConversationAsync(
      deps.config.appId,
      ref,
      async turnContext => {
        await turnContext.sendActivity({ type: 'message', text, textFormat: 'markdown' })
      },
    )
    process.stderr.write(
      `teams channel: reply sent conv=${conversationId} len=${text.length}\n`,
    )
  }

  return { sendReply, assertAllowedConversation }
}
