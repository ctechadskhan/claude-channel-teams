/**
 * TypingPump tests — exercise the per-conversation typing-indicator pump.
 *
 * The pump exists so a Teams user sees "Hermes is typing…" while Claude is
 * thinking. Teams' built-in typing indicator only lasts ~10–15 s, so the
 * pump fires an immediate typing activity on `start` and refreshes
 * periodically until `stop` is called (or a safety cap expires).
 *
 * We unit-test by injecting a `sendTyping` callback that counts calls — no
 * BotAdapter required.
 */

import { describe, expect, test } from 'bun:test'

import { createTypingPump } from '../src/teams/typingPump'

/** Sleep helper — tests use very short intervals to keep the suite fast. */
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe('typing pump', () => {
  test('sends an immediate typing activity when started', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 1000,
      maxDurationMs: 5000,
    })
    pump.start('conv-1', {} as never)
    // The first send is fire-and-forget; give the microtask queue a turn.
    await wait(10)
    expect(sent).toBe(1)
    pump.stop('conv-1')
  })

  test('sends periodic typing activities until stopped', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 20,
      maxDurationMs: 5000,
    })
    pump.start('conv-1', {} as never)
    await wait(75)
    // Expect immediate + at least 2 refreshes inside 75ms at 20ms interval.
    expect(sent).toBeGreaterThanOrEqual(3)
    pump.stop('conv-1')
  })

  test('stop() halts further activity sends', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 20,
      maxDurationMs: 5000,
    })
    pump.start('conv-1', {} as never)
    await wait(25)
    const sentAtStop = sent
    pump.stop('conv-1')
    await wait(80)
    expect(sent).toBe(sentAtStop)
  })

  test('start() on an already-active conversation is a no-op', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 1000,
      maxDurationMs: 5000,
    })
    pump.start('conv-1', {} as never)
    pump.start('conv-1', {} as never)
    pump.start('conv-1', {} as never)
    await wait(10)
    // Three starts, but only the first one fires the immediate activity
    // and registers a timer.
    expect(sent).toBe(1)
    pump.stop('conv-1')
  })

  test('stop() on an unknown conversation does not throw', () => {
    const pump = createTypingPump({
      sendTyping: async () => {},
      intervalMs: 1000,
      maxDurationMs: 5000,
    })
    expect(() => pump.stop('never-started')).not.toThrow()
  })

  test('multiple conversations pump independently', async () => {
    const sent: Record<string, number> = { a: 0, b: 0 }
    const pump = createTypingPump({
      sendTyping: async ref => {
        const id = (ref as { __id?: string }).__id ?? 'unknown'
        sent[id] = (sent[id] ?? 0) + 1
      },
      intervalMs: 1000,
      maxDurationMs: 5000,
    })
    pump.start('conv-a', { __id: 'a' } as never)
    pump.start('conv-b', { __id: 'b' } as never)
    await wait(10)
    expect(sent.a).toBe(1)
    expect(sent.b).toBe(1)
    // Stopping one must not affect the other's registration.
    pump.stop('conv-a')
    pump.stop('conv-b')
  })

  test('auto-stops after maxDurationMs', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 15,
      maxDurationMs: 40,
    })
    pump.start('conv-1', {} as never)
    await wait(120)
    const sentAfterCap = sent
    await wait(60)
    expect(sent).toBe(sentAfterCap)
  })

  test('stopAll() halts every active conversation', async () => {
    let sent = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        sent++
      },
      intervalMs: 20,
      maxDurationMs: 5000,
    })
    pump.start('conv-a', {} as never)
    pump.start('conv-b', {} as never)
    await wait(25)
    const sentAtStop = sent
    pump.stopAll()
    await wait(80)
    expect(sent).toBe(sentAtStop)
  })

  test('sendTyping rejection does not crash the pump', async () => {
    let attempts = 0
    const pump = createTypingPump({
      sendTyping: async () => {
        attempts++
        throw new Error('boom')
      },
      intervalMs: 15,
      maxDurationMs: 5000,
    })
    pump.start('conv-1', {} as never)
    await wait(50)
    // The pump must keep ticking despite every send failing.
    expect(attempts).toBeGreaterThanOrEqual(2)
    pump.stop('conv-1')
  })
})
