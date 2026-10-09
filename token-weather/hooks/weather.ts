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
