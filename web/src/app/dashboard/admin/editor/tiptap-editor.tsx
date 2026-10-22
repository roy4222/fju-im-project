'use client'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Editor, Extension, Mark, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import sanitizeHtml from 'sanitize-html'
import { Placeholder } from '@tiptap/extensions'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'

/** 只用字串拼 class，不 import 頁面共用的樣式模組（理由同下面「打包體積」）。 */
const cx = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(' ')

/**
 * 系辦正文的所見即所得編輯器（AD-B5，設計方案 §8.2）。只由 `rich-editor.tsx` 動態載入（不進 First Load JS）。
 *
 * 擴充**剛好對到** `application/items/rich-text.ts` 的白名單，原始 HTML 切過來才不會靜默丟內容：
 * 段落、h2～h4、粗斜體、底線、刪除線、清單、引言、程式碼、分隔線、換行、連結（只收 http／https／mailto，
 * 保留 title）、表格（只為保留既有內容，工具列不給新增表格）。白名單沒有 `img`，所以不提供正文插圖。
 * 伺服器存檔前仍會再清一次，這裡不是信任點。
 *
 * 打包體積：直接用 `@tiptap/core`、不用 `@tiptap/react` 與圖示套件。那兩個跟其他頁共用
 * `use-sync-external-store`／圖示底層模組，動態載入的這一塊一用到，打包器就會把其他頁（例如帳號管理）的
 * 大塊 JS 拆開重排，First Load 多出約 2 KB、超過預算。這裡只靠 React 內建的 `useSyncExternalStore` 重畫工具列。
 */

/** 工具列新插的連結只收這三種。 */
const SAFE_HREF = /^(https?:|mailto:)/i
/**
 * 既有正文裡的連結：跟伺服器白名單一樣，三種協定或站內相對路徑（`/rules`、`#x`）都留；
 * 其他協定（`javascript:` 等）與 `//` 開頭不收。不能比伺服器嚴，不然切換模式會把既有連結丟掉。
 */
function keepHref(url: string): boolean {
  // 瀏覽器解析網址會略過空白與控制字元（`java\tscript:`），先拿掉再判斷。
  const u = [...url].filter((c) => c.charCodeAt(0) > 0x20).join('')
  return SAFE_HREF.test(u) || (!/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith('//'))
}

/** 沒有任何標籤的純文字照伺服器的規則轉段落（空一行＝新段落、單一換行＝`<br>`），不然換行會被合併掉。 */
const HAS_TAG = /<\/?[a-z][^>]*>/i
function toEditorHtml(body: string): string {
  if (body.trim() === '' || HAS_TAG.test(body)) return body
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  return body
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${block.split('\n').map(escape).join('<br>')}</p>`)
    .join('')
}

function fromEditor(editor: Editor): string {
  return editor.isEmpty ? '' : editor.getHTML()
}

/**
 * 行內程式碼：StarterKit 內建的 Code 會排除其他所有格式（`excludes: '_'`），舊正文裡
 * `<a href="/rules"><code>規則</code></a>`、`<strong><code>x</code></strong>` 一進編輯器連結與粗體就沒了。
 * 這裡改成可以跟粗斜體、底線、刪除線、連結並存。
 */
const InlineCode = Mark.create({
  name: 'code',
  excludes: '',
  code: true,
  parseHTML: () => [{ tag: 'code' }],
  renderHTML: ({ HTMLAttributes }) => ['code', HTMLAttributes, 0],
})

/**
 * 程式碼區塊：StarterKit 內建的 CodeBlock 不允許任何格式（`marks: ''`），`<pre>` 裡的粗體、連結會被丟掉。
 * 這裡允許白名單裡除了行內程式碼以外的格式（`<pre><code>` 的 code 本來就是區塊本身）。
 */
const CodeBlock = Node.create({
  name: 'codeBlock',
  group: 'block',
  content: 'text*',
  marks: 'bold italic underline strike link',
  code: true,
  defining: true,
  parseHTML: () => [{ tag: 'pre', preserveWhitespace: 'full' }],
  renderHTML: ({ HTMLAttributes }) => ['pre', HTMLAttributes, ['code', 0]],
})

/**
 * ProseMirror 會把相鄰且屬性相同的 marks 合併（例如 strong＋b）；保留來源元素邊界，
 * 才能在允許 b→strong／包覆順序調整的同時，仍嚴格核對元素數量。識別只存在記憶體，不寫入 HTML。
 */
function sourceBoundaries() {
  let serial = 0
  return Extension.create({
    name: 'sourceBoundaries',
    addGlobalAttributes: () => [{
      types: ['bold', 'italic', 'underline', 'strike', 'code', 'link'],
      attributes: {
        sourceBoundary: { default: null, rendered: false, parseHTML: () => ++serial },
      },
    }],
  })
}

const EXTENSIONS = (placeholder: string) => [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    code: false,
    codeBlock: false,
    // 表格、分隔線後面不自動補空段落：切換模式不該多出內容。
    trailingNode: false,
    link: {
      openOnClick: false,
      // 自動連結開著時，連結尾端繼續打的字會併進連結（Link 的 inclusive 跟著 autolink）；要連結用工具列。
      autolink: false,
      defaultProtocol: 'https',
      isAllowedUri: keepHref,
    },
  }),
  InlineCode,
  CodeBlock,
  sourceBoundaries(),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Placeholder.configure({ placeholder }),
]

/**
 * 與 application/items/rich-text.ts 相同的清理契約。app 對 application 只能 import type，
 * 所以這裡直接用同一 sanitize-html 套件；e2e 的逐元素／屬性表再對照真正的伺服器存檔結果。
 * 不以瀏覽器 DOMParser 模擬 sanitizer：template/title 的文字及游離 tr/td 都可能先被 DOMParser 吃掉。
 * 伺服器存檔／輸出仍是信任點；此處只決定能否安全交給 Tiptap。
 */
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote', 'a', 'hr', 'code', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
  disallowedTagsMode: 'discard',
  // style 不在白名單；不需要 Node 的 CSS 解析器。
  parseStyleAttributes: false,
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }),
  },
}

type HtmlNode = string | HtmlElement
interface HtmlElement {
  tag: string
  attrs: Record<string, string>
  children: HtmlNode[]
}
const element = (tag: string, children: HtmlNode[] = []): HtmlElement => ({ tag, attrs: {}, children })
const MARKS = new Set(['strong', 'em', 'u', 's', 'code', 'a'])

/** 先清理，再用同一 parser 的 hooks 讀樹；hooks 在清理前觸發，不能直接拿原始 HTML 建樹。 */
function sanitizedTree(html: string): HtmlElement {
  const root = element('root')
  const stack = [root]
  const clean = sanitizeHtml(toEditorHtml(html), SANITIZE_OPTIONS).trim()
  sanitizeHtml(clean, {
    ...SANITIZE_OPTIONS,
    onOpenTag: (tag, attrs) => {
      const child: HtmlElement = { tag, attrs: { ...attrs }, children: [] }
      stack.at(-1)!.children.push(child)
      stack.push(child)
    },
    onCloseTag: () => { stack.pop() },
    textFilter: (text) => {
      // parser 可能把 entity 分成多次 callback，chunk 邊界不是內容邊界。
      const children = stack.at(-1)!.children
      const previous = children.at(-1)
      if (typeof previous === 'string') children[children.length - 1] = previous + text
      else children.push(text)
      return text
    },
  })
  return root
}

/**
 * 只允許明列的正規化：b/i 別名；root/li/td/th/blockquote 的 inline run 補 p；
 * table 補 tbody、開頭的非空 thead→tbody、相鄰非空列組合併；pre 補一層完整 code、br→換行。
 * 不合併段落、BR/HR、空元素或重複 marks，也不折疊文字空白。
 */
function normalize(node: HtmlNode, inPre = false): HtmlNode {
  if (typeof node === 'string') return node.replace(/\r\n?/g, '\n')
  node.tag = ({ b: 'strong', i: 'em' } as Record<string, string>)[node.tag] ?? node.tag
  const pre = inPre || node.tag === 'pre'
  if (pre && node.tag === 'br') return '\n'
  node.children = node.children.map((child) => normalize(child, pre))
  if (node.tag === 'pre' && !(node.children.length === 1 && typeof node.children[0] !== 'string' && node.children[0]?.tag === 'code')) {
    node.children = [element('code', node.children)]
  }
  if (node.tag === 'table') {
    const groups: HtmlNode[] = []
    const hasRows = (group: HtmlElement) =>
      group.children.length > 0 && group.children.every((child) => typeof child !== 'string' && child.tag === 'tr')
    let seenRows = false
    for (const child of node.children) {
      // 晚置 thead 在瀏覽器會顯示到最上方；改成 tbody 會移動可見列順序，不能正規化。
      if (typeof child !== 'string' && hasRows(child) && child.tag === 'thead' && !seenRows) child.tag = 'tbody'
      const last = groups.at(-1)
      if (typeof child !== 'string' && child.tag === 'tr') {
        if (last && typeof last !== 'string' && hasRows(last) && last.tag === 'tbody') last.children.push(child)
        else groups.push(element('tbody', [child]))
      } else if (typeof child !== 'string' && hasRows(child) && child.tag === 'tbody' && last && typeof last !== 'string' && hasRows(last) && last.tag === 'tbody') {
        last.children.push(...child.children)
      } else groups.push(child)
      if (typeof child !== 'string' && (hasRows(child) || child.tag === 'tr')) seenRows = true
    }
    node.children = groups
  }
  if (!pre && ['root', 'li', 'td', 'th', 'blockquote'].includes(node.tag)) {
    const children: HtmlNode[] = []
    let run: HtmlNode[] = []
    const flush = () => {
      if (run.length) children.push(element('p', run))
      run = []
    }
    for (const child of node.children) {
      if (typeof child === 'string' || MARKS.has(child.tag) || child.tag === 'br') run.push(child)
      else { flush(); children.push(child) }
    }
    flush()
    // 空的清單項／儲存格／引言補 p 是 schema 的容器要求；非空容器前多出 p 則必須拒絕。
    node.children = children.length || node.tag === 'root' ? children : [element('p')]
  }
  return node
}

/**
 * 標準形式保留全部區塊邊界、屬性、空元素與元素數量。只有 inline mark 包覆順序可交換；
 * marks 用 JSON 陣列保留重複與屬性邊界，不能用 Set 或 href|title 字串造成碰撞。
 */
function canonical(root: HtmlElement): string {
  const tokens: string[][] = []
  const counts: Record<string, number> = {}
  const walk = (node: HtmlNode, marks: string[]) => {
    const key = JSON.stringify([...marks].sort())
    if (typeof node === 'string') {
      const last = tokens.at(-1)
      if (last?.[0] === 'text' && last[1] === key) last[2] += node
      else tokens.push(['text', key, node])
      return
    }
    const attrs = JSON.stringify(Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b)))
    counts[node.tag] = (counts[node.tag] ?? 0) + 1
    if (MARKS.has(node.tag)) {
      const next = [...marks, JSON.stringify([node.tag, attrs])]
      if (!node.children.length) tokens.push(['empty-mark', JSON.stringify(next.sort())])
      else node.children.forEach((child) => walk(child, next))
    } else {
      tokens.push(['open', node.tag, attrs, key])
      node.children.forEach((child) => walk(child, marks))
      tokens.push(['close', node.tag])
    }
  }
  walk(root, [])
  return JSON.stringify([tokens, Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))])
}

/** 第二道保險獨立走文字；不依賴格式 token 或元素數量。 */
function textOf(node: HtmlNode): string {
  if (typeof node === 'string') return node
  if (node.tag === 'br') return '\n'
  return node.children.map(textOf).join('')
}

function lossReason(source: string, output: string): string | null {
  const before = normalize(sanitizedTree(source)) as HtmlElement
  const after = normalize(sanitizedTree(output)) as HtmlElement
  if (textOf(before) !== textOf(after)) return '切換會改變或遺失正文文字。'
  if (canonical(before) !== canonical(after)) return '切換會改變或遺失正文元素、屬性或排版。'
  return null
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      // 按下去不搶焦點，選取範圍才留得住。
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cx(
        'inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs font-semibold hover:bg-muted',
        active && 'bg-primary-subtle text-primary-on-subtle',
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor, inputClass, buttonClass }: { editor: Editor; inputClass: string; buttonClass: string }) {
  // 每次編輯（含游標移動）editor.state 都換成新物件，工具列跟著重畫。
  useSyncExternalStore(
    (onChange) => {
      editor.on('transaction', onChange)
      return () => {
        editor.off('transaction', onChange)
      }
    },
    () => editor.state,
  )
  const s = {
    paragraph: editor.isActive('paragraph'),
    h2: editor.isActive('heading', { level: 2 }),
    h3: editor.isActive('heading', { level: 3 }),
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    bullet: editor.isActive('bulletList'),
    ordered: editor.isActive('orderedList'),
    quote: editor.isActive('blockquote'),
    link: editor.isActive('link'),
    href: (editor.getAttributes('link').href as string | undefined) ?? '',
  }
  const [linkOpen, setLinkOpen] = useState(false)
  const [href, setHref] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const chain = () => editor.chain().focus()

  function openLink() {
    setHref(s.href)
    setLinkError(null)
    setLinkOpen(true)
  }
  function applyLink() {
    const url = href.trim()
    if (url === '') {
      chain().extendMarkRange('link').unsetLink().run()
      setLinkOpen(false)
      return
    }
    if (!SAFE_HREF.test(url)) {
      setLinkError('連結只收 http://、https:// 或 mailto: 開頭的網址。')
      return
    }
    if (editor.state.selection.empty && !s.link) {
      // 沒選字：把網址本身插成連結。
      chain().insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
    } else {
      chain().extendMarkRange('link').setLink({ href: url }).run()
    }
    setLinkOpen(false)
  }

  return (
    <div className="border-b border-border">
      <div role="toolbar" aria-label="正文格式" className="flex flex-wrap items-center gap-0.5 px-2 py-1">
        <ToolButton label="內文" active={s.paragraph} onClick={() => chain().setParagraph().run()}>
          內文
        </ToolButton>
        <ToolButton label="標題 2" active={s.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
          H2
        </ToolButton>
        <ToolButton label="標題 3" active={s.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}>
          H3
        </ToolButton>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="粗體" active={s.bold} onClick={() => chain().toggleBold().run()}>
          <b>B</b>
        </ToolButton>
        <ToolButton label="斜體" active={s.italic} onClick={() => chain().toggleItalic().run()}>
          <i className="font-serif">I</i>
        </ToolButton>
        <ToolButton label="底線" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
          <u>U</u>
        </ToolButton>
        <ToolButton label="刪除線" active={s.strike} onClick={() => chain().toggleStrike().run()}>
          <s>S</s>
        </ToolButton>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="項目清單" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
          • 清單
        </ToolButton>
        <ToolButton label="編號清單" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
          1. 清單
        </ToolButton>
        <ToolButton label="引用" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
          引用
        </ToolButton>
        <ToolButton label="連結" active={s.link || linkOpen} onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}>
          連結
        </ToolButton>
        <ToolButton label="分隔線" onClick={() => chain().setHorizontalRule().run()}>
          分隔線
        </ToolButton>
        {/* 表格（C 階段規格① §2.3）：extension 早就裝了，只缺按鈕。插一個 3×3、第一列是表頭。 */}
        <ToolButton label="表格" active={editor.isActive('table')} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
          表格
        </ToolButton>
      </div>
      {linkOpen ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <label htmlFor="ed-body-link" className="text-xs font-semibold">
            連結網址
          </label>
          <input
            id="ed-body-link"
            type="url"
            className={inputClass}
            placeholder="https://"
            value={href}
            autoFocus
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyLink()
              } else if (e.key === 'Escape') {
                setLinkOpen(false)
                editor.commands.focus()
              }
            }}
          />
          <button type="button" className={buttonClass} onClick={applyLink}>
            套用連結
          </button>
          {s.link ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                chain().extendMarkRange('link').unsetLink().run()
                setLinkOpen(false)
              }}
            >
              移除連結
            </button>
          ) : null}
          {linkError ? (
            <p role="alert" className="basis-full text-xs font-semibold text-destructive">
              {linkError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function TiptapEditor({
  value,
  onChange,
  labelledBy,
  placeholder,
  inputClass,
  buttonClass,
  onLossy,
}: {
  value: string
  onChange: (html: string) => void
  /** 正文標題的 id（`aria-labelledby`）。 */
  labelledBy: string
  placeholder: string
  /** 連結網址輸入框與按鈕的 class（由 `rich-editor.tsx` 從表單共用樣式算好傳進來）。 */
  inputClass: string
  buttonClass: string
  /** 這份正文 Tiptap 無法原樣保留：外面切回原始 HTML（編輯器沒有改到正文）。 */
  onLossy: (reason: string) => void
}) {
  // 最近一次由編輯器送出去的字串：外面的 value 跟它不同，才是別處改了正文，要換掉編輯器內容。
  const emitted = useRef(value)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  const host = useRef<HTMLDivElement>(null)
  // 只在瀏覽器建（rich-editor 以 ssr: false 載入）；先不掛 DOM，下面的 effect 再掛上。
  const [editor] = useState(
    () =>
      new Editor({
        element: null,
        extensions: EXTENSIONS(placeholder),
        content: toEditorHtml(value),
        // 正式站 CSP 的 style-src 只放 nonce，Tiptap 自己插的 <style> 會被擋；必要的樣式用下面的 class。
        injectCSS: false,
        editorProps: {
          attributes: {
            id: 'ed-body',
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-labelledby': labelledBy,
            class: cx(
              'prose-item min-h-56 space-y-2 px-4 py-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap outline-none',
              '[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-muted-foreground [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
              '[&_hr]:my-3 [&_hr]:border-border [&_.selectedCell]:bg-primary-subtle [&_td_p]:m-0 [&_th_p]:m-0',
            ),
          },
        },
        onUpdate: ({ editor: e }) => {
          const html = fromEditor(e)
          emitted.current = html
          onChangeRef.current(html)
        },
      }),
  )

  // 掛上 DOM 前比較；拒絕時不呼叫 onChange，原始正文一個字都不動。
  const [lossy] = useState(() => lossReason(value, fromEditor(editor)))
  const onLossyRef = useRef(onLossy)
  useEffect(() => {
    onLossyRef.current = onLossy
  }, [onLossy])

  useEffect(() => {
    if (lossy) {
      onLossyRef.current(lossy)
      return
    }
    if (host.current) editor.mount(host.current)
    return () => editor.unmount()
  }, [editor, lossy])

  useEffect(() => {
    if (lossy || value === emitted.current) return
    emitted.current = value
    const html = toEditorHtml(value)
    editor.commands.setContent(html, { emitUpdate: false })
    const reason = lossReason(value, fromEditor(editor))
    if (reason) onLossyRef.current(reason)
  }, [editor, value, lossy])

  if (lossy) return null

  return (
    <>
      <Toolbar editor={editor} inputClass={inputClass} buttonClass={buttonClass} />
      <div ref={host} />
    </>
  )
}
