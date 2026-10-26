// Haiku が応答から選んだ語句。important は重要な語句、confirm は確認が必要な語句
export type Picks = { important: string[]; confirm: string[] }

// 応答の本文と、そこから選んだ語句
export type Picked = { text: string; picks: Picks }

declare module 'claude-code' {
  interface PluginState {
    'highlight-words': {
      // 語句を選び終えた応答。新しいものが末尾
      picked: Picked[]
    }
  }
}
