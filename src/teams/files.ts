/**
 * Adaptive Card builder for outbound file downloads.
 *
 * Produces a Bot Framework `message` activity with a single Adaptive Card
 * attachment (schema v1.4 — Teams' supported maximum). The card shows the
 * filename, size, and MIME, and offers a single "Download" action that
 * targets the supplied URL.
 */

export interface DownloadCardInput {
  filename: string
  sizeBytes: number
  mime: string
  downloadUrl: string
  /** Optional text rendered alongside the card in chat. */
  caption?: string
}

function humaniseSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

export function buildDownloadCardActivity(input: DownloadCardInput): {
  type: 'message'
  text?: string
  attachments: Array<{
    contentType: string
    content: {
      type: 'AdaptiveCard'
      version: '1.4'
      $schema: string
      body: Array<{ type: string; text: string; weight?: string; isSubtle?: boolean; spacing?: string; wrap?: boolean }>
      actions: Array<{ type: 'Action.OpenUrl'; title: string; url: string }>
    }
  }>
} {
  const card = {
    type: 'AdaptiveCard' as const,
    version: '1.4' as const,
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    body: [
      {
        type: 'TextBlock',
        text: input.filename,
        weight: 'Bolder',
        wrap: true,
      },
      {
        type: 'TextBlock',
        text: `${humaniseSize(input.sizeBytes)} · ${input.mime}`,
        isSubtle: true,
        spacing: 'None',
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl' as const,
        title: 'Download',
        url: input.downloadUrl,
      },
    ],
  }
  const out: any = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: card,
      },
    ],
  }
  if (input.caption) out.text = input.caption
  return out
}
