// auto-memory（~/.claude/projects/<プロジェクト>/memory/）と指示ファイルの読み込みを見つける。Claude Code の API には触れない純粋な関数だけを置く

// 1 つめの括弧がパス全体、2 つめがファイル名
const MEMORY_FILE = /([^\s'"]*\/\.claude\/projects\/[^/\s'"]+\/memory\/([^/\s'"]+\.md))\b/
const MEMORY_FILES = new RegExp(MEMORY_FILE.source, 'g')
// エンジンがメモリファイルの Read 結果の先頭に付ける注意書き
const AGE = /This memory is (\d+) days? old/
// エンジンが注入する文章の、ファイルごとの見出し
const CONTENTS_OF = /^Contents of (\S+?) \(([^)]*)\):/gm
// 索引そのもの。読んだファイルの一覧には出さず、Index の行で示す
const INDEX = 'MEMORY.md'

/** auto-memory の個別ファイルのパスなら、そのファイル名を返す */
export function memoryFileName(path: string): string | undefined {
  const name = MEMORY_FILE.exec(path)?.[2]
  return name && name !== INDEX ? name : undefined
}

/** auto-memory の索引（MEMORY.md）のパスなら true */
export function isMemoryIndex(path: string): boolean {
  return MEMORY_FILE.exec(path)?.[2] === INDEX
}

/** 文章の中に現れる auto-memory の個別ファイルのパスを、重複なく返す */
export function memoryPathsIn(text: string): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(MEMORY_FILES)) {
    if (m[2] !== INDEX && m[1]) {
      found.add(m[1])
    }
  }

  return [...found]
}

/** 注入された文章の見出し「Contents of <path> (<説明>):」を、パスと説明の組で返す */
export function loadedFilesIn(text: string): { path: string; label: string }[] {
  return [...text.matchAll(CONTENTS_OF)].flatMap(m => (m[1] ? [{ path: m[1], label: m[2] ?? '' }] : []))
}

/** Read の結果から「N days old」の N を取り出す */
export function ageDaysIn(text: string | undefined): number | undefined {
  const m = text ? AGE.exec(text) : null
  return m ? Number(m[1]) : undefined
}

// 索引の 1 行。1 つめの括弧が Title、2 つめが file
const ENTRY = /^\s*- \[([^\]]+)\]\(([^)]+)\)/

/** MEMORY.md に並ぶ項目（- [Title](file.md) — hook）を、並んだ順に返す */
export function parseEntries(index: string): { title: string; file: string }[] {
  return index.split('\n').flatMap(line => {
    const m = ENTRY.exec(line)
    return m?.[1] && m[2] ? [{ title: m[1], file: m[2] }] : []
  })
}

/** MEMORY.md に並ぶ項目を数える */
export function countEntries(index: string): number {
  return parseEntries(index).length
}

/** 「flow-html-structure.md」を「flow-html-structure」にする */
export function stem(name: string): string {
  return name.replace(/\.md$/, '')
}

/** プロジェクト配下なら相対パス、ホーム配下なら ~/ 始まりにする */
export function shorten(path: string, root: string | undefined, home: string | undefined): string {
  if (root && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1)
  }

  if (home && path.startsWith(`${home}/`)) {
    return `~/${path.slice(home.length + 1)}`
  }

  return path
}

/** 日数を「48d」にする。不明なら空 */
export function formatAge(days: number | undefined): string {
  return days === undefined ? '' : `${days}d`
}
