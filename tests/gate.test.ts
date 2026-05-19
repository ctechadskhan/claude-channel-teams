/**
 * Inbound gate tests — exercise the turn handler in isolation.
 *
 * We construct a TurnContext directly from a synthetic Activity rather than
 * round-tripping through CloudAdapter.process; CloudAdapter requires a
 * Microsoft-signed JWT (out of scope for unit tests). The gate's allowlist
 * + tenant pinning logic lives in the turn handler, so this still exercises
 * the security-critical path.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BotAdapter, TurnContext, type Activity } from 'botbuilder'

import { makeTurnHandler } from '../src/teams/adapter'
import { createAllowlist } from '../src/pairing/allowlist'
import { createConversationRefStore } from '../src/teams/conversationRefs'

const FIXTURE_ID = '00000000-0000-4000-8000-000000000001'
const UNKNOWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TENANT_ID = '00000000-0000-4000-8000-000000000002'

/** Minimal BotAdapter — TurnContext insists on having one but our turn
 *  handler never sends through it during gate tests. */
class NoopAdapter extends BotAdapter {
  async sendActivities(): Promise<any> { return [] }
  async updateActivity(): Promise<void> {}
  async deleteActivity(): Promise<void> {}
  async continueConversation(): Promise<void> {}
}

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'message',
    text: 'hello from teams',
    id: 'msg-1',
    timestamp: new Date('2026-05-17T19:30:00Z'),
    from: { id: 'user-1', name: 'Test User', aadObjectId: FIXTURE_ID },
    conversation: { id: 'conv-abc', tenantId: TENANT_ID },
    recipient: { id: 'bot-1', name: 'Bot' },
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/uk/',
    ...overrides,
  } as unknown as Activity
}

function makeConfig(overrides = {}) {
  return {
    stateDir: '/tmp/unused',
    allowlistFile: '/tmp/unused',
    appId: 'app-id',
    appPassword: 'app-pw',
    appType: 'SingleTenant' as const,
    tenantId: TENANT_ID,
    bindHost: '127.0.0.1',
    port: 0,
    ...overrides,
  }
}

describe('inbound gate', () => {
  let dir: string
  let allowlistFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-gate-'))
    allowlistFile = join(dir, 'allowlist.json')
  })

  test('delivers a message from an allowlisted sender', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID, 'test seed')
    const refs = createConversationRefStore()
    const events: any[] = []
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity())
    await handler(ctx)
    expect(events.length).toBe(1)
    expect(events[0].text).toBe('hello from teams')
    expect(events[0].aadObjectId).toBe(FIXTURE_ID)
    expect(events[0].conversationId).toBe('conv-abc')
    // Conversation reference must be captured for the outbound side.
    expect(refs.get('conv-abc')).toBeDefined()
    rmSync(dir, { recursive: true })
  })

  test('drops a message from an unknown sender silently', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
    })
    const activity = makeActivity({
      from: { id: 'user-2', name: 'Random', aadObjectId: UNKNOWN_ID },
    })
    const ctx = new TurnContext(new NoopAdapter() as any, activity)
    await handler(ctx)
    expect(events).toEqual([])
    expect(refs.size()).toBe(0)
    rmSync(dir, { recursive: true })
  })

  test('drops cross-tenant activity even from allowlisted sender', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
    })
    const activity = makeActivity({
      conversation: { id: 'conv-xyz', tenantId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } as any,
    })
    const ctx = new TurnContext(new NoopAdapter() as any, activity)
    await handler(ctx)
    expect(events).toEqual([])
    rmSync(dir, { recursive: true })
  })

  test('starts the typing pump when a message clears the gate', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const started: string[] = []
    const stopped: string[] = []
    const typingPump = {
      start(id: string) {
        started.push(id)
      },
      stop(id: string) {
        stopped.push(id)
      },
      stopAll() {},
    }
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      typingPump,
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity())
    await handler(ctx)
    expect(started).toEqual(['conv-abc'])
    expect(stopped).toEqual([])
    rmSync(dir, { recursive: true })
  })

  test('does not start the typing pump when a message is dropped', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const started: string[] = []
    const typingPump = {
      start(id: string) {
        started.push(id)
      },
      stop() {},
      stopAll() {},
    }
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      typingPump,
    })
    const activity = makeActivity({
      from: { id: 'user-2', name: 'Random', aadObjectId: UNKNOWN_ID },
    })
    const ctx = new TurnContext(new NoopAdapter() as any, activity)
    await handler(ctx)
    expect(started).toEqual([])
    rmSync(dir, { recursive: true })
  })

  test('ignores non-message activity types', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
    })
    const activity = makeActivity({ type: 'conversationUpdate' } as any)
    const ctx = new TurnContext(new NoopAdapter() as any, activity)
    await handler(ctx)
    expect(events).toEqual([])
    rmSync(dir, { recursive: true })
  })
})
