import { describe, expect, mock, test } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'
import type { On, SessionContextBreakdown, SessionContextUsage, SessionRateLimit } from 'claude-code'

import { ageDaysIn, countEntries, formatAge, isMemoryIndex, loadedFilesIn, memoryFileName, memoryPathsIn, parseEntries, shorten, stem } from '../hooks/memory.ts'
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

// auto-memory のディレクトリと、そこに置かれた索引
const MEMORY_DIR = '/Users/me/.claude/projects/-Users-me-app/memory'
const INDEX_PATH = `${MEMORY_DIR}/MEMORY.md`
const INDEX_TEXT = ['# Memory index', '', '- [Flow HTML structure](flow-html-structure.md) — sections and ids', '- [Intern materials](intern-materials.md) — audience'].join('\n')
const AGE_NOTE = '<system-reminder>This memory is 48 days old. Memories are point-in-time observations, not live state.</system-reminder>\n'
const HOME = '/Users/me'
const ROOT = '/Users/me/app'
// 起動時にエンジンが差し込む、CLAUDE.md と索引をまとめた文章
const INSTRUCTIONS = [
  `Contents of ${HOME}/.claude/CLAUDE.md (user's private global instructions for all projects):`,
  '',
  '# 禁止事項',
  '',
  `Contents of ${ROOT}/.claude/CLAUDE.md (project instructions, checked into the codebase):`,
  '',
  '# Project',
  '',
  `Contents of ${INDEX_PATH} (user's auto-memory, persists across conversations):`,
  '',
  INDEX_TEXT,
].join('\n')

const BREAKDOWN = {
  categories: [
    { name: 'Messages', tokens: 72_000, color: 'x', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 90_000, color: 'x', isDeferred: false, kind: 'free' },
  ],
  memoryFiles: [{ path: INDEX_PATH, type: 'AutoMem', tokens: 300 }],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 160_000,
  rawMaxTokens: 200_000,
} as unknown as SessionContextBreakdown

// エンジンが memory files に CLAUDE.md も数えているときの内訳
const WITH_CLAUDE_MD = {
  ...BREAKDOWN,
  memoryFiles: [{ path: `${HOME}/.claude/CLAUDE.md`, type: 'User', tokens: 200 }, ...BREAKDOWN.memoryFiles],
} as unknown as SessionContextBreakdown

// Claude Code が応答のあとに使用量を知らせてくるのと同じ呼び方
async function measure($: { session: { measure: (e: never) => Promise<unknown> } }, context: SessionContextUsage, rateLimits = LIMITS) {
  await $.session.measure({ context, rateLimits, changed: ['context', 'rateLimits'] } as never)
}

// 内訳つきの使用量を答え、索引を読ませ、エージェントは一つもいないエンジンの代わり
const engine = (on: On, context: SessionContextUsage = { window: 200_000 }, breakdown: SessionContextBreakdown = BREAKDOWN) => {
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { ...context, breakdown }, rateLimits: LIMITS } }))
  on('session.root', () => ({ value: ROOT }))
  on('fs.read', () => ({ value: INDEX_TEXT }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))
  mock.env(on, { HOME })
}

// エンジンがモデルに向けて文章を差し込むのと同じ呼び方
async function inject($: { prompt: { attachment: (e: never) => Promise<unknown> } }, type: string, text: string) {
  await $.prompt.attachment({ type, text } as never)
}

// メモリの行だけを取り出し、印・名前・日数に分ける。枠の使用率の行（「  36% █…」）、索引の項目（「  · …」）と凡例は除く
function memoryRows(shown: string[]): string[][] {
  return shown
    .filter(t => /^(\* |  )[^\d\s·]/.test(t) && !t.startsWith('  resets') && t !== '* loaded by the engine')
    .map(t => [t.startsWith('* ') ? '*' : '', ...t.slice(2).trim().split(/\s+/)])
}

// Read と Bash を、エンジンがメモリファイルに付ける注意書きごと真似る
const tools = (on: On) => {
  on('tool.call', { tool: 'Read' }, ($, e) => {
    const isMemory = e.file_path.startsWith(MEMORY_DIR)
    return {
      ref: 1,
      text: `${isMemory ? AGE_NOTE : ''}1\t---`,
      result: { type: 'text' as const, file: { filePath: e.file_path, content: '---', numLines: 1, startLine: 1, totalLines: 1 } },
    }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ ref: 1, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } }))
}

async function texts(ui: Mounted<'terminal', 'Pane'>): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text)
}

// Turns のグラフの行を上から。見出しか字下げの 6 列に、棒の本数ぶんの列が続く行だけを拾う（丸の前後で区切った断片は短いので落ちる）
function turnRows(shown: string[], bars: number): string[] {
  return shown.filter(t => t.length === 6 + bars && /^(Turns | {6})/.test(t))
}

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

describe('メモリの見つけ方', () => {
  test('auto-memory の個別ファイルだけを拾い、索引と無関係なファイルは拾わない', () => {
    expect(memoryFileName(`${MEMORY_DIR}/flow-html-structure.md`)).toBe('flow-html-structure.md')
    expect(memoryFileName(INDEX_PATH)).toBeUndefined()
    expect(memoryFileName('/Users/me/app/memory/notes.md')).toBeUndefined()
    expect(memoryFileName('/Users/me/app/README.md')).toBeUndefined()
  })

  test('Bash コマンドの中のパスを重複なく拾う', () => {
    const command = `cat '${MEMORY_DIR}/a.md' ${MEMORY_DIR}/b.md; cat ${MEMORY_DIR}/a.md ${INDEX_PATH}`
    expect(memoryPathsIn(command)).toEqual([`${MEMORY_DIR}/a.md`, `${MEMORY_DIR}/b.md`])
    expect(memoryPathsIn('ls -la')).toEqual([])
  })

  test('注入された文章から見出しを拾い、索引を見分け、パスを短くする', () => {
    expect(loadedFilesIn(INSTRUCTIONS).map(f => f.path)).toEqual([`${HOME}/.claude/CLAUDE.md`, `${ROOT}/.claude/CLAUDE.md`, INDEX_PATH])
    expect(loadedFilesIn(INSTRUCTIONS)[2]?.label).toBe("user's auto-memory, persists across conversations")
    expect(loadedFilesIn('no headings here')).toEqual([])
    expect(isMemoryIndex(INDEX_PATH)).toBe(true)
    expect(isMemoryIndex(`${MEMORY_DIR}/a.md`)).toBe(false)
    expect(shorten(`${ROOT}/web/CLAUDE.md`, ROOT, HOME)).toBe('web/CLAUDE.md')
    expect(shorten(`${HOME}/.claude/CLAUDE.md`, ROOT, HOME)).toBe('~/.claude/CLAUDE.md')
    expect(shorten('/etc/claude/CLAUDE.md', ROOT, HOME)).toBe('/etc/claude/CLAUDE.md')
  })

  test('注意書きの日数・索引の項目数・名前と日数の整形', () => {
    expect(ageDaysIn(AGE_NOTE)).toBe(48)
    expect(ageDaysIn('This memory is 1 day old.')).toBe(1)
    expect(ageDaysIn('1\t---')).toBeUndefined()
    expect(ageDaysIn(undefined)).toBeUndefined()
    expect(countEntries(INDEX_TEXT)).toBe(2)
    expect(parseEntries(INDEX_TEXT)).toEqual([
      { title: 'Flow HTML structure', file: 'flow-html-structure.md' },
      { title: 'Intern materials', file: 'intern-materials.md' },
    ])
    expect(parseEntries('# Memory index\n\nno entries')).toEqual([])
    expect(stem('flow-html-structure.md')).toBe('flow-html-structure')
    expect([formatAge(48), formatAge(undefined)]).toEqual(['48d', ''])
  })
})

describe('サイドバー', () => {
  test('天気・メモリ・使用量の枠をカードで出す', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(shown).toContain('⛅ Cloudy')
    expect(shown).toContain('58%')
    expect(shown).toContain('116k / 200k tokens')
    expect(shown).toContain('44k until auto-compact')
    // 内訳のカードはもう出さない
    expect(shown).not.toContain('Breakdown (est.)')
    // 索引はコンテキストに載っている。個別ファイルはまだ読んでいない
    expect(shown).toContain('🧠 Memory')
    expect(shown).toContain('Index 2 entries')
    expect(shown).toContain('No memory file read yet')
    // 5 時間枠が先、週の枠が後。名前の幅を揃えて、使用率とバーを並べる
    const rows = shown.filter(t => t.startsWith('5-hour') || t.startsWith('Weekly'))
    expect(rows.map(t => t.slice(0, 7))).toEqual(['5-hour ', 'Weekly '])
    expect(rows[0]).toContain('   2% ░')
    expect(shown.filter(t => t.startsWith('  resets '))).toHaveLength(2)
    expect(shown).toContain('Usage limits')
  })

  test('読んだメモリを新しい順に、日数つきで並べる', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)

    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/flow-html-structure.md` })
    await $.tool.call({ tool: 'Read', file_path: '/Users/me/app/README.md' })
    await $.tool.call({ tool: 'Bash', command: `cat ${MEMORY_DIR}/intern-materials.md` })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(memoryRows(shown)).toEqual([['', 'intern-materials'], ['', 'flow-html-structure', '48d']])
    expect(shown).not.toContain('No memory file read yet')
    expect(shown).not.toContain('* loaded by the engine')
  })

  test('同じメモリを読み直すと 1 件にまとめて上に上がる', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)

    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/a.md` })
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/b.md` })
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/a.md` })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })

    expect(memoryRows(await texts(ui)).map(r => r[1])).toEqual(['a', 'b'])
  })

  test('起動時に勝手に差し込まれた CLAUDE.md と索引を、印つきで出す', async ($, on) => {
    mock.clock(on)
    engine(on)

    await inject($, 'instructions', INSTRUCTIONS)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    // 索引は Index の行で示し、一覧には出さない。トークン数は内訳が来るまで分からない
    expect(shown).toContain('Index 2 entries')
    expect(shown.filter(t => t.includes('MEMORY'))).toEqual([])
    expect(memoryRows(shown)).toEqual([['*', '.claude/CLAUDE.md'], ['*', '~/.claude/CLAUDE.md']])
    expect(shown).toContain('* loaded by the engine')
  })

  test('ディレクトリに触れたときの CLAUDE.md と、本文に現れた想起メモリも拾う', async ($, on) => {
    mock.clock(on)
    engine(on)

    await inject($, 'nested_memory', `Contents of ${ROOT}/web/CLAUDE.md (project instructions, checked into the codebase):\n\n# Web`)
    await inject($, 'some_recall', `<system-reminder>Recalled: ${MEMORY_DIR}/flow-html-structure.md\n---\nname: flow-html-structure</system-reminder>`)
    await inject($, 'todo_reminder', 'Your todo list is empty.')
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })

    expect(memoryRows(await texts(ui))).toEqual([['*', 'flow-html-structure'], ['*', 'web/CLAUDE.md']])
  })

  test('エンジン自身のループが読んだメモリは auto、Claude が読んだものと区別する', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)

    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/a.md`, agentId: 'engine-memory-fork' } as never)
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/b.md` })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })

    expect(memoryRows(await texts(ui))).toEqual([['', 'b', '48d'], ['*', 'a', '48d']])
  })

  test('エンジンが数える CLAUDE.md は印つきで出し、応答のたびに来ても読んだものの上に出てこない', async ($, on) => {
    mock.clock(on)
    engine(on, undefined, WITH_CLAUDE_MD)
    tools(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/a.md` })
    await measure($, { tokens: 12_000, window: 200_000, percent: 6 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })

    expect(memoryRows(await texts(ui))).toEqual([['', 'a', '48d'], ['*', '~/.claude/CLAUDE.md']])
  })

  test('プロンプトが送られた時点で内訳を取り直し、最初の応答を待たずに索引を出す', async ($, on) => {
    mock.clock(on)
    engine(on, undefined, WITH_CLAUDE_MD)
    on('turn.start', ($, e) => ({ turnId: e.turnId }))

    await $.turn.start({ text: 'hi', turnId: 't1' })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(shown).toContain('Index 2 entries')
    expect(memoryRows(shown)).toEqual([['*', '~/.claude/CLAUDE.md']])
  })

  test('起動してからの経過時間を出す', async ($, on) => {
    // エンジンは startedAt: 0 を答えるので、いまが 65 分なら 1h 5m
    mock.clock(on, { now: 65 * 60_000 })
    engine(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    expect(await texts(ui)).toContain('⏱ 1h 5m since start')
  })

  test('ターンごとの所要時間と、その推移を出す', async ($, on) => {
    mock.clock(on)
    engine(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))

    const done = (turnId: string, durationMs: number, agentId?: string) =>
      $.turn.complete({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
    await done('t1', 18_000)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
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
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('turn.complete', ($, e) => ({ text: e.answer }))

    const done = (turnId: string, durationMs: number, agentId?: string) =>
      $.turn.complete({ turnId, durationMs, answer: 'ok', isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
    // 低い、いちばん高い、中くらいの 3 本
    await done('t1', 10_000)
    await done('t2', 40_000)
    await done('t3', 20_000)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
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
    on('agent.list', () => ({ value: [] }))
    on('tool.call', { tool: 'Bash' }, () => ({ ref: 1, text: 'ok', result: { stdout: 'ok', stderr: '', interrupted: false } }))

    // 枠に変化はない（changed に rateLimits がない）が、まだ何も持っていないので取り込む
    await $.session.measure({ context: { tokens: 10_000, window: 200_000, percent: 5 }, rateLimits: LIMITS, changed: ['context'] } as never)
    // ツール呼び出しの測り直しは枠を返さないが、持っている枠は残る
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    expect(await texts(ui)).toContain('Usage limits')
  })

  test('推移・ターン時間・読んだメモリは $.store に写される', async ($, on) => {
    mock.clock(on, { now: 1_000 })
    engine(on)
    tools(on)
    on('session.id', () => ({ value: 's1' }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    // テストの $ には store がないので、書かれたものを自前で受け止める
    const saved: Record<string, unknown> = {}
    on('store.get', ($, e) => ({ value: saved[e.key] }))
    on('store.set', ($, e) => {
      saved[e.key] = e.value
      return { value: undefined }
    })
    on('store.keys', () => ({ value: Object.keys(saved) }))

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    await measure($, { tokens: 12_000, window: 200_000, percent: 6 })
    await $.turn.complete({ turnId: 't1', durationMs: 18_000, answer: 'ok', isAborted: false, reason: 'answer' } as never)
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/a.md` })

    expect(saved['series:s1']).toMatchObject({ history: [5, 6], turns: [18_000], reads: [{ name: 'a', how: 'tool', ageDays: 48 }], savedAt: 1_000 })
  })

  test('再読み込みで状態が空になっても、起動時に $.store から戻る', async ($, on) => {
    mock.clock(on)
    mock.store(on, {
      'series:s0': { savedAt: 1, history: [1], turns: [], reads: [] },
      'series:s1': { savedAt: 2, history: [20, 50, 88], turns: [18_000, 42_000], reads: [{ name: 'a', path: `${MEMORY_DIR}/a.md`, at: 2, how: 'tool', ageDays: 48 }] },
    })
    // 起動時の測り直しで使用量が入り、天気カードが描かれる
    engine(on, { tokens: 20_000, window: 200_000, percent: 10 })
    on('session.id', () => ({ value: 's1' }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', () => ({ value: { command: 'weather' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))

    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(shown).toContain('Trend ▂▅█')
    expect(shown).toContain('Last turn 42s · avg 30s')
    expect(memoryRows(shown)).toEqual([['', 'a', '48d']])
  })

  test('索引がないプロジェクトでは、ないと言う', async ($, on) => {
    mock.clock(on)
    on('session.measure', ($, e) => ({ changed: e.changed }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, breakdown: { ...BREAKDOWN, memoryFiles: [] } }, rateLimits: [] } }))

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 }, [])
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    expect(await texts(ui)).toContain('Index not in context')
  })

  test('応答を重ねると推移が伸び、かみなりで注意を出す', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 40_000, window: 200_000, percent: 20 })
    await measure($, { tokens: 176_000, window: 200_000, percent: 88 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(shown).toContain('⛈ Stormy')
    expect(shown).toContain('Auto-compact soon (0 left)')
    expect(shown).toContain('Trend ▂█')
  })

  test('計測前は控えめに出す', async ($, on) => {
    mock.clock(on)

    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    expect(await texts(ui)).toContain('🌫 Not measured yet')
  })

  test('ツールを呼ぶたびにも測り直す', async ($, on) => {
    mock.clock(on)
    engine(on, { tokens: 30_000, window: 200_000, percent: 15 })
    tools(on)

    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    expect(await texts(ui)).toContain('☀️ Sunny')
  })

  test('/clear のあとは計測前に戻り、読んだメモリも忘れる', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/flow-html-structure.md` })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const shown = await texts(ui)

    expect(shown).toContain('🌫 Not measured yet')
    expect(shown).toContain('No memory file read yet')
    expect(shown).toContain('Index not in context')
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

describe('カードの展開', () => {
  test('天気のカードを押すと内訳が出て、もう一度押すと畳む', async ($, on) => {
    mock.clock(on)
    engine(on)

    await measure($, { tokens: 116_000, window: 200_000, percent: 58 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
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
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    await ui.press({ key: 'weather' })
    const shown = await texts(ui)

    expect(shown).toContain('🌫 Not measured yet')
    expect(shown.some(t => t.startsWith('Messages'))).toBe(true)
  })

  test('メモリのカードを押すと索引の項目と、読んだもの全部が出る', async ($, on) => {
    mock.clock(on)
    engine(on)
    tools(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await $.tool.call({ tool: 'Read', file_path: `${MEMORY_DIR}/note-${n}.md` })
    }
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    const folded = await texts(ui)
    expect(memoryRows(folded)).toHaveLength(8)
    expect(folded).toContain('+2 more')
    expect(folded).not.toContain('  · Flow HTML structure')

    await ui.press({ key: 'memory' })
    const shown = await texts(ui)
    expect(shown).toContain('Index 2 entries')
    expect(shown).toContain('  · Flow HTML structure')
    expect(shown).toContain('  · Intern materials')
    expect(shown).toContain('Read this session')
    expect(memoryRows(shown)).toHaveLength(10)
    expect(shown).not.toContain('+2 more')
  })

  test('枠のカードを押すとリセットまでの残り時間が出る', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T16:00:00Z') })
    engine(on)

    await measure($, { tokens: 10_000, window: 200_000, percent: 5 })
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
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
    const ui = await $.ui.mount({ plugin: 'token-weather', surface: 'terminal', component: 'Pane', props: pane(), requestId: 'token-weather' })
    await ui.press({ key: 'weather' })
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} } as never)

    expect(await texts(ui)).toContain('No breakdown yet')
  })
})
