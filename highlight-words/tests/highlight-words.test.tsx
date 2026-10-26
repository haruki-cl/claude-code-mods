import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { markPhrases, parseInline, segment } from '../hooks/marks.ts'
import { parsePicks } from '../hooks/picks.ts'

const PINK = '#ff79c6'
const ORANGE = '#ffb86c'
const viewport = { columns: 100, rows: 30 }
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const ANSWER = [
  '結論です。この変更を入れると、次に起動したときに既存のキャッシュは無効になり、作り直しに数分かかります。',
  '',
  '本番の DB 名は `prod_main` と推測して書きました。合っていますか？',
].join('\n')

// エンジン自身の描画の代わり。受け取った本文をそのまま Markdown で描く
const engineDraws = (on: On) =>
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Markdown } = $.ui.resolve(e)
    return <Markdown text={e.props.text} />
  })

// 端末に描かれるセッションで、Haiku が reply と答える。呼ばれた回数と、ステータスラインに出た文を返す
function haikuAnswers(on: On, reply: string): { calls: number; status: Array<string | undefined> } {
  const seen = { calls: 0, status: [] as Array<string | undefined> }
  on('turn.complete', () => ({ text: '' }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('ui.status', ($, e) => {
    seen.status.push(e.text)
    return { value: undefined }
  })
  on('model.complete', () => {
    seen.calls += 1
    return { value: { isAnswered: true as const, text: reply, usage } }
  })
  return seen
}

const complete = ($: Engine, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId === undefined ? {} : { agentId }) })

const mountMessage = ($: Engine, text: string, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'highlight-words', surface, component: 'AssistantMessage', props: { text, isFirstOfReply: true }, viewport })

test('印は太字・コード・リンクと入れ子にでき、閉じていない印は素の文字のまま', () => {
  expect(parseInline('この変更で ⟦!`cache` は無効⟧ になる。⟦?本番の DB 名⟧ は合っている？')).toEqual([
    { kind: 'text', text: 'この変更で ' },
    { kind: 'mark', mark: 'important', spans: [{ kind: 'code', text: 'cache' }, { kind: 'text', text: ' は無効' }] },
    { kind: 'text', text: ' になる。' },
    { kind: 'mark', mark: 'confirm', spans: [{ kind: 'text', text: '本番の DB 名' }] },
    { kind: 'text', text: ' は合っている？' },
  ])
  expect(parseInline('**⟦!要点⟧** と [docs](https://example.com)')).toEqual([
    { kind: 'bold', spans: [{ kind: 'mark', mark: 'important', spans: [{ kind: 'text', text: '要点' }] }] },
    { kind: 'text', text: ' と ' },
    { kind: 'link', label: 'docs', href: 'https://example.com' },
  ])
  expect(parseInline('書きかけの ⟦!重')).toEqual([{ kind: 'text', text: '書きかけの ⟦!重' }])
})

test('印のある段落だけを自前で描き、コードブロックの中の印には触らず、表の印は太字にする', () => {
  const text = [
    '前置きの段落。',
    '',
    '- 一つ目は ⟦!重要⟧',
    '- 二つ目',
    '',
    '```',
    'echo "⟦!そのまま⟧"',
    '```',
    '',
    '| 列 |',
    '| -- |',
    '| ⟦?表の中⟧ |',
  ].join('\n')

  const segments = segment(text)
  expect(segments.map(s => s.kind)).toEqual(['plain', 'marked', 'plain'])
  expect(segments[0]).toEqual({ kind: 'plain', text: '前置きの段落。' })
  expect(segments[1]).toMatchObject({ kind: 'marked', lines: [{ lead: '- ' }, { lead: '- ' }] })
  expect(segments[2]).toEqual({ kind: 'plain', text: '```\necho "⟦!そのまま⟧"\n```\n\n| 列 |\n| -- |\n| **表の中** |' })
  expect(segment('説明\n\n```sh\necho ⟦!途中⟧')).toEqual([{ kind: 'plain', text: '説明\n\n```sh\necho ⟦!途中⟧' }])
})

test('選んだ語句はコードとリンクを避けて最初の 1 か所だけ囲み、長い語句を先に当てる', () => {
  const text = '`キャッシュ` を消すと [キャッシュ](https://example.com/キャッシュ) も既存のキャッシュも消える。キャッシュは戻らない。\n\n```\nキャッシュ\n```'
  expect(markPhrases(text, { important: ['キャッシュ', '既存のキャッシュ'], confirm: [] })).toBe(
    '`キャッシュ` を消すと [キャッシュ](https://example.com/キャッシュ) も⟦!既存のキャッシュ⟧も消える。⟦!キャッシュ⟧は戻らない。\n\n```\nキャッシュ\n```',
  )
  expect(markPhrases('DB 名を確認', { important: [], confirm: ['DB 名', '未登場'] })).toBe('⟦?DB 名⟧を確認')
})

test('Haiku の返事からは本文にある短い語句だけを取り、両方に入った語句は重要にする', () => {
  const reply = '選びました。\n{"important": ["既存のキャッシュは無効", "本文にない語句", "**太字**", 3], "confirm": ["既存のキャッシュは無効", "本番の DB 名"]}'
  expect(parsePicks(reply, ANSWER)).toEqual({ important: ['既存のキャッシュは無効'], confirm: ['本番の DB 名'] })
  expect(parsePicks(reply, ANSWER.split('\n')[0] ?? '')).toEqual({ important: ['既存のキャッシュは無効'], confirm: [] })
  expect(parsePicks('JSON ではない', ANSWER)).toEqual({ important: [], confirm: [] })
})

test('ターンが終わると Haiku に語句を選ばせ、その応答の語句をピンクとオレンジで描き直す', async ($, on) => {
  const clock = mock.clock(on)
  engineDraws(on)
  const haiku = haikuAnswers(on, '{"important": ["既存のキャッシュは無効"], "confirm": ["本番の DB 名"]}')

  // 応答は語句が選ばれる前に一度描かれ、選ばれたあとで描き直される
  const shown = await mountMessage($, ANSWER)
  expect(await shown.find({ type: 'Markdown', text: ANSWER })).toBeDefined()

  await complete($, ANSWER)
  await clock.advance(10)
  expect(haiku.calls).toBe(1)
  // 普段は何も出さない
  expect(haiku.status).toEqual([])
  expect((await shown.find({ type: 'Text', text: /^既存のキャッシュは無効$/ }))?.props.color).toBe(PINK)
  await shown.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountMessage($, ANSWER, surface)
    expect((await ui.find({ type: 'Text', text: /^既存のキャッシュは無効$/ }))?.props.color).toBe(PINK)
    expect((await ui.find({ type: 'Text', text: /^本番の DB 名$/ }))?.props.color).toBe(ORANGE)
    expect(await ui.find({ type: 'Text', text: '●' })).toBeDefined()
    await ui.unmount()
  }

  // 選んでいない応答はエンジンにそのまま任せる
  const other = await mountMessage($, '別の応答。')
  expect(await other.find({ type: 'Markdown', text: '別の応答。' })).toBeDefined()
})

test('ループの 1 回が終わるたびにその本文から選ばせ、ターンの終わりに同じ本文が来ても呼び直さない', async ($, on) => {
  const clock = mock.clock(on)
  engineDraws(on)
  const haiku = haikuAnswers(on, '{"important": ["既存のキャッシュは無効"], "confirm": []}')
  // モデルの代わり。本文を流してからツールを呼ぶところで止まる
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text' as const, index: 0, text: ANSWER }
    return { turnId: e.turnId, index: e.index, answer: ANSWER, toolUses: [], stopReason: 'tool_use' as const, usage: null }
  })

  const shown = await mountMessage($, ANSWER)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  for await (const _chunk of stream) {
    // 流し切るだけ
  }

  await clock.advance(10)
  expect(haiku.calls).toBe(1)
  expect((await shown.find({ type: 'Text', text: /^既存のキャッシュは無効$/ }))?.props.color).toBe(PINK)

  await complete($, ANSWER)
  await clock.advance(10)
  expect(haiku.calls).toBe(1)
})

test('Haiku が語句を選ばなかったときは、エンジンにそのまま描かせる', async ($, on) => {
  const clock = mock.clock(on)
  engineDraws(on)
  const haiku = haikuAnswers(on, '{"important": [], "confirm": []}')

  await complete($, ANSWER)
  await clock.advance(10)
  expect(haiku.calls).toBe(1)
  expect(haiku.status).toEqual([])
  const ui = await mountMessage($, ANSWER)
  expect(await ui.find({ type: 'Markdown', text: ANSWER })).toBeDefined()
})

test('短い応答とサブエージェントの応答には Haiku を呼ばない', async ($, on) => {
  const clock = mock.clock(on)
  const haiku = haikuAnswers(on, '{"important": [], "confirm": []}')

  await complete($, 'はい、できました。')
  await complete($, ANSWER, 'a1')
  await clock.advance(10)
  expect(haiku.calls).toBe(0)
})
