/**
 * `send_file` outbound implementation.
 *
 * Reads (or accepts) the file bytes, runs the same `assertAllowedConversation`
 * gate the `reply` tool uses, mints a single-use outbox token, builds the
 * Adaptive Card, and sends it through the captured conversation reference.
 *
 * The path-source mode validates against `outbox.isPathAllowed` so a
 * prompt-injected Claude cannot be coaxed into exfiltrating files outside
 * the configured root.
 */

import { readFileSync, statSync } from 'fs'
import { basename, resolve } from 'path'
import { type CloudAdapter, type ConversationReference } from 'botbuilder'

import type { Allowlist } from '../pairing/allowlist.js'
import type { ConversationRefStore } from './conversationRefs.js'
import type { Outbox } from './outbox.js'
import { buildDownloadCardActivity } from './files.js'

/** Max file size — matches the inbound cap. */
const MAX_BYTES = 50 * 1024 * 1024

export class PathNotAllowedError extends Error {
  constructor(path: string) {
    super(`send_file: path ${path} is outside the sendable-files root`)
    this.name = 'PathNotAllowedError'
  }
}

export class FileTooLargeError extends Error {
  constructor(bytes: number) {
    super(`send_file: file is ${bytes} bytes — exceeds 50 MB cap`)
    this.name = 'FileTooLargeError'
  }
}

export class UnknownConversationError extends Error {
  constructor(conversationId: string) {
    super(
      `send_file: unknown conversation_id ${conversationId}. ` +
        `Ask the user to send a fresh Teams message to re-seed.`,
    )
    this.name = 'UnknownConversationError'
  }
}

export class ConversationNotAllowedError extends Error {
  constructor(conversationId: string) {
    super(
      `send_file: conversation_id ${conversationId} is not allowlisted — refusing to send.`,
    )
    this.name = 'ConversationNotAllowedError'
  }
}

export interface FileSenderDeps {
  config: { appId: string }
  adapter: CloudAdapter
  allowlist: Allowlist
  refs: ConversationRefStore
  outbox: Outbox
  /** e.g. `"https://hermes.vcshosted.uk/files"`. The token gets appended. */
  downloadBaseUrl: string
}

export interface SendFileInput {
  conversationId: string
  caption?: string
  /** Either `path` OR (`content` + `filename`) is required. */
  path?: string
  content?: Buffer
  filename?: string
  mime?: string
}

export interface SendFileResult {
  token: string
  filename: string
  sizeBytes: number
}

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  switch (ext) {
    case 'pdf': return 'application/pdf'
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'txt': return 'text/plain'
    case 'md': return 'text/markdown'
    case 'json': return 'application/json'
    case 'csv': return 'text/csv'
    case 'zip': return 'application/zip'
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    default: return 'application/octet-stream'
  }
}

export function createFileSender(deps: FileSenderDeps) {
  function assertAllowedConversation(conversationId: string): {
    ref: Partial<ConversationReference>
  } {
    const stored = deps.refs.get(conversationId)
    if (!stored) throw new UnknownConversationError(conversationId)
    if (!deps.allowlist.isAllowed(stored.aadObjectId)) {
      throw new ConversationNotAllowedError(conversationId)
    }
    return { ref: stored.ref }
  }

  async function sendFile(input: SendFileInput): Promise<SendFileResult> {
    if (!input.path && !input.content) {
      throw new Error('send_file: either `path` or `content` is required')
    }
    if (input.content && !input.filename) {
      throw new Error('send_file: `filename` is required when `content` is used')
    }

    let content: Buffer
    let filename: string
    let mime: string

    if (input.path) {
      const abs = resolve(input.path)
      if (!deps.outbox.isPathAllowed(abs)) {
        throw new PathNotAllowedError(abs)
      }
      const stat = statSync(abs)
      if (stat.size > MAX_BYTES) {
        throw new FileTooLargeError(stat.size)
      }
      content = readFileSync(abs)
      filename = input.filename ?? basename(abs)
      mime = input.mime ?? guessMime(filename)
    } else {
      content = input.content!
      filename = input.filename!
      mime = input.mime ?? guessMime(filename)
      if (content.length > MAX_BYTES) {
        throw new FileTooLargeError(content.length)
      }
    }

    // Gate the outbound BEFORE we touch the outbox — a refused conversation
    // shouldn't leave a token sitting on disk.
    const { ref } = assertAllowedConversation(input.conversationId)

    const minted = await deps.outbox.mint({ content, filename, mime })

    const downloadUrl = `${deps.downloadBaseUrl.replace(/\/+$/, '')}/${minted.token}`
    const activity = buildDownloadCardActivity({
      filename: minted.filename,
      sizeBytes: minted.sizeBytes,
      mime: minted.mime,
      downloadUrl,
      caption: input.caption,
    })

    await deps.adapter.continueConversationAsync(
      deps.config.appId,
      ref,
      async turnContext => {
        await turnContext.sendActivity(activity as any)
      },
    )

    process.stderr.write(
      `teams channel: send_file sent conv=${input.conversationId} token=${minted.token.slice(0, 8)}… ` +
        `filename=${filename} size=${minted.sizeBytes}\n`,
    )

    return {
      token: minted.token,
      filename: minted.filename,
      sizeBytes: minted.sizeBytes,
    }
  }

  return sendFile
}
