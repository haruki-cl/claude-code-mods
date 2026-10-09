import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

// 何コマ目か。位置と手の形はここから決まる
const frame = atom({ plugin: 'run-cat', key: 'frame' } as const, 0)

const TICK_MS = 100

// 右へダッシュする猫。土煙と手の形が違う 2 コマを交互に出す
const DASH_A = 'ε=ε=(=^･ω･^)ﾉ'
const DASH_B = '=ε=ε(=^･ω･^)ﾍ'

// ターンが終わったらその場で寝る
const SLEEP = '(=^-ω-^=)zzZ'

const RUN_WIDTH = DASH_A.length

// フッター行の頭の字下げと、ヒントと猫のあいだに入る " · "
const HINT_INDENT = 2
const SEPARATOR = 3
// 行の右端に Claude Code が何か出したときのための余白
const RIGHT_MARGIN = 20

// 普通の空白は Claude Code に詰められるので、見えない点字の空白で猫を右へずらす
const BLANK = '⠀'

// x 列目から描いて、room 列で切る。x が負なら左端からはみ出た分を落とす
function place(art: string, x: number, room: number): string {
  const shifted = x < 0 ? art.slice(-x) : BLANK.repeat(x) + art
  return shifted.slice(0, room)
}

export const register: Register = on => {
  let timer: Timer | undefined

  const stop = () => {
    timer?.cancel()
    timer = undefined
  }

  on('turn.start', ($, e, next) => {
    if (!timer) {
      timer = $.clock.every(TICK_MS, () => {
        void update($, frame, n => n + 1)
      })
    }

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!e.agentId) {
      stop()
    }

    return next(e)
  })

  // プロンプトの下のヒント行（⏵⏵ auto mode on … の行）の末尾に猫を足す
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    // 走らせるのは端末の CLI だけ。デスクトップから同じセッションを見ても描かない
    if (e.surface !== 'terminal') {
      return next(e)
    }

    const columns = e.viewport?.columns ?? 80
    const room = columns - HINT_INDENT - e.props.hint.length - SEPARATOR - RIGHT_MARGIN
    if (room < RUN_WIDTH) {
      return next(e)
    }

    const n = await read($, frame)
    // 走路の左端の外から出てきて、右端の外へ抜けたらまた左から
    const x = (n % (room + RUN_WIDTH)) - RUN_WIDTH
    // 寝るときは走路の中に収める
    const tail = e.props.isWorking
      ? place(n % 2 === 0 ? DASH_A : DASH_B, x, room)
      : place(SLEEP, Math.max(0, Math.min(x, room - SLEEP.length)), room)

    return next({ ...e, props: { ...e.props, tail } })
  })
}
