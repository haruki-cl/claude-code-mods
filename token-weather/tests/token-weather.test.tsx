import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { LogEntry } from '../types'
import { cleanEntry, countTools, dayKey, formatClock, logPrompt, plainRecap, projectName, recapPrompt } from '../hooks/log.ts'
import { HOPPER, bar, formatLeft, formatReset, formatSeconds, formatTokens, hopAt, limitColor, padCells, percentOf, sparkline, stepHeights, steps, weatherFor } from '../hooks/weather.ts'

const pane = (bodyColumns = 32) => ({
  title: 'Token Weather',
  isFocused: false,
  bodyColumns,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
})

const LIMITS: SessionRateLimit[] = [
  { kind: 'seven_day', percentUsed: 36, resetsAt: '2026-10-08T11:00:00Z' },
  { kind: 'five_hour', percentUsed: 2, resetsAt: '2026-10-07T18:10:00Z' },
]

const ROOT = '/Users/me/app'
// この PC の時刻で 2026-10-27 の昼
const NOON = new Date(2026, 9, 27, 12, 0).getTime()
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
// ツールを呼ばないターンでも作業ログに書かれる長さの応答
const LONG_ANSWER = '説明します。'.repeat(20)

const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 72_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 90_000, color: 'x', isDeferred: false, kind: 'free' },
  ],
  memoryFiles: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
  rawMaxTokens: 200_000,
} as unknown as SessionContextBreakdown

// Claude Code が応答のあとに使用量を知らせてくるのと同じ呼び方
async function measure($: { session: { measure: (e: never) => Promise<unknown> } }, context: SessionContextUsage, rateLimits = LIMITS) {
  await $.session.measure({ context, rateLimits, changed: ['context', 'rateLimits'] } as never)
}

// 内訳つきの使用量とセッションのルートを答えるエンジンの代わり
const engine = (on: On, context: SessionContextUsage = { window: 200_000 }) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...context, breakdown: BREAKDOWN }, rateLimits: LIMITS } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: 's1' }))
}

const tools = (on: On) => {
  on('tool.call', { tool: 'Read' }, ($, e) => ({
    ref: 1,
    text: '1\t---',
    result: { type: 'text' as const, file: { filePath: e.file_path, content: '---', numLines: 1, startLine: 1, totalLines: 1 } },
  }))
  on('tool.call', { tool: 'Bash' }, () => ({ ref: 1, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } }))
}

// ターンの始まりと終わりを受け止めるエンジンの代わり
const loop = (on: On) => {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

// Haiku の代わり。reply を答え、受け取った依頼を控える
function haiku(on: On, reply: (prompt: string) => string): { prompts: string[] } {
  const seen = { prompts: [] as string[] }
  on('model.complete', ($, e) => {
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: reply(e.prompt), usage: USAGE } }
  })
  return seen
}

// メインのターンを 1 回まわす。依頼を送り、ツールを呼び、答えて終わる
async function work($: Engine, turnId: string, text: string, answer: string, run: (() => Promise<unknown>)[] = []) {
  await $.turn.start({ text, turnId })
  for (const call of run) {
    await call()
  }
  await $.turn.complete({ turnId, durationMs: 1_000, answer, isAborted: false, reason: 'answer' } as never)
}

const entry = (at: number, text: string, project = 'app'): LogEntry => ({ at, project, text })

// テストの $ には store がないので、書かれたものを自前で受け止める。中身はこの Record で読む
function store(on: On, initial: Record<string, unknown> = {}): Record<string, unknown> {
  const saved: Record<string, unknown> = { ...initial }
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => {
    saved[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete saved[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(saved) }))
  return saved
}

async function texts(ui: Mounted<'terminal', 'Pane'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

// Turns のグラフの行を上から。見出しか字下げの 6 列に、棒の本数ぶんの列が続く行だけを拾う（丸の前後で区切った断片は短いので落ちる）
function turnRows(shown: string[], bars: number): string[] {
  return shown.filter(t => t.length === 6 + bars && /^(Turns | {6})/.test(t))
}

const mountPane = ($: Engine) => $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })

describe('表示の部品', () => {
  test('使用率のしきい値で天気が変わる', () => {
    expect(weatherFor(24).label).toBe('Sunny')
    expect(weatherFor(25).label).toBe('Mostly sunny')
    expect(weatherFor(50).label).toBe('Cloudy')
    expect(weatherFor(70).label).toBe('Rainy')
    expect(weatherFor(85).note).toBe('Auto-compact soon')
  })

  test('トークン数・バー・推移・枠の色', () => {
    expect(formatTokens(116_400)).toBe('116k')
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(bar(50, 10)).toBe('█████░░░░░')
    expect(bar(150, 4)).toBe('████')
    expect(sparkline([0, 50, 100])).toBe('▁▅█')
    expect([limitColor(10), limitColor(60), limitColor(90)]).toEqual(['green', 'yellow', 'red'])
    expect(padCells('Weekly', 7)).toBe('Weekly ')
    expect(padCells('週の枠', 7)).toBe('週の枠 ')
  })

  test('ターンの段と、その上を跳ねる丸', () => {
    // 2 段に積む。最上段の 1/8 は、いちばん高い棒でも丸が乗れるように空ける
    expect(stepHeights([0, 50, 100], 2)).toEqual([1, 8, 15])
    expect(steps([4, 15, 8], 3)).toEqual(['   ', ' ▇ ', '▄██'])
    // 棒の上端の字に重なって立ち、乗る、跳び上がる、次の段の上へ。右端の外へ抜けたら、また左の段から
    expect(Array.from({ length: 10 }, (_, f) => hopAt([4, 15, 8], f))).toEqual([
      { column: 0, level: 0 },
      { column: 0, level: 2 },
      { column: 1, level: 2 },
      { column: 1, level: 1 },
      { column: 1, level: 2 },
      { column: 2, level: 2 },
      { column: 2, level: 1 },
      { column: 2, level: 2 },
      undefined,
      { column: 0, level: 0 },
    ])
    expect(hopAt([], 0)).toBeUndefined()
  })

  test('残り時間と割合', () => {
    expect(formatLeft(2 * 3_600_000 + 13 * 60_000)).toBe('2h 13m')
    expect(formatLeft(3 * 86_400_000 + 5 * 3_600_000)).toBe('3d 5h')
    expect(formatLeft(12 * 60_000)).toBe('12m')
    expect(formatLeft(-1)).toBe('0m')
    expect([percentOf(72_000, 200_000), percentOf(1, 0)]).toEqual([36, 0])
    expect([formatSeconds(42_000), formatSeconds(72_000), formatSeconds(3_720_000), formatSeconds(-5)]).toEqual(['42s', '1m 12s', '1h 2m', '0s'])
  })

  test('リセット時刻を日付・曜日・時刻にする', () => {
    expect(formatReset('2026-10-08T03:10:00')).toBe('Thu 10/8 03:10')
    expect(formatReset('not a date')).toBe('not a date')
  })
})

describe('作業ログの部品', () => {
  test('依頼・使ったツール（名前ごとの回数）・応答を Haiku への依頼にまとめる', () => {
    expect(countTools(['Read', 'Bash', 'Read'])).toBe('Read ×2, Bash')
    expect(logPrompt({ at: 0, prompt: 'バグを直して', tools: ['Read', 'Bash', 'Read'], answer: '直しました' })).toBe(
      ['<turn>', '依頼: バグを直して', '使ったツール: Read ×2, Bash', '応答: 直しました', '</turn>'].join('\n'),
    )
    expect(logPrompt({ at: 0, prompt: '', tools: [], answer: 'x' })).toContain('使ったツール: なし')
  })

  test('Haiku の返事を 1 行に整え、長すぎれば切る', () => {
    expect(cleanEntry('\n- 「作業ログを足した。」\n補足')).toBe('作業ログを足した')
    expect(cleanEntry('')).toBe('')
    const long = cleanEntry('あ'.repeat(100))
    expect(long).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
  })

  test('この PC の時刻での日付と時刻、プロジェクト名、日報への材料', () => {
    const at = new Date(2026, 9, 27, 9, 5).getTime()
    expect(dayKey(at)).toBe('2026-10-27')
    expect(formatClock(at)).toBe('09:05')
    expect(projectName('/Users/me/app/')).toBe('app')
    expect(recapPrompt([entry(at, 'バグを直した')])).toBe('<log>\n09:05 [app] バグを直した\n</log>')
    expect(plainRecap([entry(at, 'バグを直した')])).toBe('- 09:05 [app] バグを直した')
  })
})

describe('サイドバー', () => {
  test('天気・使用量の枠・作業ログをカードで出す', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    const ui = await mountPane($)
    const shown = await texts(ui)

    expect(shown).toContain('⛅ Cloudy')
    expect(shown).toContain('58%')
    expect(shown).toContain('116k / 200k tokens')
    expect(shown).toContain('44k until auto-compact')
    // 内訳のカードはもう出さない
    expect(shown).not.toContain('Breakdown (est.)')
    // メモリのカードの代わりに作業ログのカード。まだ 1 行もない
    expect(shown).not.toContain('🧠 Memory')
    expect(shown).toContain('📝 Work log')
    expect(shown).toContain('No turn logged yet')
    // 5 時間枠が先、週の枠が後。名前の幅を揃えて、使用率とバーを並べる
    const rows = shown.filter(t => t.startsWith('5-hour') || t.startsWith('Weekly'))
    expect(rows.map(t => t.slice(0, 7))).toEqual(['5-hour ', 'Weekly '])
    expect(rows[0]).toContain('   2% ░')
    expect(shown.filter(t => t.startsWith('  resets '))).toHaveLength(2)
    expect(shown).toContain('Usage limits')
  })

  test('起動してからの経過時間を出す', async ($, on) => {
    // エンジンは startedAt: 0 を答えるので、いまが 65 分なら 1h 5m
    mock.clock(on, { now: 65 * 60_000 })
    engine(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    const ui = await mountPane($)
    expect(await texts(ui)).toContain('⏱ 1h 5m since start')
  })

  test('ターンごとの所要時間と、その推移を出す', async ($, on) => {
    mock.clock(on)
    engine(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))

    const done = (turnId: string, durationMs: number, agentId?: string) =>
      $.turn.complete({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
    await done('t1', 18_000)
    const ui = await mountPane($)
    // 1 ターン目から棒 1 本で出す。作業していないので丸はいない
    expect(turnRows(await texts(ui), 1)).toEqual(['       ', '      ▇', 'Turns █'])

    await done('t2', 42_000)
    // サブエージェントのターンは数えない
    await done('t3', 600_000, 'sub-1')
    const shown = await texts(ui)

    expect(shown).toContain('Last turn 42s · avg 30s')
    expect(turnRows(shown, 2)).toEqual(['        ', '       ▇', 'Turns ▇█'])
  })

  test('作業中だけ丸が Turns の段を左から跳んでいき、終わると消える', async ($, on) => {
    const clock = mock.clock(on)
    engine(on)
    loop(on)

    const done = (turnId: string, durationMs: number, agentId?: string) =>
      $.turn.complete({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
    // 低い、いちばん高い、中くらいの 3 本
    await done('t1', 10_000)
    await done('t2', 40_000)
    await done('t3', 20_000)
    const ui = await mountPane($)
    // 丸のいる [上から何行目, 何列目の棒]。いなければ undefined
    const at = async (bars: number) => {
      const rows = turnRows(await texts(ui), bars)
      const row = rows.findIndex(r => r.includes(HOPPER))
      return row < 0 ? undefined : [row, (rows[row] ?? '').indexOf(HOPPER) - 6]
    }
    // 作業していないあいだは丸を出さない
    expect(await at(3)).toBeUndefined()

    await $.turn.start({ text: 'hi', turnId: 't4' })
    const path = [await at(3)]
    for (let i = 0; i < 9; i++) {
      await clock.advance(120)
      path.push(await at(3))
    }
    // 乗る、跳び上がる、次の段の上へ。右端の外へ抜けたら、また左の段から
    expect(path).toEqual([[2, 0], [0, 0], [0, 1], [1, 1], [0, 1], [0, 2], [1, 2], [0, 2], undefined, [2, 0]])

    // サブエージェントのターンが終わっても跳び続ける
    await done('sub', 1_000, 'sub-1')
    await clock.advance(120)
    expect(await at(3)).toEqual([0, 0])

    // メインのターンが終わると丸は消え、時間が経っても出てこない
    await done('t4', 40_000)
    expect(turnRows(await texts(ui), 4)).toEqual(['          ', '       ▇ ▇', 'Turns ▄███'])
    await clock.advance(1_000)
    expect(await at(4)).toBeUndefined()
  })

  test('枠は、状態が空なら変化なしの応答からも取り込み、読みのない測り直しでは消えない', async ($, on) => {
    mock.clock(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    // 測り直しは枠の読みを返さないエンジン
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('tool.call', { tool: 'Bash' }, () => ({ ref: 1, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } }))

    // 枠に変化はない（changed に rateLimits がない）が、まだ何も持っていないので取り込む
    await $.session.measure({ context: { tokens: 10_000, window: 200_000, percent: 5 }, rateLimits: LIMITS, changed: ['context'] } as never)
    // ツール呼び出しの測り直しは枠を返さないが、持っている枠は残る
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await mountPane($)
    expect(await texts(ui)).toContain('Usage limits')
  })

  test('推移とターン時間は $.store に写される', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    const saved = store(on, { 'series:s1': { savedAt: 0, history: [], turns: [], reads: [{ name: 'old' }] } })
    engine(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    await measure($, { tokens: 12_000, window: 200_000, percent: 6 })
    await $.turn.complete({ turnId: 't1', durationMs: 18_000, answer: 'ok', isAborted: false, reason: 'answer' } as never)

    // 以前の版が残した読んだメモリは、書き直すときに落とす
    expect(saved['series:s1']).toEqual({ history: [5, 6], turns: [18_000], savedAt: 1_000 })
  })

  test('再読み込みで状態が空になっても、起動時に $.store から戻り、古い日の作業ログは消える', async ($, on) => {
    mock.clock(on, { now: NOON })
    const saved = store(on, {
      'series:s0': { savedAt: 1, history: [1], turns: [] },
      'series:s1': { savedAt: 2, history: [20, 50, 88], turns: [18_000, 42_000] },
      'log:2026-10-26:s1': [entry(NOON - 86_400_000, '昨日の作業')],
      'log:2026-10-27:s1': [entry(NOON - 60_000, '今日の作業')],
      'log:2026-10-27:s2': [entry(NOON - 30_000, '別のセッションの作業')],
      'log:2026-10-01:s1': [entry(NOON - 26 * 86_400_000, '古い作業')],
    })
    // 起動時の測り直しで使用量が入り、天気カードが描かれる
    engine(on, { tokens: 20_000, window: 200_000, percent: 10 })
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const ui = await mountPane($)
    const shown = await texts(ui)

    expect(shown).toContain('Trend ▂▅█')
    expect(shown).toContain('Last turn 42s · avg 30s')
    // このセッションの分だけを、新しいものを上に
    const logged = shown.filter(t => t.endsWith('の作業'))
    expect(logged).toEqual(['今日の作業', '昨日の作業'])
    expect(saved['log:2026-10-01:s1']).toBeUndefined()
    expect(saved['log:2026-10-27:s2']).toBeDefined()
  })

  test('応答を重ねると推移が伸び、かみなりで注意を出す', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 40_000, window: 200_000, percent: 20 })
    await measure($, { tokens: 176_000, window: 200_000, percent: 88 })
    const ui = await mountPane($)
    const shown = await texts(ui)

    expect(shown).toContain('⛈ Stormy')
    expect(shown).toContain('Auto-compact soon (0 left)')
    expect(shown).toContain('Trend ▂█')
  })

  test('計測前は控えめに出す', async ($, on) => {
    mock.clock(on)

    const ui = await mountPane($)
    expect(await texts(ui)).toContain('🌫 Not measured yet')
  })

  test('ツールを呼ぶたびにも測り直す', async ($, on) => {
    mock.clock(on)
    engine(on, { tokens: 30_000, window: 200_000, percent: 15 })
    tools(on)

    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await mountPane($)
    expect(await texts(ui)).toContain('☀️ Sunny')
  })

  test('/clear のあとは計測前に戻り、作業ログの表示も空になるが、日報用の控えは残る', async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    const saved = store(on, {})
    engine(on)
    tools(on)
    loop(on)
    haiku(on, () => 'バグを直した')
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    await work($, 't1', 'バグを直して', '直しました', [() => $.tool.call({ tool: 'Bash', command: 'ls' })])
    await clock.advance(10)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    const ui = await mountPane($)
    const shown = await texts(ui)

    expect(shown).toContain('🌫 Not measured yet')
    expect(shown).toContain('No turn logged yet')
    expect(saved['log:2026-10-27:s1']).toEqual([entry(NOON, 'バグを直した')])
  })

  test('入力欄の上の帯にはもう描かない', async ($, on) => {
    mock.clock(on)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })

    const ui = await $.ui.mount({
      plugin: 'token-weather',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  })
})

describe('作業ログ', () => {
  test('ターンが終わると、依頼と使ったツールと応答から Haiku に 1 行書かせ、新しいものを上に出す', async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    const saved = store(on, {})
    engine(on)
    tools(on)
    loop(on)
    const model = haiku(on, prompt => (prompt.includes('バグを直して') ? '- 「ログインのバグを直した。」' : '設計を説明した'))

    await work($, 't1', 'バグを直して', '直しました', [
      () => $.tool.call({ tool: 'Bash', command: 'ls' }),
      () => $.tool.call({ tool: 'Read', file_path: '/a' }),
      () => $.tool.call({ tool: 'Read', file_path: '/b' }),
      // サブエージェントが呼んだツールは数えない
      () => $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' } as never),
    ])
    // 作業ログは、ターンが終わった時刻でターンを見分ける
    await clock.advance(1_000)
    await work($, 't2', '設計を教えて', LONG_ANSWER)
    await clock.advance(10)

    expect(model.prompts[0]).toContain('依頼: バグを直して')
    expect(model.prompts[0]).toContain('使ったツール: Bash, Read ×2')
    expect(model.prompts[1]).toContain('使ったツール: なし')

    const shown = await texts(await mountPane($))
    expect(shown.filter(t => t === 'ログインのバグを直した' || t === '設計を説明した')).toEqual(['設計を説明した', 'ログインのバグを直した'])
    expect(saved['log:2026-10-27:s1']).toEqual([entry(NOON, 'ログインのバグを直した'), entry(NOON + 1_000, '設計を説明した')])
  })

  test('サブエージェントのターン、中断したターン、短いあいさつは書かない', async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    store(on, {})
    engine(on)
    tools(on)
    loop(on)
    const model = haiku(on, () => 'なにかした')

    await $.turn.start({ text: '調べて', turnId: 'sub', agentId: 'sub-1' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub-1' } as never)
    await $.turn.complete({ turnId: 'sub', durationMs: 1, answer: LONG_ANSWER, isAborted: false, reason: 'answer', agentId: 'sub-1' } as never)
    await $.turn.start({ text: '直して', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({ turnId: 't1', durationMs: 1, answer: '', isAborted: true, reason: 'aborted' } as never)
    await work($, 't2', 'ありがとう', 'どういたしまして')
    await clock.advance(10)

    expect(model.prompts).toEqual([])
    expect(await texts(await mountPane($))).toContain('No turn logged yet')
  })

  test('書き終わる前に読み込み直されても、起動時に控えから書く。書き終えていたターンは二重にしない', async ($, on) => {
    const clock = mock.clock(on, { now: NOON })
    const turn = (at: number, text: string) => ({ at, prompt: text, tools: ['Bash'], answer: 'ok' })
    const saved = store(on, {
      // 1 件目は書き終えたが控えから外す前に、2 件目は書く前に、読み込み直された
      'pending:s1': [turn(NOON - 2_000, '書いた'), turn(NOON - 1_000, 'まだ')],
      'log:2026-10-27:s1': [entry(NOON - 2_000, '書き終えていた作業')],
      // 書き終わらないまま閉じたほかのセッションの控え。古いものだけ消す
      'pending:s0': [turn(NOON - 30 * 86_400_000, '古い')],
      'pending:s2': [turn(NOON - 60_000, '今日')],
    })
    engine(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const model = haiku(on, () => '控えから書いた作業')

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await clock.advance(10)

    expect(model.prompts).toHaveLength(1)
    expect(model.prompts[0]).toContain('依頼: まだ')
    expect(saved['log:2026-10-27:s1']).toEqual([entry(NOON - 2_000, '書き終えていた作業'), entry(NOON - 1_000, '控えから書いた作業')])
    expect(saved['pending:s1']).toBeUndefined()
    expect(saved['pending:s0']).toBeUndefined()
    expect(saved['pending:s2']).toBeDefined()
    const shown = await texts(await mountPane($))
    expect(shown.filter(t => t.endsWith('作業'))).toEqual(['控えから書いた作業', '書き終えていた作業'])
  })

  test('畳んでいるときは新しい 5 件を 1 行ずつ、開くと全部を時刻つきで出す', async ($, on) => {
    mock.clock(on, { now: NOON })
    const at = (i: number) => new Date(2026, 9, 27, 9, i).getTime()
    store(on, { 'log:2026-10-27:s1': [1, 2, 3, 4, 5, 6, 7].map(i => entry(at(i), `作業${i}`)) })
    engine(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    // /nippo の登録が断られても（同じ名前の組み込みコマンドができたときなど）、起動時の復元は続く
    on('command.register', ($, e) => (e.name === 'nippo' ? { deny: 'it is a built-in command' } : { value: { command: e.name } }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const ui = await mountPane($)
    const folded = await texts(ui)
    expect(folded.filter(t => /^作業\d$/.test(t))).toEqual(['作業7', '作業6', '作業5', '作業4', '作業3'])
    expect(folded).toContain('+2 more')
    expect(folded).not.toContain("/nippo drafts today's report")

    await ui.press({ key: 'log' })
    const shown = await texts(ui)
    expect(shown.filter(t => /^09:0\d 作業\d$/.test(t))).toEqual(['09:07 作業7', '09:06 作業6', '09:05 作業5', '09:04 作業4', '09:03 作業3', '09:02 作業2', '09:01 作業1'])
    expect(shown).not.toContain('+2 more')
    expect(shown).toContain("/nippo drafts today's report")
  })

  test('/nippo は、今日の作業ログを全セッション分集めて Haiku に日報の下書きを書かせる', async ($, on) => {
    mock.clock(on, { now: NOON })
    store(on, {
      'log:2026-10-26:s1': [entry(NOON - 86_400_000, '昨日の作業')],
      'log:2026-10-27:s1': [entry(new Date(2026, 9, 27, 10, 0).getTime(), 'バグを直した')],
      'log:2026-10-27:s2': [entry(new Date(2026, 9, 27, 9, 0).getTime(), '資料を調べた', 'docs')],
    })
    const model = haiku(on, () => '### app\n- バグを直した\n')

    const result = await $.command.run({ command: 'nippo', args: '' } as never)

    expect(result.text).toBe('## 2026-10-27\n\n### app\n- バグを直した')
    expect(model.prompts).toEqual(['<log>\n09:00 [docs] 資料を調べた\n10:00 [app] バグを直した\n</log>'])
  })

  test('/nippo は、ログがなければそう言い、Haiku が答えなければログを並べて返す', async ($, on) => {
    mock.clock(on, { now: NOON })
    const saved = store(on, {})
    let answers = 0
    on('model.complete', () => {
      answers += 1
      return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    })

    expect((await $.command.run({ command: 'nippo', args: '' } as never)).text).toBe('No work logged today yet.')
    expect(answers).toBe(0)

    saved['log:2026-10-27:s1'] = [entry(new Date(2026, 9, 27, 10, 0).getTime(), 'バグを直した')]
    expect((await $.command.run({ command: 'nippo', args: '' } as never)).text).toBe('## 2026-10-27\n\n- 10:00 [app] バグを直した')
    expect(answers).toBe(1)
  })
})

describe('カードの展開', () => {
  test('天気のカードを押すと内訳が出て、もう一度押すと畳む', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    const ui = await mountPane($)
    expect((await texts(ui)).some(t => t.startsWith('Messages'))).toBe(false)

    await ui.press({ key: 'weather' })
    const shown = await texts(ui)
    // カテゴリ名、トークン数、窓に対する割合。Free space は使っていない行なので薄く
    expect(shown.find(t => t.startsWith('Messages'))).toMatch(/^Messages\s+72k\s+36%$/)
    expect(shown.find(t => t.startsWith('Free space'))).toMatch(/^Free space\s+90k\s+45%$/)
    expect(shown).toContain('of 200k (est.)')
    // 天気の見出しは開いていても残る
    expect(shown).toContain('⛅ Cloudy')

    await ui.press({ key: 'weather' })
    expect((await texts(ui)).some(t => t.startsWith('Messages'))).toBe(false)
  })

  test('計測前でも内訳は開ける', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)

    // 応答はまだないが、ツールを呼んだあとの測り直しで内訳だけは手に入る
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await mountPane($)
    await ui.press({ key: 'weather' })
    const shown = await texts(ui)

    expect(shown).toContain('🌫 Not measured yet')
    expect(shown.some(t => t.startsWith('Messages'))).toBe(true)
  })

  test('枠のカードを押すとリセットまでの残り時間が出る', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T16:00:00Z') })
    engine(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    const ui = await mountPane($)
    expect((await texts(ui)).some(t => t.includes(' left ('))).toBe(false)

    await ui.press({ key: 'limits' })
    const shown = await texts(ui).then(all => all.filter(t => t.includes(' left (')))
    expect(shown).toEqual(['  2h 10m left (five_hour)', '  19h 0m left (seven_day)'])
  })

  test('/clear のあとは内訳を忘れるが、開いたカードはそのまま', async ($, on) => {
    mock.clock(on)
    engine(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    const ui = await mountPane($)
    await ui.press({ key: 'weather' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)

    expect(await texts(ui)).toContain('No breakdown yet')
  })
})
