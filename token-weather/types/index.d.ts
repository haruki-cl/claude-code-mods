// 最後に測ったコンテキストの使用状況
export type Usage = { percent: number; tokens: number; window: number }

// 使用量の枠（five_hour、seven_day など）。resetsAt は ISO 8601
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// 索引（MEMORY.md）の 1 項目: `- [Title](file.md) — hook` の Title と file
export type IndexEntry = { title: string; file: string }

// コンテキストに載っている auto-memory の索引（MEMORY.md）。entries は索引に並ぶ項目（読めなければ undefined）
export type MemoryIndex = { path: string; tokens?: number; entries?: IndexEntry[] }

// このセッションが読んだファイル。how は読まれ方: tool = Claude が Read や Bash で読んだ、
// auto = エンジンが勝手に載せた（起動時の読み込み、ディレクトリに触れたときの CLAUDE.md、想起、エンジン自身のメモリ処理）。
// ageDays はエンジンが Read の結果に付ける「N days old」
export type MemoryRead = { name: string; path: string; at: number; how: 'tool' | 'auto'; ageDays?: number }

// 過去セッションの記憶（auto-memory）と指示ファイルのうち、このセッションが読んだもの
export type Memory = { index: MemoryIndex | null; reads: MemoryRead[] }

// /context が出す内訳の 1 行。deferred（窓の外にある遅延ロードのツール定義）は載せない
export type Category = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' }

// 内訳と、それを測った窓（圧縮の窓。モデルの窓より小さいことがある）
export type Breakdown = { categories: Category[]; window: number }

// ペインのカード。押すと詳細が開く
export type Card = 'weather' | 'limits' | 'memory'

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
      memory: Memory
      breakdown: Breakdown | null
      open: Open
    }
  }
}
