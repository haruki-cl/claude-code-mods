import { expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On, RenderSurface } from 'claude-code'

const HINT = '⏵⏵ auto mode on (shift+tab to cycle)'

const hint = (isWorking: boolean) => ({ isDraft: false, isWorking, hint: HINT })
const viewport = { columns: 120, rows: 30 }

// エンジン自身の描画の代わり。ヒントの後ろに tail を " · " でつなぐ
const engineDraws = (on: On) =>
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail === undefined ? e.props.hint : `${e.props.hint} · ${e.props.tail}`}</Text>
  })

async function shown<P extends RenderSurface>(ui: Mounted<P, 'PromptHint'>): Promise<string> {
  return (await ui.find({ type: 'Text' }))?.text ?? ''
}

// 猫の顔 "(=^" が何列目にあるか
const headAt = (line: string) => line.indexOf('(=^')

test('ターン中は猫がヒント行の末尾を右へ走り、終わると止まって寝る', async ($, on) => {
  const clock = mock.clock(on)
  engineDraws(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(2000)

  const ui = await $.ui.mount({ plugin: 'run-cat', surface: 'terminal', component: 'PromptHint', props: hint(true), viewport })
  const before = await shown(ui)
  expect(before.startsWith(`${HINT} · `)).toBe(true)
  // 普通の空白ではなく点字の空白で右へずらしている
  expect(before).toContain('⠀')
  expect(headAt(before)).toBeGreaterThan(HINT.length)

  await clock.advance(500)
  const after = await shown(ui)
  expect(headAt(after)).toBe(headAt(before) + 5)

  await clock.advance(100)
  expect(await shown(ui)).not.toBe(after)

  // サブエージェントのターンが終わっても、メインのターン中は走り続ける
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', agentId: 'a1', reason: 'answer' })
  const running = headAt(await shown(ui))
  await clock.advance(300)
  expect(headAt(await shown(ui))).toBe(running + 3)

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const stopped = headAt(await shown(ui))
  await clock.advance(1000)
  expect(headAt(await shown(ui))).toBe(stopped)

  const idle = await $.ui.mount({ plugin: 'run-cat', surface: 'terminal', component: 'PromptHint', props: hint(false), viewport })
  expect(await shown(idle)).toContain('(=^-ω-^=)zzZ')
})

test('最初のターンの前でも、寝ている猫は走路の中にいる', async ($, on) => {
  mock.clock(on)
  engineDraws(on)

  const ui = await $.ui.mount({ plugin: 'run-cat', surface: 'terminal', component: 'PromptHint', props: hint(false), viewport })
  expect(await shown(ui)).toBe(`${HINT} · (=^-ω-^=)zzZ`)
})

test('端末が狭くて走路が取れないときは何も足さない', async ($, on) => {
  mock.clock(on)
  engineDraws(on)

  const ui = await $.ui.mount({
    plugin: 'run-cat',
    surface: 'terminal',
    component: 'PromptHint',
    props: hint(true),
    viewport: { columns: 60, rows: 30 },
  })
  expect(await shown(ui)).toBe(HINT)
})

test('デスクトップでは何も足さない', async ($, on) => {
  mock.clock(on)
  engineDraws(on)

  const ui = await $.ui.mount({ plugin: 'run-cat', surface: 'desktop', component: 'PromptHint', props: hint(true), viewport })
  expect(await shown(ui)).toBe(HINT)
})
