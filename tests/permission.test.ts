/**
 * Permission relay tests.
 *
 * Covers:
 *   - Inbound `yes <id>` resolves a pending request with allow.
 *   - Inbound `no <id>` resolves with deny.
 *   - An inbound message that matches the regex but for an unknown id falls
 *     through and is forwarded as a regular channel event.
 *   - Malformed responses ("yes please", "yes 1234") fall through.
 *   - Timeout drops the pending slot after the configured interval.
 *   - Multiple in-flight requests are isolated.
 *   - onRequest drops itself when no allowlisted conversation has been seen.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BotAdapter, TurnContext, type Activity } from 'botbuilder'

import {
  PERMISSION_REPLY_RE,
  createPermissionRelay,
  formatPromptText,
} from '../src/permission/relay'
import { createAllowlist } from '../src/pairing/allowlist'
import { createConversationRefStore } from '../src/teams/conversationRefs'
import { createPendingStore } from '../src/pairing/pair'
import { makeTurnHandler } from '../src/teams/adapter'

const SENDER_ID = '00000000-0000-4000-8000-000000000001'
const TENANT_ID = '00000000-0000-4000-8000-000000000002'

class NoopAdapter extends BotAdapter {
  async sendActivities(): Promise<any> { return [] }
  async updateActivity(): Promise<void> {}
  async deleteActivity(): Promise<void> {}
  async continueConversation(): Promise<void> {}
}

function makeActivity(text: string): Activity {
  return {
    type: 'message',
    text,
    id: 'msg-1',
    timestamp: new Date('2026-05-17T19:30:00Z'),
    from: { id: 'user-1', name: 'Operator', aadObjectId: SENDER_ID },
    conversation: { id: 'conv-abc', tenantId: TENANT_ID },
    recipient: { id: 'bot-1', name: 'Bot' },
    channelId: 'msteams',
    serviceUrl: 'https://example.invalid/',
  } as unknown as Activity
}

function makeConfig() {
  return {
    stateDir: '/tmp/unused',
    allowlistFile: '/tmp/unused',
    pendingFile: '/tmp/unused',
    appId: 'app-id',
    appPassword: 'app-pw',
    appType: 'SingleTenant' as const,
    tenantId: TENANT_ID,
    bindHost: '127.0.0.1',
    port: 0,
  }
}

describe('PERMISSION_REPLY_RE', () => {
  test('matches the canonical shapes', () => {
    expect(PERMISSION_REPLY_RE.test('yes abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('YES abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('y abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('no abcde')).toBe(true)
    expect(PERMISSION_REPLY_RE.test('  no  abcde  ')).toBe(true)
  })

  test('rejects chatty / wrong-shape inputs', () => {
    expect(PERMISSION_REPLY_RE.test('yes')).toBe(false)
    expect(PERMISSION_REPLY_RE.test('yes please')).toBe(false)
    expect(PERMISSION_REPLY_RE.test('yes 12345')).toBe(false) // digits not allowed
    expect(PERMISSION_REPLY_RE.test('yes ablde')).toBe(false) // 'l' not allowed
    expect(PERMISSION_REPLY_RE.test('yes abcdef')).toBe(false) // 6 chars
    expect(PERMISSION_REPLY_RE.test('the answer is yes abcde')).toBe(false)
  })
})

describe('createPermissionRelay', () => {
  test('formats the prompt text with id, tool name, and args summary', () => {
    const text = formatPromptText({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a shell command',
      input_preview: '{"command":"ls -la"}',
    })
    expect(text).toContain('[abcde]')
    expect(text).toContain('Bash')
    expect(text).toContain("'yes abcde'")
    expect(text).toContain("'no abcde'")
  })

  test('resolve emits a verdict only for known ids', async () => {
    const verdicts: Array<{ id: string; behavior: string }> = []
    const dms: Array<{ conv: string; text: string }> = []
    const relay = createPermissionRelay({
      sendDm: async (conv, text) => {
        dms.push({ conv, text })
      },
      emitVerdict: (id, behavior) => {
        verdicts.push({ id, behavior })
      },
      resolveTargetConversation: () => 'conv-primary',
      timeoutMs: 60_000,
    })

    await relay.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'desc',
      input_preview: '{}',
    })
    expect(dms.length).toBe(1)
    expect(dms[0]!.conv).toBe('conv-primary')

    // Unknown id → not resolved.
    expect(relay.resolve('zzzzz', 'allow')).toBe(false)
    expect(verdicts).toEqual([])
    // Known id → resolved.
    expect(relay.resolve('abcde', 'allow')).toBe(true)
    expect(verdicts).toEqual([{ id: 'abcde', behavior: 'allow' }])
    // Same id can't be resolved twice.
    expect(relay.resolve('abcde', 'deny')).toBe(false)

    relay.clear()
  })

  test('drops the request when no allowlisted conversation is known', async () => {
    const dms: any[] = []
    const verdicts: any[] = []
    const relay = createPermissionRelay({
      sendDm: async (conv, text) => {
        dms.push({ conv, text })
      },
      emitVerdict: (id, behavior) => verdicts.push({ id, behavior }),
      resolveTargetConversation: () => undefined,
      timeoutMs: 60_000,
    })
    await relay.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'desc',
      input_preview: '{}',
    })
    expect(dms.length).toBe(0)
    expect(relay.pendingCount()).toBe(0)
    relay.clear()
  })

  test('timeout removes the pending slot', async () => {
    const relay = createPermissionRelay({
      sendDm: async () => {},
      emitVerdict: () => {},
      resolveTargetConversation: () => 'conv-primary',
      timeoutMs: 30,
    })
    await relay.onRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'desc',
      input_preview: '{}',
    })
    expect(relay.pendingCount()).toBe(1)
    await new Promise(r => setTimeout(r, 60))
    expect(relay.pendingCount()).toBe(0)
    relay.clear()
  })

  test('multiple in-flight requests are isolated', async () => {
    const verdicts: Array<{ id: string; behavior: string }> = []
    const relay = createPermissionRelay({
      sendDm: async () => {},
      emitVerdict: (id, behavior) => verdicts.push({ id, behavior }),
      resolveTargetConversation: () => 'conv-primary',
      timeoutMs: 60_000,
    })
    await relay.onRequest({ request_id: 'aaaaa', tool_name: 'Bash', description: '', input_preview: '' })
    await relay.onRequest({ request_id: 'bbbbb', tool_name: 'Write', description: '', input_preview: '' })
    expect(relay.pendingCount()).toBe(2)
    expect(relay.resolve('bbbbb', 'deny')).toBe(true)
    expect(relay.pendingCount()).toBe(1)
    expect(relay.resolve('aaaaa', 'allow')).toBe(true)
    expect(verdicts).toEqual([
      { id: 'bbbbb', behavior: 'deny' },
      { id: 'aaaaa', behavior: 'allow' },
    ])
    relay.clear()
  })
})

describe('adapter permission-reply interception', () => {
  let dir: string
  let allowlistFile: string
  let pendingFile: string

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'cct-perm-int-'))
    allowlistFile = join(dir, 'allowlist.json')
    pendingFile = join(dir, 'pending.json')
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(SENDER_ID, 'seeded')
    const pending = createPendingStore(pendingFile)
    const refs = createConversationRefStore()
    return { allowlist, pending, refs }
  }

  test('yes <id> for a known request is intercepted (no channel event)', async () => {
    const { allowlist, pending, refs } = setup()
    const events: any[] = []
    const verdicts: any[] = []
    const relay = createPermissionRelay({
      sendDm: async () => {},
      emitVerdict: (id, behavior) => verdicts.push({ id, behavior }),
      resolveTargetConversation: () => 'conv-abc',
      timeoutMs: 60_000,
    })
    await relay.onRequest({ request_id: 'abcde', tool_name: 'Bash', description: '', input_preview: '' })

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      pending,
      permission: relay,
    })
    await handler(new TurnContext(new NoopAdapter() as any, makeActivity('yes abcde')))

    expect(events).toEqual([]) // intercepted, not forwarded
    expect(verdicts).toEqual([{ id: 'abcde', behavior: 'allow' }])
    relay.clear()
    rmSync(dir, { recursive: true })
  })

  test('yes <id> for an unknown id falls through to channel event', async () => {
    const { allowlist, pending, refs } = setup()
    const events: any[] = []
    const relay = createPermissionRelay({
      sendDm: async () => {},
      emitVerdict: () => {},
      resolveTargetConversation: () => 'conv-abc',
      timeoutMs: 60_000,
    })

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      pending,
      permission: relay,
    })
    await handler(new TurnContext(new NoopAdapter() as any, makeActivity('yes zzzzz')))

    // Unknown id → adapter forwards as regular chat.
    expect(events.length).toBe(1)
    expect(events[0].text).toBe('yes zzzzz')
    relay.clear()
    rmSync(dir, { recursive: true })
  })

  test('malformed permission-shape replies are forwarded as chat', async () => {
    const { allowlist, pending, refs } = setup()
    const events: any[] = []
    const relay = createPermissionRelay({
      sendDm: async () => {},
      emitVerdict: () => {},
      resolveTargetConversation: () => 'conv-abc',
      timeoutMs: 60_000,
    })

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      pending,
      permission: relay,
    })
    await handler(new TurnContext(new NoopAdapter() as any, makeActivity('yes please')))
    expect(events.length).toBe(1)
    expect(events[0].text).toBe('yes please')
    relay.clear()
    rmSync(dir, { recursive: true })
  })
})
