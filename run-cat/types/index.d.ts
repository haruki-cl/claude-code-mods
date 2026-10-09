// 猫が走り始めてから何コマ進んだか
export type Frame = number

declare module 'claude-code' {
  interface PluginState {
    'run-cat': { frame: Frame }
  }
}
