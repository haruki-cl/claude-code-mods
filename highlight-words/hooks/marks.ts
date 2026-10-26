// 色を付ける語句を、本文の中で印として扱う。⟦!語句⟧ は重要、⟦?語句⟧ は確認が必要な語句

export type Mark = 'important' | 'confirm'

// 1 行の中身。text は素の文字、code はインラインコード、mark は印で囲まれた語句
export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; spans: Span[] }
  | { kind: 'italic'; spans: Span[] }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'mark'; mark: Mark; spans: Span[] }

// 自前で描く 1 行。lead は箇条書きの記号と字下げ
export type Line = { lead: string; isHeading: boolean; spans: Span[] }

// 本文の区切り。plain は標準の Markdown 描画に任せる。marked は印のある段落で、1 行ずつ自前で色を付けて描く
export type Segment = { kind: 'plain'; text: string } | { kind: 'marked'; lines: Line[] }

type Block = { isFence: boolean; lines: string[] }

const MARK = /⟦([!?])([^⟦⟧\n]+?)⟧/
const MARKS = new RegExp(MARK.source, 'g')
// 前から順に: インラインコード、印、太字、斜体、リンク
const INLINE = /`([^`\n]+)`|⟦([!?])([^⟦⟧\n]+?)⟧|\*\*([^*\n]+?)\*\*|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g
const FENCE = /^\s*(`{3,}|~{3,})/
const HEADING = /^#{1,6}\s+(.*)$/
const LIST = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/
// 表・引用・HTML・区切り線は自前では描かない
const UNDRAWABLE = /^\s*(\||>|<)|^\s*([-*_])(\s*\2){2,}\s*$/

export function hasMark(text: string): boolean {
  return MARK.test(text)
}

const markOf = (sign: string): Mark => (sign === '!' ? 'important' : 'confirm')

// 色を付けられない場所では、印を外して太字にする
const boldMarks = (text: string) => text.replace(MARKS, (_, _sign: string, inner: string) => `**${inner}**`)

export function parseInline(text: string): Span[] {
  const spans: Span[] = []
  let at = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) {
      spans.push({ kind: 'text', text: text.slice(at, m.index) })
    }

    const [, code, sign, marked, bold, italic, label, href] = m
    if (code !== undefined) {
      spans.push({ kind: 'code', text: code })
    } else if (sign !== undefined && marked !== undefined) {
      spans.push({ kind: 'mark', mark: markOf(sign), spans: parseInline(marked) })
    } else if (bold !== undefined) {
      spans.push({ kind: 'bold', spans: parseInline(bold) })
    } else if (italic !== undefined) {
      spans.push({ kind: 'italic', spans: parseInline(italic) })
    } else if (label !== undefined && href !== undefined) {
      spans.push({ kind: 'link', label, href })
    }

    at = m.index + m[0].length
  }

  if (at < text.length) {
    spans.push({ kind: 'text', text: text.slice(at) })
  }

  return spans
}

function parseLine(line: string): Line {
  const heading = HEADING.exec(line)
  if (heading) {
    return { lead: '', isHeading: true, spans: parseInline(heading[1] ?? '') }
  }

  const item = LIST.exec(line)
  if (item) {
    return { lead: item[1] ?? '', isHeading: false, spans: parseInline(item[2] ?? '') }
  }

  const indent = line.length - line.trimStart().length
  return { lead: line.slice(0, indent), isHeading: false, spans: parseInline(line.slice(indent)) }
}

// 空行とコードブロックの境で本文を分ける。閉じていないコードブロック（ストリーミング中）は末尾までコードとみなす
function blocksOf(text: string): Block[] {
  const blocks: Block[] = []
  let lines: string[] = []
  let fence: Block | null = null
  let closer = ''

  const close = () => {
    if (lines.length > 0) {
      blocks.push({ isFence: false, lines })
    }

    lines = []
  }

  for (const line of text.split('\n')) {
    if (fence) {
      fence.lines.push(line)
      if (line.trim().startsWith(closer)) {
        fence = null
      }

      continue
    }

    const open = FENCE.exec(line)
    if (open) {
      close()
      closer = open[1] ?? '```'
      fence = { isFence: true, lines: [line] }
      blocks.push(fence)
    } else if (line.trim() === '') {
      close()
    } else {
      lines.push(line)
    }
  }

  close()
  return blocks
}

// 印のある段落だけを marked にし、それ以外はつなげて plain にまとめる。コードブロックの中の印はそのまま残す
export function segment(text: string): Segment[] {
  const segments: Segment[] = []
  let plain: string[] = []

  const flush = () => {
    if (plain.length > 0) {
      segments.push({ kind: 'plain', text: plain.join('\n\n') })
    }

    plain = []
  }

  for (const block of blocksOf(text)) {
    const body = block.lines.join('\n')
    if (block.isFence || !hasMark(body)) {
      plain.push(body)
    } else if (block.lines.some(line => UNDRAWABLE.test(line))) {
      plain.push(boldMarks(body))
    } else {
      flush()
      segments.push({ kind: 'marked', lines: block.lines.map(parseLine) })
    }
  }

  flush()
  return segments
}

type Range = [number, number]

// コードブロック、インラインコード、リンクの範囲。そこにある語句には印を付けない
function codeRanges(text: string): Range[] {
  const ranges: Range[] = []
  let offset = 0
  let fenceAt: number | null = null
  let closer = ''

  for (const line of text.split('\n')) {
    const end = offset + line.length
    if (fenceAt !== null) {
      if (line.trim().startsWith(closer)) {
        ranges.push([fenceAt, end])
        fenceAt = null
      }
    } else {
      const open = FENCE.exec(line)
      if (open) {
        fenceAt = offset
        closer = open[1] ?? '```'
      } else {
        for (const m of line.matchAll(/`[^`\n]+`|\[[^\]\n]*\]\([^)\s]*\)/g)) {
          ranges.push([offset + m.index, offset + m.index + m[0].length])
        }
      }
    }

    offset = end + 1
  }

  if (fenceAt !== null) {
    ranges.push([fenceAt, text.length])
  }

  return ranges
}

const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1]

// 選んだ語句が本文で最初に出てくるところを印で囲む。長い語句から先に当て、重なるものとコードの中のものは飛ばす
export function markPhrases(text: string, picks: { important: string[]; confirm: string[] }): string {
  const taken = codeRanges(text)
  const found: Array<{ range: Range; sign: string }> = []
  const phrases = [
    ...picks.important.map(phrase => ({ phrase, sign: '!' })),
    ...picks.confirm.map(phrase => ({ phrase, sign: '?' })),
  ].sort((a, b) => b.phrase.length - a.phrase.length)

  for (const { phrase, sign } of phrases) {
    for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
      const range: Range = [at, at + phrase.length]
      if (!taken.some(r => overlaps(r, range))) {
        taken.push(range)
        found.push({ range, sign })
        break
      }
    }
  }

  return found
    .sort((a, b) => b.range[0] - a.range[0])
    .reduce((s, { range: [from, to], sign }) => `${s.slice(0, from)}⟦${sign}${s.slice(from, to)}⟧${s.slice(to)}`, text)
}
