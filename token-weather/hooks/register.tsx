import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextBreakdown, SessionContextUsage, SessionRateLimit, Timer } from 'claude-code'

import type { Card, Limit, LogEntry, Usage } from '../types'
import { LOG_SYSTEM, RECAP_SYSTEM, cleanEntry, dayKey, formatClock, isLog, isTurns, logPrompt, plainRecap, projectName, recapPrompt } from './log.ts'
import type { Turn } from './log.ts'
import { HOPPER, bar, formatLeft, formatReset, formatSeconds, formatTokens, hopAt, limitColor, limitLabel, limitOrder, padCells, percentOf, sparkline, stepHeights, steps, weatherFor } from './weather.ts'

const PANE = 'token-weather'
const TITLE = 'Token Weather'
const COMMAND = 'weather'
// /recap は Claude Code にもともとあるので、日報の下書きは /nippo で作る
const RECAP = 'nippo'
// 全画面表示のときにサイドバーとして欲しい幅
const PANE_COLUMNS = 32
// 推移グラフに残すターン数
const HISTORY = 40
// 作業ログのうち、このセッションで覚えておく数と、畳んでいるときに見せる数
const LOG_KEPT = 50
const LOG_SHOWN = 5
// 作業ログと日報の下書きを書かせるモデル
const LOG_MODEL = 'haiku'
// ツールを呼ばず、応答もこれより短いターン（お礼や相づち）は作業ログに書かない
const LOG_MIN_ANSWER = 80
// 日報用に作業ログを残す日数
const LOG_DAYS_KEPT = 14
const DAY_MS = 86_400_000
// 起動直後は内訳がまだそろっていないことがあるので、少し待ってから取り直す
const LATE_REFRESH_MS = [3_000, 10_000]

const usage = atom({ plugin: 'token-weather', key: 'usage' } as const, null)
const history = atom({ plugin: 'token-weather', key: 'history' } as const, [])
const limits = atom({ plugin: 'token-weather', key: 'limits' } as const, [])
const autoCompactAt = atom({ plugin: 'token-weather', key: 'autoCompactAt' } as const, null)
const log = atom({ plugin: 'token-weather', key: 'log' } as const, [])
const breakdown = atom({ plugin: 'token-weather', key: 'breakdown' } as const, null)
const open = atom({ plugin: 'token-weather', key: 'open' } as const, { weather: false, limits: false, log: false })
const startedAt = atom({ plugin: 'token-weather', key: 'startedAt' } as const, null)
const minute = atom({ plugin: 'token-weather', key: 'minute' } as const, 0)
const turns = atom({ plugin: 'token-weather', key: 'turns' } as const, [])
const hop = atom({ plugin: 'token-weather', key: 'hop' } as const, null)

// 経過時間を描き直す間隔
const MINUTE_MS = 60_000
// Turns の段を跳ねる丸を 1 コマ進める間隔と、棒を積む段数（その上に跳ぶための 1 行を空ける）
const HOP_MS = 120
const STEP_ROWS = 2
// 蓄積した値（推移・ターン時間）は $.store にも写し、再読み込みや --resume のあとに戻す。残すセッション数
const SERIES_KEPT = 20

type Series = { savedAt: number; history: number[]; turns: number[] }

const seriesKey = (sessionId: string) => `series:${sessionId}`
// 日報用の作業ログの控え。日付とセッションごとに分けるので、同時に動く別のセッションと書き込みがぶつからない
const logKey = (day: string, sessionId: string) => `log:${day}:${sessionId}`
// ターンが終わってから作業ログに書き終えるまでの控え。そのあいだに読み込み直されても（タイマーは消える）、起動時に書き直せるよう残す
const pendingKey = (sessionId: string) => `pending:${sessionId}`

// 控えを書き出している最中なら、重ねて書き出さない。書き出しは控えを読み直しながら進むので、あとから足された分も拾う
let flushing = false

function isNumbers(x: unknown): x is number[] {
  return Array.isArray(x) && x.every(n => typeof n === 'number')
}

// 変わった系列だけ上書きして保存する
async function saveSeries($: EngineInterface, changed: Partial<Omit<Series, 'savedAt'>>): Promise<void> {
  try {
    const key = seriesKey(await $.session.id())
    const prev = ((await $.store.get(key)) ?? {}) as Partial<Series>
    await $.store.set(key, { history: prev.history ?? [], turns: prev.turns ?? [], ...changed, savedAt: await $.clock.now() })
  } catch {
    // 保存できなくても表示は続ける
  }
}

// 状態が空なら保存してあった系列を戻す。古いセッションの分は消す
async function restoreSeries($: EngineInterface): Promise<void> {
  try {
    const key = seriesKey(await $.session.id())
    const saved = ((await $.store.get(key)) ?? {}) as Partial<Series>
    if (isNumbers(saved.history)) {
      const h = saved.history
      await update($, history, prev => (prev.length > 0 ? prev : h))
    }

    if (isNumbers(saved.turns)) {
      const t = saved.turns
      await update($, turns, prev => (prev.length > 0 ? prev : t))
    }

    const keys = (await $.store.keys()).filter(k => k.startsWith('series:') && k !== key)
    for (const old of keys.slice(0, Math.max(keys.length + 1 - SERIES_KEPT, 0))) {
      await $.store.delete(old)
    }
  } catch {
    // 戻せなくても、ここから貯め直せばよい
  }
}

// 状態が空なら、このセッションの作業ログを日報用の控えから戻す。残す日数を過ぎた控えは消す
async function restoreLog($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    const cutoff = dayKey((await $.clock.now()) - LOG_DAYS_KEPT * DAY_MS)
    const mine: LogEntry[] = []
    for (const key of await $.store.keys()) {
      // 書き終わらないまま閉じた、ほかのセッションの控え。残す日数を過ぎたら消す
      if (key.startsWith('pending:') && key !== pendingKey(id)) {
        const pending = await $.store.get(key)
        if (!isTurns(pending) || pending.every(t => dayKey(t.at) < cutoff)) {
          await $.store.delete(key)
        }

        continue
      }

      if (!key.startsWith('log:')) {
        continue
      }

      // log:2026-10-27:<セッション> の日付の部分
      if (key.slice(4, 14) < cutoff) {
        await $.store.delete(key)
      } else if (key.endsWith(`:${id}`)) {
        const saved = await $.store.get(key)
        if (isLog(saved)) {
          mine.push(...saved)
        }
      }
    }

    if (mine.length > 0) {
      const restored = mine.sort((a, b) => a.at - b.at).slice(-LOG_KEPT)
      await update($, log, prev => (prev.length > 0 ? prev : restored))
    }
  } catch {
    // 戻せなくても、ここから書き足せばよい
  }
}

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

// 内訳から、自動圧縮のしきい値と、カテゴリごとの行を取り出す
async function absorb($: EngineInterface, b: SessionContextBreakdown): Promise<void> {
  await update($, autoCompactAt, () => (b.isAutoCompactEnabled && b.autoCompactThreshold ? b.autoCompactThreshold : null))
  await update($, breakdown, () => ({
    categories: b.categories.flatMap(c => (c.kind === 'deferred' ? [] : [{ name: c.name, tokens: c.tokens, kind: c.kind }])),
    window: b.rawMaxTokens,
  }))
}

// 使用量と枠を測り直す。内訳は手元での見積もりなので API 呼び出しは発生しない
async function refresh($: EngineInterface, withBreakdown: boolean): Promise<void> {
  const measured = await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined)
  await update($, usage, () => snapshot(measured.context))
  // 枠の読みがない応答（再読み込み直後など）で、持っている枠を消さない
  await update($, limits, prev => (measured.rateLimits.length > 0 ? toLimits(measured.rateLimits) : prev))
  await update($, startedAt, () => measured.startedAt)

  const b = measured.context.breakdown
  if (b) {
    await absorb($, b)
  }
}

// 1 ターンぶんの作業を Haiku に 1 行にまとめさせ、ペインと日報用の控えに足す。書けなかったときは理由をデバッグログに残すだけにする。
// 同じ時刻の行がもう控えにあれば書かない（書き終えてから控えを外す前に読み込み直されたときに、二重にしない）
async function writeLog($: EngineInterface, turn: Turn): Promise<void> {
  const key = logKey(dayKey(turn.at), await $.session.id())
  const saved = await $.store.get(key)
  if (isLog(saved) && saved.some(e => e.at === turn.at)) {
    return
  }

  const result = await $.model.complete({ model: LOG_MODEL, system: LOG_SYSTEM, prompt: logPrompt(turn), maxTokens: 200 })
  if (!result.isAnswered) {
    $.ui.log(`作業ログを書けませんでした（${result.reason}）`, { to: 'debug' })
    return
  }

  const text = cleanEntry(result.text)
  if (text === '') {
    return
  }

  const entry: LogEntry = { at: turn.at, project: projectName(await $.session.root()), text }
  await update($, log, list => (list.some(e => e.at === entry.at) ? list : [...list, entry].slice(-LOG_KEPT)))
  // Haiku を待つあいだに増えた分を消さないよう、読み直してから足す
  const latest = await $.store.get(key)
  await $.store.set(key, [...(isLog(latest) ? latest : []), entry])
}

// 書く予定のターンを控えに足す
async function queueLog($: EngineInterface, turn: Turn): Promise<void> {
  const key = pendingKey(await $.session.id())
  const pending = await $.store.get(key)
  await $.store.set(key, [...(isTurns(pending) ? pending : []), turn])
}

// 控えのターンを古い順に作業ログに書き、書いたら控えから外す。書けなかったもの（Haiku が答えないなど）も外し、何度も呼ばない
async function flushLog($: EngineInterface): Promise<void> {
  if (flushing) {
    return
  }

  flushing = true
  try {
    const key = pendingKey(await $.session.id())
    for (;;) {
      const pending = await $.store.get(key)
      const turn = isTurns(pending) ? pending[0] : undefined
      if (turn === undefined) {
        break
      }

      try {
        await writeLog($, turn)
      } catch (error) {
        $.ui.log(`作業ログを書けませんでした（${String(error)}）`, { to: 'debug' })
      }

      const latest = await $.store.get(key)
      const rest = (isTurns(latest) ? latest : []).filter(t => t.at !== turn.at)
      await (rest.length > 0 ? $.store.set(key, rest) : $.store.delete(key))
    }
  } catch (error) {
    $.ui.log(`作業ログを書けませんでした（${String(error)}）`, { to: 'debug' })
  } finally {
    flushing = false
  }
}

// 今日の作業ログ（この PC で動いたすべてのセッションの分）から、Haiku に日報の下書きを書かせる
async function recap($: EngineInterface): Promise<string> {
  const today = dayKey(await $.clock.now())
  const entries: LogEntry[] = []
  for (const key of await $.store.keys()) {
    if (key.startsWith(`log:${today}:`)) {
      const saved = await $.store.get(key)
      if (isLog(saved)) {
        entries.push(...saved)
      }
    }
  }

  if (entries.length === 0) {
    return 'No work logged today yet.'
  }

  entries.sort((a, b) => a.at - b.at)
  const result = await $.model.complete({ model: LOG_MODEL, system: RECAP_SYSTEM, prompt: recapPrompt(entries), maxTokens: 1024 })
  const body = result.isAnswered && result.text.trim() !== '' ? result.text.trim() : plainRecap(entries)
  return `## ${today}\n\n${body}`
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
  // Turns の段を跳ねる丸のタイマー。メインのターンのあいだだけ動かす
  let hopping: Timer | undefined
  // 作業ログの材料。メインのターンが始まるたびに取り直す
  let prompt = ''
  let called: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Open or close Token Weather (context usage as weather) on the right', immediate: true })
    // 名前がほかのコマンドとぶつかって断られても、天気と作業ログは動かす
    await $.command.register({ name: RECAP, description: "Draft today's daily report from the Token Weather work log" }).catch(error => {
      $.ui.log(`/${RECAP} を登録できませんでした（${String(error)}）`, { to: 'debug' })
    })
    await restoreSeries($)
    await restoreLog($)
    // 前の読み込みで書き終わらなかったターンが控えにあれば、ここで書く
    $.clock.after(0, () => void flushLog($))
    // ターンの途中で再読み込みされるとタイマーは消えるので、宙に浮いたまま止めずに消す
    await update($, hop, () => null)
    await refresh($, true)
    for (const ms of LATE_REFRESH_MS) {
      $.clock.after(ms, () => void refresh($, true).catch(() => undefined))
    }

    // 「起動してから何分」を 1 分ごとに描き直す。リロードで古いタイマーは消え、ここで張り直される
    $.clock.every(MINUTE_MS, () => void update($, minute, n => n + 1).catch(() => undefined))

    // 頼まれずに開くペインは、端末が 144 列以上のときだけ横に並ぶ。狭いときは /weather で開く
    void $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS })

    return next(e)
  })

  // プロンプトが送られた時点でも取り直す。最初の応答を待たずに天気を出すため
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      prompt = e.text
      called = []
    }

    // 作業中は、丸が Turns の段を左から跳んでいく。止めたあとに遅れて来たコマでは動かさない
    if (!hopping) {
      await update($, hop, () => 0)
      hopping = $.clock.every(HOP_MS, () => void update($, hop, n => (n === null ? null : n + 1)).catch(() => undefined))
    }

    await refresh($, true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => ({ text: await toggle($) }))

  on('command.run', { command: RECAP }, async $ => ({ text: await recap($) }))

  // 応答のたびに Claude Code が使用量を知らせてくる
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      const measured = snapshot(e.context)
      await update($, usage, () => measured)
      if (measured) {
        const h = await update($, history, list => [...list, measured.percent].slice(-HISTORY))
        await saveSeries($, { history: h })
      }

      const detailed = await $.session.usage({ breakdown: 'summary' })
      await update($, startedAt, () => detailed.startedAt)
      const b = detailed.context.breakdown
      if (b) {
        await absorb($, b)
      }
    }

    // 枠は変化があったときに取り込む。状態が空（再読み込みで消えたあと）なら変化がなくても取り込む
    await update($, limits, prev => (e.changed.includes('rateLimits') || prev.length === 0 ? toLimits(e.rateLimits) : prev))

    return next(e)
  })

  // ターンが終わるたびに、かかった時間を控え、作業ログを書かせる（サブエージェントのターンは除く）。丸は止めて消す
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      hopping?.cancel()
      hopping = undefined
      await update($, hop, () => null)
      const t = await update($, turns, list => [...list, e.durationMs].slice(-HISTORY))
      await saveSeries($, { turns: t })

      // ターンの終わりを待たせないよう、作業ログは控えに足してから、タイマーに回して書かせる
      const isWork = called.length > 0 || e.answer.trim().length >= LOG_MIN_ANSWER
      if (e.reason === 'answer' && isWork) {
        await queueLog($, { at: await $.clock.now(), prompt, tools: [...called], answer: e.answer })
        $.clock.after(0, () => void flushLog($))
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 長い作業の途中でも天気が変わるように、ツールを呼ぶたびにも測り直す。メインのループが呼んだツールは作業ログの材料に控える
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      called.push(String(e.tool))
      await refresh($, false)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // 日報用の控えは残し、このセッションの表示だけ空にする
    if (e.reason === 'clear') {
      await $.store.delete(seriesKey(e.sessionId)).catch(() => undefined)
      await update($, usage, () => null)
      await update($, history, () => [])
      await update($, autoCompactAt, () => null)
      await update($, log, () => [])
      await update($, breakdown, () => null)
      await update($, startedAt, () => null)
      await update($, turns, () => [])
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const trend = await read($, history)
    const windows = await read($, limits)
    const compactAt = await read($, autoCompactAt)
    const entries = await read($, log)
    const parts = await read($, breakdown)
    const opened = await read($, open)
    const started = await read($, startedAt)
    const laps = await read($, turns)
    const frame = await read($, hop)
    // 値は使わないが、1 分ごとの書き込みで描き直されるように読んでおく
    await read($, minute)
    const now = await $.clock.now()

    // 枠線 2 と左右の余白 2 を引いた、カードの中の幅
    const inner = Math.max(12, e.props.bodyColumns - 4)
    // 枠の名前（7 列）と使用率（5 列）、空白 1 列のあとに残る幅をバーにする
    const limitBar = Math.max(inner - 13, 4)
    // 内訳の行: カテゴリ名、空白 1 列、トークン数 5 列、空白 1 列、割合 4 列
    const categoryName = Math.max(inner - 11, 6)

    // カードの見出しを押すと、そのカードの詳細を開け閉めする。描画中は書けないので押されたときに書く
    const toggle = (card: Card) => () => void update($, open, o => ({ ...o, [card]: !o[card] }))
    const mark = (card: Card) => (opened[card] ? '▾' : '▸')

    const weather = u ? weatherFor(u.percent) : undefined
    const untilCompact = u && compactAt ? Math.max(compactAt - u.tokens, 0) : undefined
    // 作業ログは新しいものを上に。開いていれば全部を時刻つきで折り返し、畳んでいれば上から数件を 1 行ずつ
    const shownLog = [...entries].reverse().slice(0, opened.log ? entries.length : LOG_SHOWN)
    const hiddenLog = entries.length - shownLog.length
    // ターンの所要時間: 直近と平均、推移は最長を 100% として段に積み、その上を丸が跳ねる
    const lastLap = laps.at(-1)
    const avgLap = laps.length > 0 ? laps.reduce((a, b) => a + b, 0) / laps.length : 0
    const longest = Math.max(...laps, 1)
    const heights = stepHeights(laps.slice(-(inner - 6)).map(ms => (ms / longest) * 100), STEP_ROWS)
    const chart = steps(heights, STEP_ROWS + 1)
    // 作業していないときは丸を出さない
    const hopper = frame === null ? undefined : hopAt(heights, frame)

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
          {started !== null && <Text dimColor>⏱ {formatLeft(now - started)} since start</Text>}
          {lastLap !== undefined && (
            <Text dimColor wrap="truncate-end">
              Last turn {formatSeconds(lastLap)} · avg {formatSeconds(avgLap)}
            </Text>
          )}
          {/* 上の行から描く。いちばん下の行に見出しを付け、丸のいる行はその列で区切って丸だけ薄くしない */}
          {laps.length > 0 && (
            <Box flexDirection="column">
              {chart.map((row, i) => {
                const label = i === STEP_ROWS ? 'Turns ' : '      '
                const at = hopper?.level === STEP_ROWS - i ? hopper.column : -1
                return at < 0 ? (
                  <Text dimColor wrap="truncate-end">
                    {label}
                    {row}
                  </Text>
                ) : (
                  <Text wrap="truncate-end">
                    <Text dimColor>
                      {label}
                      {row.slice(0, at)}
                    </Text>
                    {HOPPER}
                    <Text dimColor>{row.slice(at + 1)}</Text>
                  </Text>
                )
              })}
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
          <Button key="log" plain onPress={toggle('log')}>
            <Text bold>📝 Work log</Text> <Text dimColor>{mark('log')}</Text>
          </Button>
          {shownLog.length === 0 ? (
            <Text dimColor>No turn logged yet</Text>
          ) : opened.log ? (
            shownLog.map(entry => (
              <Text>
                <Text dimColor>{formatClock(entry.at)}</Text> {entry.text}
              </Text>
            ))
          ) : (
            shownLog.map(entry => <Text wrap="truncate-end">{entry.text}</Text>)
          )}
          {hiddenLog > 0 && <Text dimColor>+{hiddenLog} more</Text>}
          {/* 開くと、日報の下書きの作り方 */}
          {opened.log && <Text dimColor>/{RECAP} drafts today's report</Text>}
        </Box>
      </Box>
    )
  })
}
