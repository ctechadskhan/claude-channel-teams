/**
 * In-memory store of conversation references.
 *
 * Bot Framework's outbound path (`adapter.continueConversationAsync`) requires
 * a previously-captured `ConversationReference`. We record one for every
 * activity that clears the allowlist gate, then look it up when Claude calls
 * the `reply` tool.
 *
 * Phase 2: in-memory only. A plugin restart loses the references. Operators
 * who depend on long-running threads will see this as `UnknownConversationError`
 * on the first reply after a restart — they need to send a new message to
 * re-seed the reference. Persistence is a stretch goal for a later phase.
 *
 * We also track which AAD ObjectID originally seeded each reference. The
 * outbound gate (`assertAllowedConversation`) uses this mapping to refuse
 * replies to conversations whose original sender is no longer on the
 * allowlist — defends against a prompt-injected Claude calling `reply` with
 * a conversation_id captured from elsewhere.
 */

import type { ConversationReference } from 'botbuilder'

interface StoredRef {
  /** The Bot Framework reference used by `continueConversationAsync`. */
  ref: Partial<ConversationReference>
  /** AAD Object ID of the sender at the time of capture. Lowercase. */
  aadObjectId: string
  /** Last time we saw an inbound from this conversation (ms epoch). */
  lastSeen: number
}

export interface ConversationRefStore {
  put(conversationId: string, ref: Partial<ConversationReference>, aadObjectId: string): void
  get(conversationId: string): StoredRef | undefined
  size(): number
  /**
   * Return the conversation_id of the most-recently-active conversation.
   * Used by the permission relay to pick the "primary operator" target in v1
   * (single-operator scope; see docs/security.md).
   */
  mostRecentConversationId(): string | undefined
}

export function createConversationRefStore(): ConversationRefStore {
  const store = new Map<string, StoredRef>()
  return {
    put(conversationId, ref, aadObjectId) {
      // We index by conversation.id because that's what Claude will pass
      // back via the reply tool. Lowercase the AAD ID at storage time so
      // the outbound gate's compare is symmetric with the inbound store.
      store.set(conversationId, {
        ref,
        aadObjectId: aadObjectId.toLowerCase(),
        lastSeen: Date.now(),
      })
    },
    get(conversationId) {
      return store.get(conversationId)
    },
    size() {
      return store.size
    },
    mostRecentConversationId(): string | undefined {
      let bestId: string | undefined
      let bestTs = -Infinity
      for (const [id, stored] of store) {
        if (stored.lastSeen > bestTs) {
          bestTs = stored.lastSeen
          bestId = id
        }
      }
      return bestId
    },
  }
}
