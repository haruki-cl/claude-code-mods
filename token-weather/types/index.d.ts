// 最後に測ったコンテキストの使用状況
export type Usage = { percent: number; tokens: number; window: number }

// 使用量の枠（five_hour、seven_day など）。resetsAt は ISO 8601
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// 作業ログの 1 行。at はターンが終わった時刻、project はセッションのルートのフォルダ名、text は Haiku がまとめた 1 行
export type LogEntry = { at: number; project: string; text: string }

// /context が出す内訳の 1 行。deferred（窓の外にある遅延ロードのツール定義）は載せない
export type Category = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

// 内訳と、それを測った窓（圧縮の窓。モデルの窓より小さいことがある）
export type Breakdown = { categories: Category[]; window: number }

// ペインのカード。押すと詳細が開く
export type Card = 'weather' | 'limits' | 'log'

// どのカードが開いているか
export type Open = Record<Card, boolean>

declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      usage: Usage | null
      history: number[]
      limits: Limit[]
      // 自動圧縮が始まるトークン数（オフなら null）
      autoCompactAt: number | null
      // このセッションの作業ログ。古いものが先頭
      log: LogEntry[]
      breakdown: Breakdown | null
      open: Open
      // セッションが始まった時刻（再開なら最初の起動、/clear でやり直し）。まだ測っていなければ null
      startedAt: number | null
      // 1 分ごとに進む数。経過時間を描き直すためだけに使う
      minute: number
      // 各ターンにかかった時間（ミリ秒）。新しいものが末尾
      turns: number[]
      // Turns の段を跳ねる丸の何コマ目か。作業中だけ数え、作業していなければ null（丸は出さない）
      hop: number | null
    }
  }
}
