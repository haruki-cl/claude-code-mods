// 使用率を天気やバーに置き換える。Claude Code の API には触れない純粋な関数だけを置く

export type Weather = { icon: string; label: string; color: string; note?: string }

const STORM: Weather = { icon: '⛈', label: 'Stormy', color: 'red', note: 'Auto-compact soon' }

// 上から順に、使用率がしきい値未満なら当てはまる。どれにも当たらなければ STORM
const LEVELS: readonly (Weather & { below: number })[] = [
  { below: 25, icon: '☀️', label: 'Sunny', color: 'green' },
  { below: 50, icon: '🌤', label: 'Mostly sunny', color: 'green' },
  { below: 70, icon: '⛅', label: 'Cloudy', color: 'yellow' },
  { below: 85, icon: '🌧', label: 'Rainy', color: 'yellow' },
]

export function weatherFor(percent: number): Weather {
  const level = LEVELS.find(l => percent < l.below)
  if (!level) {
    return STORM
  }

  const { below: _, ...weather } = level
  return weather
}

/** ミリ秒を「42s」「1m 12s」「1h 2m」にする */
export function formatSeconds(ms: number): string {
  const seconds = Math.max(Math.round(ms / 1000), 0)
  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 使用量の枠（5 時間・週）の色。天気より早めに注意を促す */
export function limitColor(percentUsed: number): string {
  if (percentUsed < 50) {
    return 'green'
  }

  return percentUsed < 80 ? 'yellow' : 'red'
}

export function formatTokens(n: number): string {
  if (n < 1000) {
    return `${n}`
  }

  if (n < 1_000_000) {
    return `${Math.round(n / 1000)}k`
  }

  return `${(n / 1_000_000).toFixed(1)}M`
}

/** 窓に対する割合を整数の百分率にする。窓が 0 なら 0 */
export function percentOf(tokens: number, window: number): number {
  return window > 0 ? Math.round((tokens / window) * 100) : 0
}

/** 残りミリ秒を「2h 13m」「3d 5h」「12m」にする。過ぎていれば 0m */
export function formatLeft(ms: number): string {
  const minutes = Math.max(Math.floor(ms / 60_000), 0)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) {
    return `${days}d ${hours}h`
  }

  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** width 文字ぶんの横棒。percent が 0〜100 の外でも端で止める */
export function bar(percent: number, width: number): string {
  const filled = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(width - filled, 0))
}

const SPARKS = '▁▂▃▄▅▆▇█'

/** 0〜100 の値の並びを 1 行の推移グラフにする */
export function sparkline(values: readonly number[]): string {
  return values
    .map(v => SPARKS[Math.min(SPARKS.length - 1, Math.floor((Math.min(Math.max(v, 0), 100) / 100) * SPARKS.length))] ?? '')
    .join('')
}

// 段の上を跳ねる丸。棒のブロック文字と同じく 1 列で描かれる字にする
export const HOPPER = '●'
// 1 段を跳ぶのにかかるコマ数: 乗る、跳び上がる、次の段の上へ
const HOP_FRAMES = 3

/**
 * 0〜100 の値の並びを、rows 行に積んだ棒の高さ（1/8 行単位）にする。最低でも 1。
 * 最上段の 1/8 は空けておき、いちばん高い棒でも丸が上端の字に乗れるようにする
 */
export function stepHeights(values: readonly number[], rows: number): number[] {
  const top = rows * 8 - 1
  return values.map(v => 1 + Math.min(Math.floor((Math.min(Math.max(v, 0), 100) / 100) * top), top - 1))
}

/** 高さの並びを、上の行から順に rows 行の棒グラフにする。棒のない所は空白 */
export function steps(heights: readonly number[], rows: number): string[] {
  return Array.from({ length: rows }, (_, i) => {
    const below = (rows - 1 - i) * 8
    return heights.map(h => SPARKS[Math.min(h - below, 8) - 1] ?? ' ').join('')
  })
}

/**
 * frame コマ目に丸のいる列と、下から数えた行。棒の上端の字に重なり、満ちた字の上に立つ。
 * 左から 1 段ずつ跳び、右端の外へ抜けたらまた左から。抜けているコマは undefined
 */
export function hopAt(heights: readonly number[], frame: number): { column: number; level: number } | undefined {
  const stand = (i: number) => Math.floor((heights[i] ?? 0) / 8)
  if (heights.length === 0) {
    return undefined
  }

  const column = Math.floor(frame / HOP_FRAMES) % heights.length
  const apex = Math.max(stand(column), stand(column + 1)) + 1
  switch (frame % HOP_FRAMES) {
    case 0:
      return { column, level: stand(column) }
    case 1:
      return { column, level: apex }
    default:
      return column + 1 < heights.length ? { column: column + 1, level: apex } : undefined
  }
}

const LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  spend_limit: 'Spend',
}

export function limitLabel(kind: string): string {
  return LIMIT_LABELS[kind] ?? kind
}

/** 枠を 5 時間・週・その他の順に並べる */
export function limitOrder(kind: string): number {
  const order = Object.keys(LIMIT_LABELS).indexOf(kind)
  return order === -1 ? Object.keys(LIMIT_LABELS).length : order
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** ISO 8601 の時刻を「Thu 10/8 03:10」の形にする */
export function formatReset(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return iso
  }

  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${WEEKDAYS[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

// 全角（東アジアの広い文字）は 2 列ぶんとして数える
function cells(text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += isWide ? 2 : 1
  }

  return width
}

/** 表示幅が width 列になるまで右に空白を足す */
export function padCells(text: string, width: number): string {
  return text + ' '.repeat(Math.max(width - cells(text), 0))
}
