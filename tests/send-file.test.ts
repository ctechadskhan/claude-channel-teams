/**
 * send_file tests — adaptive-card builder + the outbound sender that
 * combines the outbox with the conversation gate.
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createAllowlist } from '../src/pairing/allowlist'
import { createConversationRefStore } from '../src/teams/conversationRefs'
import { createOutbox } from '../src/teams/outbox'
import { buildDownloadCardActivity } from '../src/teams/files'
import { createFileSender, FileTooLargeError, PathNotAllowedError } from '../src/teams/sendFile'

const FIXTURE_ID = '00000000-0000-4000-8000-000000000001'

function makeConfig() {
  return {
    appId: 'app-id-from-config',
    bindHost: '127.0.0.1',
    port: 0,
    tenantId: '00000000-0000-4000-8000-000000000002',
  } as any
}

describe('buildDownloadCardActivity', () => {
  test('produces a Bot-Framework activity with an Adaptive Card attachment', () => {
    const act = buildDownloadCardActivity({
      filename: 'brief.pdf',
      sizeBytes: 1024 * 250, // 250 KB
      mime: 'application/pdf',
      downloadUrl: 'https://hermes.vcshosted.uk/files/abc',
    })
    expect(act.type).toBe('message')
    expect(Array.isArray(act.attachments)).toBe(true)
    expect(act.attachments?.length).toBe(1)
    const att = act.attachments![0]
    expect(att.contentType).toBe('application/vnd.microsoft.card.adaptive')
    expect(att.content?.type).toBe('AdaptiveCard')
    expect(att.content?.version).toBe('1.4')
    // The Download action points at the supplied URL.
    expect(att.content?.actions?.[0]?.type).toBe('Action.OpenUrl')
    expect(att.content?.actions?.[0]?.url).toBe('https://hermes.vcshosted.uk/files/abc')
    // Body shows the filename and a humanised size + MIME line.
    const body = att.content?.body ?? []
    const text = body.map((b: any) => b.text).join(' | ')
    expect(text).toContain('brief.pdf')
    expect(text).toContain('250.0 KB')
    expect(text).toContain('application/pdf')
  })

  test('includes the caption as the message text when provided', () => {
    const act = buildDownloadCardActivity({
      filename: 'a.txt',
      sizeBytes: 1,
      mime: 'text/plain',
      downloadUrl: 'https://example/files/x',
      caption: 'Here you go.',
    })
    expect(act.text).toBe('Here you go.')
  })

  test('omits the message text when no caption is provided', () => {
    const act = buildDownloadCardActivity({
      filename: 'a.txt',
      sizeBytes: 1,
      mime: 'text/plain',
      downloadUrl: 'https://example/files/x',
    })
    expect(act.text).toBeUndefined()
  })

  test('formats sub-KB sizes in bytes', () => {
    const act = buildDownloadCardActivity({
      filename: 'tiny.txt',
      sizeBytes: 42,
      mime: 'text/plain',
      downloadUrl: 'https://example/files/x',
    })
    const text = (act.attachments![0].content?.body ?? []).map((b: any) => b.text).join(' | ')
    expect(text).toContain('42 B')
  })

  test('formats multi-MB sizes', () => {
    const act = buildDownloadCardActivity({
      filename: 'doc.pdf',
      sizeBytes: 5 * 1024 * 1024,
      mime: 'application/pdf',
      downloadUrl: 'https://example/files/x',
    })
    const text = (act.attachments![0].content?.body ?? []).map((b: any) => b.text).join(' | ')
    expect(text).toContain('5.0 MB')
  })
})

describe('send_file outbound sender', () => {
  let workdir: string
  let outboxDir: string
  let allowlistFile: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'cct-sendfile-'))
    outboxDir = join(workdir, 'outbox')
    allowlistFile = join(workdir, 'allowlist.json')
  })

  test('mints a token, builds a card, and sends through the conversation reference', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)
    const outbox = createOutbox({
      dir: outboxDir,
      ttlSeconds: 60,
      safetyRoot: workdir,
    })
    await outbox.initialise()

    let sentActivity: any
    const adapter = {
      async continueConversationAsync(_appId: string, _ref: any, logic: any) {
        await logic({
          async sendActivity(act: any) {
            sentActivity = act
          },
        })
      },
    } as any

    const filePath = join(workdir, 'doc.txt')
    writeFileSync(filePath, 'document body')

    const sendFile = createFileSender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      outbox,
      downloadBaseUrl: 'https://hermes.vcshosted.uk/files',
    })

    const result = await sendFile({
      conversationId: 'conv-abc',
      path: filePath,
      caption: 'See attached.',
    })

    expect(result.token).toBeString()
    expect(result.filename).toBe('doc.txt')
    expect(sentActivity).toBeDefined()
    expect(sentActivity.type).toBe('message')
    expect(sentActivity.text).toBe('See attached.')
    expect(sentActivity.attachments?.length).toBe(1)
    expect(sentActivity.attachments[0].content?.actions?.[0]?.url).toBe(
      `https://hermes.vcshosted.uk/files/${result.token}`,
    )
    // The outbox now has this token live.
    expect(outbox.lookup(result.token)?.filename).toBe('doc.txt')
    rmSync(workdir, { recursive: true, force: true })
  })

  test('refuses a path outside the sendable-files root', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)
    const outbox = createOutbox({ dir: outboxDir, ttlSeconds: 60, safetyRoot: workdir })
    await outbox.initialise()

    const adapter = {
      async continueConversationAsync() {
        throw new Error('outbound should have been refused before adapter')
      },
    } as any

    // Write a file OUTSIDE workdir so the allow-root check refuses it.
    const outsideDir = mkdtempSync(join(tmpdir(), 'cct-outside-'))
    const outsidePath = join(outsideDir, 'leak.txt')
    writeFileSync(outsidePath, 'sensitive')

    const sendFile = createFileSender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      outbox,
      downloadBaseUrl: 'https://hermes.vcshosted.uk/files',
    })

    await expect(
      sendFile({ conversationId: 'conv-abc', path: outsidePath }),
    ).rejects.toThrow(PathNotAllowedError)
    rmSync(workdir, { recursive: true, force: true })
    rmSync(outsideDir, { recursive: true, force: true })
  })

  test('refuses files larger than 50 MB', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)
    const outbox = createOutbox({ dir: outboxDir, ttlSeconds: 60, safetyRoot: workdir })
    await outbox.initialise()

    const adapter = {
      async continueConversationAsync() {
        throw new Error('outbound should have been refused before adapter')
      },
    } as any

    // Make a sparse 51 MB file via truncate.
    const bigPath = join(workdir, 'big.bin')
    const fd = require('fs').openSync(bigPath, 'w')
    require('fs').ftruncateSync(fd, 51 * 1024 * 1024)
    require('fs').closeSync(fd)

    const sendFile = createFileSender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      outbox,
      downloadBaseUrl: 'https://hermes.vcshosted.uk/files',
    })

    await expect(
      sendFile({ conversationId: 'conv-abc', path: bigPath }),
    ).rejects.toThrow(FileTooLargeError)
    rmSync(workdir, { recursive: true, force: true })
  })

  test('refuses a reply for a conversation that was never allowlisted', async () => {
    const allowlist = createAllowlist(allowlistFile)
    // Sender NOT added.
    const refs = createConversationRefStore()
    // No conversation reference stored.
    const outbox = createOutbox({ dir: outboxDir, ttlSeconds: 60, safetyRoot: workdir })
    await outbox.initialise()

    const adapter = {
      async continueConversationAsync() {
        throw new Error('outbound should have been refused before adapter')
      },
    } as any

    const filePath = join(workdir, 'doc.txt')
    writeFileSync(filePath, 'document body')

    const sendFile = createFileSender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      outbox,
      downloadBaseUrl: 'https://hermes.vcshosted.uk/files',
    })

    await expect(
      sendFile({ conversationId: 'never-seen', path: filePath }),
    ).rejects.toThrow()
    rmSync(workdir, { recursive: true, force: true })
  })

  test('accepts a content+filename payload when no path is given', async () => {
    const allowlist = createAllowlist(allowlistFile)
    allowlist.addEntry(FIXTURE_ID)
    const refs = createConversationRefStore()
    refs.put('conv-abc', { conversation: { id: 'conv-abc' } } as any, FIXTURE_ID)
    const outbox = createOutbox({ dir: outboxDir, ttlSeconds: 60, safetyRoot: workdir })
    await outbox.initialise()

    let sentActivity: any
    const adapter = {
      async continueConversationAsync(_appId: string, _ref: any, logic: any) {
        await logic({
          async sendActivity(act: any) {
            sentActivity = act
          },
        })
      },
    } as any

    const sendFile = createFileSender({
      config: makeConfig(),
      adapter,
      allowlist,
      refs,
      outbox,
      downloadBaseUrl: 'https://hermes.vcshosted.uk/files',
    })

    const result = await sendFile({
      conversationId: 'conv-abc',
      content: Buffer.from('inline payload'),
      filename: 'inline.txt',
      mime: 'text/plain',
    })

    expect(result.filename).toBe('inline.txt')
    expect(sentActivity.attachments[0].content?.body).toBeDefined()
    rmSync(workdir, { recursive: true, force: true })
  })
})
