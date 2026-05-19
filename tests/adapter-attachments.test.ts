/**
 * Adapter + attachment wiring tests.
 *
 * Verifies the inbound turn handler:
 *   - calls the attachment handler ONLY for allowlisted senders (gate-after),
 *   - composes the resulting text with annotations,
 *   - leaves messages with no attachments unchanged,
 *   - degrades to a single failure annotation if the handler throws,
 *   - handles the file-only message case (empty text + annotations only).
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

class NoopAdapter extends BotAdapter {
  async sendActivities(): Promise<any> { return [] }
  async updateActivity(): Promise<void> {}
  async deleteActivity(): Promise<void> {}
  async continueConversation(): Promise<void> {}
}

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: 'message',
    text: 'with files',
    id: 'msg-1',
    timestamp: new Date('2026-05-18T19:43:00Z'),
    from: { id: 'user-1', name: 'Adnan Khan', aadObjectId: FIXTURE_ID },
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
    receivedFilesDir: '/tmp/unused',
    ...overrides,
  }
}

describe('adapter: attachment wiring', () => {
  let dir: string
  let allowlistFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-adapter-att-'))
    allowlistFile = join(dir, 'allowlist.json')
  })

  test('appends annotation lines after the original text for allowlisted sender', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    let handlerCalls = 0
    const handler = async (_atts: any, _name: string) => {
      handlerCalls += 1
      return { annotations: ['[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]'] }
    }
    const turn = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      attachments: handler,
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity({
      attachments: [{ contentType: 'image/png', contentUrl: 'x' }] as any,
    }))
    await turn(ctx)
    expect(handlerCalls).toBe(1)
    expect(events.length).toBe(1)
    expect(events[0].text).toBe('with files\n\n[Attached: /tmp/x.pdf (application/pdf, 1.0 KB)]')
    rmSync(dir, { recursive: true })
  })

  test('file-only message: empty text + annotations only', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const turn = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      attachments: async () => ({ annotations: ['[Attached: /tmp/y.pdf (application/pdf, 2.0 KB)]'] }),
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity({
      text: '',
      attachments: [{ contentType: 'image/png', contentUrl: 'x' }] as any,
    }))
    await turn(ctx)
    expect(events[0].text).toBe('[Attached: /tmp/y.pdf (application/pdf, 2.0 KB)]')
    rmSync(dir, { recursive: true })
  })

  test('does NOT call the attachment handler for non-allowlisted senders', async () => {
    const allowlist = createAllowlist(allowlistFile)
    // FIXTURE_ID is intentionally NOT seeded
    const refs = createConversationRefStore()
    const events: any[] = []
    let handlerCalls = 0
    const turn = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      attachments: async () => {
        handlerCalls += 1
        return { annotations: [] }
      },
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity({
      from: { id: 'user-2', name: 'Stranger', aadObjectId: UNKNOWN_ID } as any,
      attachments: [{ contentType: 'image/png', contentUrl: 'x' }] as any,
    }))
    await turn(ctx)
    expect(handlerCalls).toBe(0)
    expect(events.length).toBe(0)
    rmSync(dir, { recursive: true })
  })

  test('thrown handler degrades to a single failure annotation, message still delivered', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    const turn = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      attachments: async () => { throw new Error('disk full') },
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity({
      attachments: [{ contentType: 'image/png', contentUrl: 'x' }] as any,
    }))
    await turn(ctx)
    expect(events.length).toBe(1)
    expect(events[0].text).toContain('with files')
    expect(events[0].text).toContain('[Attachment handling failed: disk full]')
    rmSync(dir, { recursive: true })
  })

  test('message with no attachments passes through unchanged (handler not called)', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const events: any[] = []
    let calls = 0
    const turn = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      attachments: async () => { calls += 1; return { annotations: [] } },
    })
    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity())
    await turn(ctx)
    expect(calls).toBe(0)
    expect(events[0].text).toBe('with files')
    rmSync(dir, { recursive: true })
  })
})
