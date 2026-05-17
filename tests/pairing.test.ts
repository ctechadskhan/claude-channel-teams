/**
 * Pairing tests — pending store + adapter integration.
 *
 * Covers:
 *   - Fresh DM creates a pending entry and asks the gate to send the initial DM.
 *   - A repeat DM from the same sender within the reminder window is suppressed.
 *   - A repeat DM after the reminder window asks for a reminder (capped at 2).
 *   - The third DM (after the cap) is suppressed.
 *   - approve_pair-style code mismatch is rejected.
 *   - Atomic write resilience: writes survive even when called rapidly.
 *   - The pending file is mode 0600.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BotAdapter, TurnContext, type Activity } from 'botbuilder'

import {
  REMINDER_INTERVAL_MS,
  codesEqual,
  createPendingStore,
} from '../src/pairing/pair'
import { createAllowlist } from '../src/pairing/allowlist'
import { createConversationRefStore } from '../src/teams/conversationRefs'
import { makeTurnHandler } from '../src/teams/adapter'

const SENDER_ID = '00000000-0000-4000-8000-000000000001'
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
    text: 'hi',
    id: 'msg-1',
    timestamp: new Date('2026-05-17T19:30:00Z'),
    from: { id: 'user-1', name: 'Stranger', aadObjectId: SENDER_ID },
    conversation: { id: 'conv-abc', tenantId: TENANT_ID },
    recipient: { id: 'bot-1', name: 'Bot' },
    channelId: 'msteams',
    serviceUrl: 'https://example.invalid/',
    ...overrides,
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

describe('pending store', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-pending-'))
    file = join(dir, 'pending.json')
  })

  test('initialises the pending file at mode 0600', () => {
    createPendingStore(file)
    const mode = statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('"version": 1')
    rmSync(dir, { recursive: true })
  })

  test('first DM produces send_initial with a fresh pair_id + code', () => {
    const store = createPendingStore(file)
    const result = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
    })
    expect(result.action).toBe('send_initial')
    if (result.action !== 'send_initial') throw new Error('unreachable')
    expect(result.entry.pair_id).toMatch(/^[0-9a-f]{8}$/)
    expect(result.entry.code).toMatch(/^[A-Z0-9]{6}$/)
    expect(store.list().length).toBe(1)
    rmSync(dir, { recursive: true })
  })

  test('repeat DM within the reminder window is suppressed', () => {
    const store = createPendingStore(file)
    const t0 = Date.parse('2026-05-17T19:30:00Z')
    const first = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
      now: t0,
    })
    expect(first.action).toBe('send_initial')
    const second = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
      now: t0 + 60 * 1000, // 1 minute later
    })
    expect(second.action).toBe('suppress')
    rmSync(dir, { recursive: true })
  })

  test('repeat DM after the reminder window sends one reminder, then suppresses', () => {
    const store = createPendingStore(file)
    const t0 = Date.parse('2026-05-17T19:30:00Z')
    store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
      now: t0,
    })
    const reminder = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
      now: t0 + REMINDER_INTERVAL_MS + 1000,
    })
    expect(reminder.action).toBe('send_reminder')
    // Third attempt — cap reached.
    const third = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
      now: t0 + 2 * REMINDER_INTERVAL_MS + 1000,
    })
    expect(third.action).toBe('suppress')
    rmSync(dir, { recursive: true })
  })

  test('remove() returns true when present and false when missing', () => {
    const store = createPendingStore(file)
    const r = store.recordIncoming({
      aadObjectId: SENDER_ID,
      tenantId: TENANT_ID,
      fromName: 'Stranger',
      conversationId: 'conv-abc',
    })
    if (r.action !== 'send_initial') throw new Error('expected fresh pending')
    expect(store.remove(r.entry.pair_id)).toBe(true)
    expect(store.remove(r.entry.pair_id)).toBe(false)
    expect(store.list().length).toBe(0)
    rmSync(dir, { recursive: true })
  })

  test('codesEqual is case- and whitespace-tolerant and rejects mismatches', () => {
    expect(codesEqual('A2B4C6', 'a2b4c6')).toBe(true)
    expect(codesEqual('  A2B4C6  ', 'A2B4C6')).toBe(true)
    expect(codesEqual('A2B4C6', 'A2B4C7')).toBe(false)
    expect(codesEqual('A2B4C6', 'A2B4C')).toBe(false)
  })

  test('rapid successive writes survive and produce a coherent file', () => {
    const store = createPendingStore(file)
    // 10 different senders, all "incoming at once" — atomic write should
    // leave the file readable on every iteration.
    for (let i = 0; i < 10; i++) {
      const aad = `00000000-0000-4000-8000-00000000${i.toString().padStart(4, '0')}`
      store.recordIncoming({
        aadObjectId: aad,
        tenantId: TENANT_ID,
        fromName: `User ${i}`,
        conversationId: `conv-${i}`,
      })
      // File must be parseable mid-way through.
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      expect(parsed.version).toBe(1)
    }
    expect(store.list().length).toBe(10)
    rmSync(dir, { recursive: true })
  })
})

describe('adapter pairing integration', () => {
  let dir: string
  let allowlistFile: string
  let pendingFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-pairing-int-'))
    allowlistFile = join(dir, 'allowlist.json')
    pendingFile = join(dir, 'pending.json')
  })

  test('unknown sender triggers a pairing DM and adds a pending entry', async () => {
    const allowlist = createAllowlist(allowlistFile)
    const pending = createPendingStore(pendingFile)
    const refs = createConversationRefStore()
    const events: any[] = []
    const sent: { text: string }[] = []

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      pending,
      sendPairingDm: async (_ref, text) => {
        sent.push({ text })
      },
    })

    const ctx = new TurnContext(new NoopAdapter() as any, makeActivity())
    await handler(ctx)

    expect(events).toEqual([])
    expect(sent.length).toBe(1)
    expect(sent[0]!.text).toContain('/teams:access pair ')
    expect(pending.list().length).toBe(1)
    rmSync(dir, { recursive: true })
  })

  test('unknown sender re-DM within reminder window is silent (no second DM, no second pending)', async () => {
    const allowlist = createAllowlist(allowlistFile)
    const pending = createPendingStore(pendingFile)
    const refs = createConversationRefStore()
    const sent: any[] = []

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: () => {},
      pending,
      sendPairingDm: async (_ref, text) => {
        sent.push({ text })
      },
    })

    await handler(new TurnContext(new NoopAdapter() as any, makeActivity()))
    await handler(new TurnContext(new NoopAdapter() as any, makeActivity({ id: 'msg-2' })))

    expect(sent.length).toBe(1) // second DM suppressed
    expect(pending.list().length).toBe(1) // still only one pending entry
    rmSync(dir, { recursive: true })
  })

  test('allowlisted sender bypasses pairing and emits a channel event', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(SENDER_ID, 'seeded')
    const pending = createPendingStore(pendingFile)
    const refs = createConversationRefStore()
    const events: any[] = []
    const sent: any[] = []

    const handler = makeTurnHandler({
      config: makeConfig() as any,
      adapter: {} as any,
      allowlist,
      refs,
      onEvent: e => events.push(e),
      pending,
      sendPairingDm: async (_ref, text) => {
        sent.push({ text })
      },
    })

    await handler(new TurnContext(new NoopAdapter() as any, makeActivity()))

    expect(events.length).toBe(1)
    expect(sent.length).toBe(0)
    expect(pending.list().length).toBe(0)
    rmSync(dir, { recursive: true })
  })
})
