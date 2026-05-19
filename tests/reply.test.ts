/**
 * Reply tool tests — outbound gate + capture of adapter calls.
 *
 * We mock `adapter.continueConversationAsync` so the test never tries to talk
 * to the Bot Connector. Captures the (appId, ref, logic) tuple the SDK would
 * have been handed, and lets the logic run against a fake TurnContext so
 * sendActivity is observable.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createAllowlist } from '../src/pairing/allowlist'
import { createConversationRefStore } from '../src/teams/conversationRefs'
import {
  ConversationNotAllowedError,
  UnknownConversationError,
  createReplySender,
} from '../src/teams/reply'

const FIXTURE_ID = '00000000-0000-4000-8000-000000000001'
const TENANT_ID = '00000000-0000-4000-8000-000000000002'

function makeConfig() {
  return {
    stateDir: '/tmp/unused',
    allowlistFile: '/tmp/unused',
    appId: 'app-id-from-config',
    appPassword: 'app-pw',
    appType: 'SingleTenant' as const,
    tenantId: TENANT_ID,
    bindHost: '127.0.0.1',
    port: 0,
  }
}

describe('reply tool', () => {
  let dir: string
  let allowlistFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cct-reply-'))
    allowlistFile = join(dir, 'allowlist.json')
  })

  test('sends through continueConversationAsync with the captured reference', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)

    let captured: { appId?: string; refConvId?: string; sentText?: string; sentTextFormat?: string } = {}
    const adapter = {
      async continueConversationAsync(appId: string, ref: any, logic: any) {
        captured.appId = appId
        captured.refConvId = ref.conversation?.id
        // Fake TurnContext — just enough to observe sendActivity.
        const fakeCtx = {
          async sendActivity(act: any) {
            captured.sentText = act.text
            captured.sentTextFormat = act.textFormat
          },
        }
        await logic(fakeCtx)
      },
    } as any

    const { sendReply } = createReplySender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
    })

    await sendReply('conv-abc', 'hello from claude')
    expect(captured.appId).toBe('app-id-from-config')
    expect(captured.refConvId).toBe('conv-abc')
    expect(captured.sentText).toBe('hello from claude')
    expect(captured.sentTextFormat).toBe('markdown')
    rmSync(dir, { recursive: true })
  })

  test('stops the typing pump for the conversation when reply is sent', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)

    const stopped: string[] = []
    const typingPump = {
      start() {},
      stop(id: string) {
        stopped.push(id)
      },
      stopAll() {},
    }

    const adapter = {
      async continueConversationAsync(_appId: string, _ref: any, logic: any) {
        await logic({ async sendActivity() {} })
      },
    } as any

    const { sendReply } = createReplySender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      typingPump,
    })

    await sendReply('conv-abc', 'done thinking')
    expect(stopped).toEqual(['conv-abc'])
    rmSync(dir, { recursive: true })
  })

  test('stops the typing pump even if the adapter send throws', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)

    const stopped: string[] = []
    const typingPump = {
      start() {},
      stop(id: string) {
        stopped.push(id)
      },
      stopAll() {},
    }

    const adapter = {
      async continueConversationAsync() {
        throw new Error('connector boom')
      },
    } as any

    const { sendReply } = createReplySender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      typingPump,
    })

    await expect(sendReply('conv-abc', 'done thinking')).rejects.toThrow('connector boom')
    expect(stopped).toEqual(['conv-abc'])
    rmSync(dir, { recursive: true })
  })

  test('throws UnknownConversationError when no reference is stored', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    const adapter = {
      async continueConversationAsync() {
        throw new Error('should not have been called')
      },
    } as any

    const { sendReply } = createReplySender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
    })

    await expect(sendReply('never-seen', 'hi')).rejects.toThrow(UnknownConversationError)
    rmSync(dir, { recursive: true })
  })

  test('refuses reply after sender is removed from the allowlist', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)

    // Operator yanks the user from the allowlist between receive and reply.
    allowlist.removeEntry(FIXTURE_ID)

    const adapter = {
      async continueConversationAsync() {
        throw new Error('outbound should have been refused at the gate')
      },
    } as any

    const { sendReply } = createReplySender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
    })

    await expect(sendReply('conv-abc', 'hi')).rejects.toThrow(ConversationNotAllowedError)
    rmSync(dir, { recursive: true })
  })
})
