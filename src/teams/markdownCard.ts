/**
 * Markdown → Adaptive Card renderer for outbound replies.
 *
 * Why a card at all: Teams renders only a thin markdown subset in text-only
 * bot messages (bold, italic, links, blockquote). Headers, lists, and blank
 * lines are stripped, so anything structured arrives as a wall of text.
 * Adaptive Card TextBlocks render their own markdown subset (bold, italic,
 * lists, links) AND give us per-block control for headings, code, and
 * spacing — the "native RTF" look.
 *
 * Contract: `markdownToAdaptiveCard` returns null for simple prose (one
 * paragraph, no block structure). The caller then sends a plain markdown
 * text activity, which keeps short answers light and copy-paste friendly.
 * Anything structured returns a card plus a plain-text summary for the
 * toast/preview line, which is otherwise blank for card-only messages.
 */

interface TextBlock {
  type: 'TextBlock'
  text: string
  wrap: true
  size?: 'Large' | 'Medium' | 'Default' | 'Small'
  weight?: 'Bolder'
  fontType?: 'Monospace'
  isSubtle?: boolean
  separator?: boolean
  spacing?: 'Small' | 'Medium' | 'Large' | 'None'
}

interface Container {
  type: 'Container'
  style?: 'emphasis'
  items: TextBlock[]
  spacing?: 'Small' | 'Medium' | 'Large'
  separator?: boolean
}

type CardElement = TextBlock | Container

export interface AdaptiveCardAttachment {
  contentType: 'application/vnd.microsoft.card.adaptive'
  content: {
    $schema: string
    type: 'AdaptiveCard'
    version: string
    msteams: { width: 'Full' }
    body: CardElement[]
  }
}

export interface RenderedCard {
  attachment: AdaptiveCardAttachment
  /** Plain-text first line for the notification toast / chat-list preview. */
  summary: string
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*)$/
const LIST_ITEM = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)/
const QUOTE = /^\s*>\s?/
const RULE = /^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/

/** Strip markdown syntax for the summary line. */
function plainify(line: string): string {
  return line
    .replace(HEADING, '$2')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim()
}

/**
 * Decide whether the text has block structure worth a card. One paragraph of
 * prose — even with bold/links, which text messages render fine — does not.
 */
export function needsCard(markdown: string): boolean {
  const lines = markdown.split('\n')
  let paragraphBreaks = 0
  let lastWasText = false
  for (const line of lines) {
    if (FENCE.test(line) || HEADING.test(line) || LIST_ITEM.test(line) || QUOTE.test(line) || RULE.test(line) || TABLE_ROW.test(line)) {
      return true
    }
    if (line.trim() === '') {
      if (lastWasText) paragraphBreaks++
      lastWasText = false
    } else {
      lastWasText = true
    }
  }
  return paragraphBreaks >= 1 && lines.filter(l => l.trim() !== '').length > 1
}

export function markdownToAdaptiveCard(markdown: string): RenderedCard | null {
  const text = markdown.replace(/\r\n/g, '\n').trim()
  if (text === '' || !needsCard(text)) return null

  const body: CardElement[] = []
  const lines = text.split('\n')
  let i = 0
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    body.push({ type: 'TextBlock', text: paragraph.join(' '), wrap: true })
    paragraph = []
  }

  while (i < lines.length) {
    const line = lines[i]!

    // Code fence — verbatim block, monospace, on a tinted container.
    const fence = line.match(FENCE)
    if (fence) {
      flushParagraph()
      const marker = fence[1]!
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) {
        code.push(lines[i]!)
        i++
      }
      i++ // consume the closing fence (or run off the end — same result)
      body.push({
        type: 'Container',
        style: 'emphasis',
        spacing: 'Small',
        items: [{ type: 'TextBlock', text: code.join('\n') || ' ', wrap: true, fontType: 'Monospace' }],
      })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      flushParagraph()
      const level = heading[1]!.length
      body.push({
        type: 'TextBlock',
        text: heading[2]!,
        wrap: true,
        weight: 'Bolder',
        size: level === 1 ? 'Large' : level === 2 ? 'Medium' : 'Default',
        spacing: 'Medium',
      })
      i++
      continue
    }

    if (RULE.test(line)) {
      flushParagraph()
      // No hr element in Adaptive Cards — a separator on the next block reads
      // the same. Mark it with an empty spacer that carries the line.
      body.push({ type: 'TextBlock', text: ' ', wrap: true, separator: true, spacing: 'Small', size: 'Small' })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      flushParagraph()
      const quote: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        quote.push(lines[i]!.replace(QUOTE, ''))
        i++
      }
      body.push({
        type: 'Container',
        style: 'emphasis',
        spacing: 'Small',
        items: [{ type: 'TextBlock', text: quote.join('\n\n'), wrap: true, isSubtle: true }],
      })
      continue
    }

    if (LIST_ITEM.test(line)) {
      flushParagraph()
      const items: string[] = []
      while (i < lines.length && (LIST_ITEM.test(lines[i]!) || (lines[i]!.startsWith('  ') && lines[i]!.trim() !== ''))) {
        items.push(lines[i]!)
        i++
      }
      // One TextBlock carrying the markdown list — TextBlocks render "- " and
      // "1. " lists natively, which is exactly the bullet look we want.
      body.push({ type: 'TextBlock', text: items.join('\n'), wrap: true, spacing: 'Small' })
      continue
    }

    if (TABLE_ROW.test(line)) {
      flushParagraph()
      const rows: string[] = []
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        rows.push(lines[i]!.trim())
        i++
      }
      // Tables don't render in TextBlocks — monospace keeps the columns.
      body.push({
        type: 'Container',
        style: 'emphasis',
        spacing: 'Small',
        items: [{ type: 'TextBlock', text: rows.join('\n'), wrap: true, fontType: 'Monospace', size: 'Small' }],
      })
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      i++
      continue
    }

    paragraph.push(line.trim())
    i++
  }
  flushParagraph()

  if (body.length === 0) return null

  const firstText = lines.find(l => l.trim() !== '') ?? ''
  const summary = plainify(firstText).slice(0, 120) || 'Message from Hermes'

  return {
    attachment: {
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        msteams: { width: 'Full' },
        body,
      },
    },
    summary,
  }
}
