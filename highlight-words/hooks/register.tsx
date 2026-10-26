import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderNode, Register } from 'claude-code'

import type { Picked } from '../types'
import { markPhrases, segment } from './marks.ts'
import type { Line, Mark, Span } from './marks.ts'
import { SYSTEM, parsePicks, promptFor } from './picks.ts'

const picked = atom({ plugin: 'highlight-words', key: 'picked' } as const, [])

// Dracula のピンクとオレンジ
const COLORS: Record<Mark, string> = { important: '#ff79c6', confirm: '#ffb86c' }
// インラインコードはエンジンと同じ色で描く
const CODE_COLOR = 'permission'
// 応答の頭に付く丸。エンジンが描くものに合わせる
const BULLET = '●'

const MODEL = 'haiku'
// これより短い応答（「はい」など）には語句を選ばせない
const MIN_LENGTH = 80
// 語句を覚えておく応答の数。ループの 1 回ごとに 1 つ増える
const KEPT = 50

// 描く本文に当たる応答を探す。描く本文は応答の一部のこともあるので、含まれていれば当たりとする
function pickedFor(list: Picked[], text: string): Picked | undefined {
  const body = text.trim()
  return list.findLast(p => p.text.trim() === body) ?? (body.length >= MIN_LENGTH ? list.findLast(p => p.text.includes(body)) : undefined)
}

// 応答から Haiku に語句を選ばせて覚える。選べなかったときは色を付けないだけにし、理由はデバッグログ（claude --debug）に残す
async function pick($: EngineInterface, text: string): Promise<void> {
  try {
    if ((await $.session.surfaces()).length === 0) {
      return
    }

    const result = await $.model.complete({ model: MODEL, system: SYSTEM, prompt: promptFor(text), maxTokens: 512 })
    if (!result.isAnswered) {
      $.ui.log(`語句を選べませんでした（${result.reason}）`, { to: 'debug' })
      return
    }

    const picks = parsePicks(result.text, text)
    if (picks.important.length + picks.confirm.length > 0) {
      await update($, picked, prev => [...prev.filter(p => p.text !== text), { text, picks }].slice(-KEPT))
    }
  } catch (error) {
    $.ui.log(`語句を選べませんでした（${String(error)}）`, { to: 'debug' })
  }
}

// 選ばせた本文。ループの 1 回の終わりとターンの終わりの両方で同じ本文が来るので、Haiku は 1 回だけ呼ぶ
const asked = new Set<string>()

// 次のループやターンの終わりを待たせないよう、語句選びはタイマーに回す
function ask($: EngineInterface, text: string): void {
  if (text.trim().length < MIN_LENGTH || asked.has(text)) {
    return
  }

  asked.add(text)
  $.clock.after(0, () => void pick($, text))
}

export const register: Register = on => {
  // ループの 1 回（モデルへのリクエスト 1 回）が終わるたびに、その本文から選ばせる
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      ask($, result.answer)
    }

    return result
  })

  // turn.step が届かなかったときのために、ターンの最後の本文からも選ばせる
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined && e.reason === 'answer') {
      ask($, e.answer)
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // 語句が選ばれたら描き直されるよう、要約でない応答はすべて覚えた語句を読む
    if (e.props.isSummary) {
      return next(e)
    }

    const entry = pickedFor(await read($, picked), e.props.text)
    // 本文がもともと印の記号を含むときは、取り違えないよう色を付けない
    if (entry === undefined || e.props.text.includes('⟦')) {
      return next(e)
    }

    const { Box, Link, Markdown, Text } = $.ui.resolve(e)

    // color は印の中にいるときの色。印の中のインラインコードも印の色で描く
    const draw = (spans: Span[], color?: string): RenderNode[] =>
      spans.map(span => {
        switch (span.kind) {
          case 'text':
            return span.text
          case 'code':
            return <Text color={color ?? CODE_COLOR}>{span.text}</Text>
          case 'bold':
            return <Text weight="bold">{draw(span.spans, color)}</Text>
          case 'italic':
            return <Text italic>{draw(span.spans, color)}</Text>
          case 'link':
            return <Link href={span.href} label={span.label} />
          case 'mark':
            return (
              <Text color={COLORS[span.mark]} weight="bold">
                {draw(span.spans, COLORS[span.mark])}
              </Text>
            )
        }
      })

    // 箇条書きは折り返した行が記号の後ろにそろうよう、記号と本文を横に並べる
    const drawLine = (line: Line, key: string) => {
      const body = line.isHeading ? <Text weight="bold">{draw(line.spans)}</Text> : <Text>{draw(line.spans)}</Text>
      if (line.lead === '') {
        return <Box key={key}>{body}</Box>
      }

      return (
        <Box key={key} flexDirection="row">
          <Text>{line.lead}</Text>
          <Box flexGrow={1} flexShrink={1}>
            {body}
          </Box>
        </Box>
      )
    }

    const body = segment(markPhrases(e.props.text, entry.picks)).map((s, i) => (
      <Box key={`s${i}`} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
        {s.kind === 'plain' ? <Markdown text={s.text} /> : s.lines.map((line, j) => drawLine(line, `s${i}l${j}`))}
      </Box>
    ))

    return (
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text>{e.props.isFirstOfReply ? BULLET : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          {body}
        </Box>
      </Box>
    )
  })
}
