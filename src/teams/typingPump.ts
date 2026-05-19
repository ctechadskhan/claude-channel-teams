/**
 * Per-conversation typing-indicator pump.
 *
 * Teams' typing indicator times out client-side after ~10–15 s, so a single
 * `typing` activity isn't enough to cover a Claude turn that runs longer.
 * The pump fires an immediate indicator on `start` then refreshes on a
 * timer until `stop` is called or a safety cap expires.
 *
 * Tests inject a `sendTyping` callback. In production the server passes a
 * closure that uses `CloudAdapter.continueConversationAsync` to send a
 * `{ type: 'typing' }` activity through the stored conversation reference —
 * the same path `reply.ts` uses for outbound messages.
 */

import type { ConversationReference } from 'botbuilder'

export interface TypingPumpDeps {
  sendTyping: (ref: Partial<ConversationReference>) => Promise<void>
  intervalMs: number
  maxDurationMs: number
}

export interface TypingPump {
  start(conversationId: string, ref: Partial<ConversationReference>): void
  stop(conversationId: string): void
  stopAll(): void
}

interface Active {
  ref: Partial<ConversationReference>
  interval: ReturnType<typeof setInterval>
  cap: ReturnType<typeof setTimeout>
}

export function createTypingPump(deps: TypingPumpDeps): TypingPump {
  const active = new Map<string, Active>()

  function fire(ref: Partial<ConversationReference>) {
    deps.sendTyping(ref).catch(() => {})
  }

  function start(conversationId: string, ref: Partial<ConversationReference>) {
    if (active.has(conversationId)) return
    fire(ref)
    const interval = setInterval(() => fire(ref), deps.intervalMs)
    // Safety cap: if `stop` is never called (Claude crashes mid-turn, the
    // reply tool errors, etc.) we'd flap typing forever. Auto-stop after
    // maxDurationMs.
    const cap = setTimeout(() => stop(conversationId), deps.maxDurationMs)
    active.set(conversationId, { ref, interval, cap })
  }

  function stop(conversationId: string) {
    const a = active.get(conversationId)
    if (!a) return
    clearInterval(a.interval)
    clearTimeout(a.cap)
    active.delete(conversationId)
  }

  function stopAll() {
    for (const id of Array.from(active.keys())) stop(id)
  }

  return { start, stop, stopAll }
}
