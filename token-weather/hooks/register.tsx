import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown, SessionContextUsage, SessionRateLimit, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Card, IndexEntry, Limit, MemoryIndex, MemoryRead, Usage } from '../types'
import { ageDaysIn, formatAge, isMemoryIndex, loadedFilesIn, memoryFileName, memoryPathsIn, parseEntries, shorten, stem } from './memory.ts'
import { bar, formatLeft, formatReset, formatTokens, limitColor, limitLabel, limitOrder, padCells, percentOf, sparkline, weatherFor } from './weather.ts'

const PANE = 'token-weather'
const TITLE = 'Token Weather'
const COMMAND = 'weather'
// 全画面表示のときにサイドバーとして欲しい幅
const PANE_COLUMNS = 32
// 推移グラフに残すターン数
const HISTORY = 40
// 読んだメモリのうち、覚えておく数と見せる数
const READS_KEPT = 30
const READS_SHOWN = 8
// 起動直後は CLAUDE.md や MEMORY.md がまだ読み込まれていないことがあるので、少し待ってから内訳を取り直す
const LATE_REFRESH_MS = [3_000, 10_000]

const usage = atom({ plugin: 'token-weather', key: 'usage' } as const, null)
const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
const limits = atom({ plugin: 'token-weather', key: 'limits' } as const, [])
const autoCompactAt = atom({ plugin: 'token-weather', key: 'autoCompactAt' } as const, null)
const memory = atom({ plugin: 'token-weather', key: 'memory' } as const, { index: null, reads: [] })
const breakdown = atom({ plugin: 'token-weather', key: 'breakdown' } as const, null)
const open = atom({ plugin: 'token-weather', key: 'open' } as const, { weather: false, limits: false, memory: false })

// 応答がまだ使用量を報告していなければ null
function snapshot(context: SessionContextUsage): Usage | null {
  if (context.percent === undefined || context.tokens === undefined) {
    return null
  }

  return { percent: context.percent, tokens: context.tokens, window: context.window }
}

function toLimits(rateLimits: readonly SessionRateLimit[]): Limit[] {
  return rateLimits
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) }))
    .sort((a, b) => limitOrder(a.kind) - limitOrder(b.kind))
}

// 索引の項目は、パスとトークン数が変わらないかぎり読み直さない
let counted: { path: string; tokens?: number; entries?: IndexEntry[] } | undefined

async function describeIndex($: EngineInterface, path: string, tokens?: number): Promise<MemoryIndex> {
  if (counted?.path !== path || counted.tokens !== tokens) {
    let entries: IndexEntry[] | undefined
    try {
      entries = parseEntries(await $.fs.read(path))
    } catch {
      entries = undefined
    }

    counted = { path, ...(tokens !== undefined ? { tokens } : {}), ...(entries !== undefined ? { entries } : {}) }
  }

  return { path, ...(tokens !== undefined ? { tokens } : {}), ...(counted.entries !== undefined ? { entries: counted.entries } : {}) }
}

// 索引が載ったと分かったら覚える。トークン数は内訳から分かったときだけ更新し、一度載った索引は /clear まで消さない
async function noteIndex($: EngineInterface, path: string, tokens?: number): Promise<void> {
  const index = await describeIndex($, path, tokens)
  await update($, memory, m => ({ ...m, index: { ...index, ...(index.tokens === undefined && m.index?.tokens !== undefined ? { tokens: m.index.tokens } : {}) } }))
}

// 内訳から、自動圧縮のしきい値と、カテゴリごとの行と、エンジンが数える memory files（CLAUDE.md 群と MEMORY.md）を取り出す
async function absorb($: EngineInterface, b: SessionContextBreakdown): Promise<void> {
  await update($, autoCompactAt, () => (b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null))
  await update($, breakdown, () => ({
    categories: b.categories.flatMap(c => (c.kind === 'deferred' ? [] : [{ name: c.name, tokens: c.tokens, kind: c.kind }])),
    window: b.rawMaxTokens,
  }))

  const others = b.memoryFiles.filter(f => f.type !== 'AutoMem')
  const root = others.length > 0 ? await $.session.root() : undefined
  const home = others.length > 0 ? await $.env.get('HOME') : undefined
  for (const f of b.memoryFiles) {
    if (f.type === 'AutoMem') {
      await noteIndex($, f.path, f.tokens)
    } else {
      // 応答のたびに来るので、載っているものは並びを動かさない
      await remember($, { name: shorten(f.path, root, home), path: f.path, how: 'auto' }, { keep: true })
    }
  }
}

// 読んだものとして覚える。同じファイルは 1 件だけ残し、読み直したら最新に上げる（keep なら動かさない）
async function remember($: EngineInterface, read: Omit<MemoryRead, 'at'>, options?: { keep: boolean }): Promise<void> {
  const at = await $.clock.now()
  await update($, memory, m => {
    if (options?.keep && m.reads.some(r => r.path === read.path)) {
      return m
    }

    return { ...m, reads: [...m.reads.filter(r => r.path !== read.path), { ...read, at }].slice(-READS_KEPT) }
  })
}

// サブエージェントでもチームメイトでもないループは、エンジン自身のもの（compaction やメモリ処理）
async function isEngineLoop($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  if (agentId === undefined) {
    return false
  }

  try {
    return !(await $.agent.list()).some(a => a.id === agentId)
  } catch {
    return false
  }
}

// エンジンが注入した文章に指示ファイルやメモリが含まれていたら、勝手に読まれたものとして覚える
async function noteInjected($: EngineInterface, text: string): Promise<void> {
  const files = loadedFilesIn(text)
  const root = files.length > 0 ? await $.session.root() : undefined
  const home = files.length > 0 ? await $.env.get('HOME') : undefined
  for (const f of files) {
    if (isMemoryIndex(f.path)) {
      await noteIndex($, f.path)
      continue
    }

    const name = memoryFileName(f.path)
    await remember($, { name: name ? stem(name) : shorten(f.path, root, home), path: f.path, how: 'auto' })
  }

  // 見出しなしで本文に現れたメモリ（想起）も拾う
  for (const path of memoryPathsIn(text)) {
    const name = memoryFileName(path)
    if (name && !files.some(f => f.path === path)) {
      await remember($, { name: stem(name), path, how: 'auto' })
    }
  }
}

// 使用量と枠を測り直す。内訳は手元での見積もりなので API 呼び出しは発生しない
async function refresh($: EngineInterface, withBreakdown: boolean): Promise<void> {
  const measured = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  await update($, usage, () => snapshot(measured.context))
  await update($, limits, () => toLimits(measured.rateLimits))

  const b = measured.context.breakdown
  if (b) {
    await absorb($, b)
  }
}

// Read か Bash でメモリファイルを読んでいたら、読んだものとして覚える。エンジン自身のループが読んだものは auto
async function noteMemoryRead($: EngineInterface, e: ToolCallInput, result: ToolCallResult): Promise<void> {
  if (result.deny !== undefined || result.isError) {
    return
  }

  const paths = e.tool === 'Read' ? [e.file_path] : e.tool === 'Bash' ? memoryPathsIn(e.command) : []
  if (paths.length === 0) {
    return
  }

  const ageDays = ageDaysIn(result.text)
  const how = (await isEngineLoop($, e.agentId)) ? 'auto' : 'tool'
  for (const path of paths) {
    const name = memoryFileName(path)
    if (name) {
      await remember($, { name: stem(name), path, how, ...(ageDays !== undefined ? { ageDays } : {}) })
    }
  }
}

async function toggle($: EngineInterface): Promise<string> {
  const mine = (await $.ui.panes()).find(pane => pane.id === PANE)
  if (mine?.isShown) {
    await $.ui.close({ id: PANE })
    return 'Token Weather closed.'
  }

  await $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })
  return 'Token Weather opened.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Open or close Token Weather (context usage as weather) on the right', immediate: true })
    await refresh($, true)
    for (const ms of LATE_REFRESH_MS) {
      $.clock.after(ms, () => void refresh($, true).catch(() => undefined))
    }

    // 頼まれずに開くペインは、端末が 144 列以上のときだけ横に並ぶ。狭いときは /weather で開く
    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

    return next(e)
  })

  // プロンプトが送られた時点でも取り直す。最初の応答を待たずに、起動時に載った memory files を出すため
  on('turn.start', async ($, e, next) => {
    await refresh($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => ({ text: await toggle($) }))

  // 応答のたびに Claude Code が使用量を知らせてくる
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const measured = snapshot(e.context)
      await update($, usage, () => measured)
      if (measured) {
        await update($, history, list => [...list, measured.percent].slice(-HISTORY))
      }

      const detailed = await $.session.usage({ breakdown: 'summary' })
      const b = detailed.context.breakdown
      if (b) {
        await absorb($, b)
      }
    }

    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toLimits(e.rateLimits))
    }

    return next(e)
  })

  // 長い作業の途中でも天気が変わるように、ツールを呼ぶたびにも測り直す。メモリを読んでいればそれも控える
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await noteMemoryRead($, e, result)
    if (!e.agentId) {
      await refresh($, false)
    }

    return result
  }).catch(($, e, next) => next(e))

  // エンジンがモデルに向けて勝手に差し込む文章（起動時の CLAUDE.md と MEMORY.md、ディレクトリに触れたときの CLAUDE.md、想起）
  on('prompt.attachment', async ($, e, next) => {
    await noteInjected($, e.text)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, usage, () => null)
      await update($, history, () => [])
      await update($, autoCompactAt, () => null)
      await update($, memory, () => ({ index: null, reads: [] }))
      await update($, breakdown, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const trend = await read($, history)
    const windows = await read($, limits)
    const compactAt = await read($, autoCompactAt)
    const mem = await read($, memory)
    const parts = await read($, breakdown)
    const opened = await read($, open)
    const now = await $.clock.now()

    // 枠線 2 と左右の余白 2 を引いた、カードの中の幅
    const inner = Math.max(12, e.props.bodyColumns - 4)
    // 枠の名前（7 列）と使用率（5 列）、空白 1 列のあとに残る幅をバーにする
    const limitBar = Math.max(inner - 13, 4)
    // 印 2 列、メモリの名前、空白 1 列、日数 4 列
    const memoryName = Math.max(inner - 7, 6)
    // 内訳の行: カテゴリ名、空白 1 列、トークン数 5 列、空白 1 列、割合 4 列
    const categoryName = Math.max(inner - 11, 6)

    // カードの見出しを押すと、そのカードの詳細を開け閉めする。描画中は書けないので押されたときに書く
    const toggle = (card: Card) => () => void update($, open, o => ({ ...o, [card]: !o[card] }))
    const mark = (card: Card) => (opened[card] ? '▾' : '▸')

    const weather = u ? weatherFor(u.percent) : undefined
    const untilCompact = u && compactAt ? Math.max(compactAt - u.tokens, 0) : undefined
    // 新しく読んだものを上に。開いていれば全部、畳んでいれば上から数件
    const recent = [...mem.reads].reverse().slice(0, opened.memory ? mem.reads.length : READS_SHOWN)
    const hidden = mem.reads.length - recent.length
    const hasAuto = recent.some(r => r.how === 'auto')

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={weather?.color ?? 'gray'} paddingX={1} flexDirection="column">
          {u && weather ? (
            <Box flexDirection="column">
              <Box justifyContent="space-between">
                <Button key="weather" plain onPress={toggle('weather')}>
                  <Text bold color={weather.color}>
                    {weather.icon} {weather.label}
                  </Text>{' '}
                  <Text dimColor>{mark('weather')}</Text>
                </Button>
                <Text bold color={weather.color}>
                  {u.percent}%
                </Text>
              </Box>
              <Text color={weather.color}>{bar(u.percent, inner)}</Text>
              <Text>
                {formatTokens(u.tokens)} / {formatTokens(u.window)} tokens
              </Text>
              {untilCompact !== undefined &&
                (weather.note ? (
                  <Text color="red">
                    {weather.note} ({formatTokens(untilCompact)} left)
                  </Text>
                ) : (
                  <Text dimColor>{formatTokens(untilCompact)} until auto-compact</Text>
                ))}
              {trend.length >= 2 && (
                <Text dimColor wrap="truncate-end">
                  Trend {sparkline(trend.slice(-(inner - 6)))}
                </Text>
              )}
            </Box>
          ) : (
            <Box flexDirection="column">
              <Button key="weather" plain onPress={toggle('weather')}>
                <Text dimColor>🌫 Not measured yet</Text> <Text dimColor>{mark('weather')}</Text>
              </Button>
              <Text dimColor>Shows after the first reply</Text>
            </Box>
          )}
          {/* 開くと /context と同じ内訳。手元の見積もりなので、上の使用率と合計は一致しないことがある */}
          {opened.weather &&
            (parts ? (
              <Box flexDirection="column" marginTop={1}>
                {parts.categories.map(c => (
                  <Text wrap="truncate-end" dimColor={c.kind !== 'used'}>
                    {padCells(c.name.slice(0, categoryName), categoryName)} {formatTokens(c.tokens).padStart(5)} {`${percentOf(c.tokens, parts.window)}%`.padStart(4)}
                  </Text>
                ))}
                <Text dimColor>of {formatTokens(parts.window)} (est.)</Text>
              </Box>
            ) : (
              <Text dimColor>No breakdown yet</Text>
            ))}
        </Box>

        {windows.length > 0 && (
          <Box borderStyle="round" borderColor={limitColor(Math.max(...windows.map(w => w.percentUsed)))} paddingX={1} flexDirection="column">
            <Button key="limits" plain onPress={toggle('limits')}>
              <Text bold>Usage limits</Text> <Text dimColor>{mark('limits')}</Text>
            </Button>
            {windows.map(w => (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  {padCells(limitLabel(w.kind), 7)}
                  <Text color={limitColor(w.percentUsed)}>
                    {`${w.percentUsed}%`.padStart(5)} {bar(w.percentUsed, limitBar)}
                  </Text>
                </Text>
                {w.resetsAt && (
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    resets {formatReset(w.resetsAt)}
                  </Text>
                )}
                {/* 開くと、リセットまでの残り時間と枠の名前 */}
                {opened.limits && w.resetsAt && (
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {formatLeft(Date.parse(w.resetsAt) - now)} left ({w.kind})
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}

        <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
          <Button key="memory" plain onPress={toggle('memory')}>
            <Text bold>🧠 Memory</Text> <Text dimColor>{mark('memory')}</Text>
          </Button>
          {mem.index ? (
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">Index {mem.index.entries !== undefined ? `${mem.index.entries.length} entries` : 'loaded'}</Text>
              {mem.index.tokens !== undefined && <Text dimColor>{formatTokens(mem.index.tokens)}</Text>}
            </Box>
          ) : (
            <Text dimColor>Index not in context</Text>
          )}
          {/* 開くと、索引に並ぶ項目の名前 */}
          {opened.memory &&
            mem.index?.entries?.map(entry => (
              <Text dimColor wrap="truncate-end">
                {'  · '}
                {entry.title}
              </Text>
            ))}
          {opened.memory && recent.length > 0 && <Text dimColor>Read this session</Text>}
          {recent.length === 0 ? (
            <Text dimColor>No memory file read yet</Text>
          ) : (
            recent.map(r => (
              <Text wrap="truncate-end">
                {r.how === 'auto' ? '* ' : '  '}
                {padCells(r.name.slice(0, memoryName), memoryName)} <Text dimColor>{formatAge(r.ageDays).padStart(4)}</Text>
              </Text>
            ))
          )}
          {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
          {hasAuto && <Text dimColor>* loaded by the engine</Text>}
        </Box>
      </Box>
    )
  })
}
