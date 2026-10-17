'use client'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Editor, Mark, Node } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
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
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Placeholder.configure({ placeholder }),
]

/*
 * 格式指紋：把正文攤成「每個字在哪種區塊裡、帶哪些格式」的序列，用來判斷 Tiptap 讀進來再寫出去有沒有改到東西。
 * 允許的正規化不算改變：b→strong、i→em、補 p（清單項、儲存格、引言裡的文字）、補 tbody／丟 thead、
 * pre 補 code、pre 裡的 br→換行、格式的巢狀順序、表格的 colgroup／style、連結的 target／rel、區塊邊界與連續空白。
 * 有差就是 Tiptap 會改掉的組合（清單項一開頭就是子清單／標題／引言／程式碼區塊、沒有網址的 `<a>`、不在清單裡的 `<li>`），
 * 這種正文不交給所見即所得，留在原始 HTML 編輯。
 */
const CONTAINERS: Record<string, string> = {
  H2: 'h2', H3: 'h3', H4: 'h4', UL: 'ul', OL: 'ol', LI: 'li', BLOCKQUOTE: 'q', PRE: 'pre', TABLE: 'table', TR: 'tr', TH: 'th', TD: 'td',
}
// ProseMirror 當成區塊的標籤（其餘不認得的標籤只留文字，跟伺服器清理一樣）。
const BOUNDARIES = new Set([
  ...Object.keys(CONTAINERS), 'P', 'THEAD', 'TBODY', 'TFOOT', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER',
  'H1', 'H5', 'H6', 'HGROUP', 'ADDRESS', 'FIGURE', 'FIGCAPTION', 'DL', 'DD', 'FIELDSET', 'FORM', 'OUTPUT', 'CANVAS',
])
// 內容不算數的標籤（伺服器清理會連內容一起丟，ProseMirror 也不讀）。
const SKIPPED = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'COLGROUP', 'TEMPLATE', 'HEAD', 'TITLE'])
const MARK_OF: Record<string, string> = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', U: 'u', S: 's', CODE: 'code' }
const LEAVES = new Set(['P', 'H2', 'H3', 'H4', 'PRE'])

function formatSignature(html: string): string {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const out: string[] = []
  let space = false
  const edge = (token: string) => {
    space = false
    if (out.at(-1) !== token) out.push(token)
  }
  const hasBlockChild = (el: Element) => [...el.children].some((c) => BOUNDARIES.has(c.tagName) || c.tagName === 'HR')
  const walk = (node: globalThis.Node, ctx: string, marks: readonly string[], pre: boolean) => {
    const key = `${ctx}{${[...new Set(marks)].sort().join(',')}}`
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        for (const ch of (child as Text).data) {
          if (!pre && /[ \t\n\r\f]/.test(ch)) {
            space = true
            continue
          }
          if (space && out.length > 0 && !['¶', '↵', '∅', 'HR'].includes(out.at(-1)!)) out.push(' ')
          space = false
          out.push(`${key}${ch}`)
        }
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      const tag = el.tagName
      if (SKIPPED.has(tag)) continue
      if (tag === 'BR') {
        // 程式碼區塊裡的 <br> 讀進來變成換行字元，看起來一樣。
        if (pre) out.push(`${key}\n`)
        else edge('↵')
        continue
      }
      if (tag === 'HR') {
        edge('¶')
        edge('HR')
        edge('¶')
        continue
      }
      let nextMarks = marks
      if (MARK_OF[tag] && !(pre && tag === 'CODE')) nextMarks = [...marks, MARK_OF[tag]]
      if (tag === 'A') {
        const href = el.getAttribute('href') ?? ''
        const kept = href !== '' && keepHref(href) ? href : ''
        const title = el.getAttribute('title') ?? ''
        if (kept || title) nextMarks = [...nextMarks, `a(${kept}|${title})`]
      }
      if (!BOUNDARIES.has(tag)) {
        walk(el, ctx, nextMarks, pre)
        continue
      }
      edge('¶')
      const before = out.length
      walk(el, CONTAINERS[tag] ? `${ctx}/${CONTAINERS[tag]}` : ctx, nextMarks, pre || tag === 'PRE')
      // 空的段落、空儲存格要算一格：Tiptap 自己補出來的空段落（例如清單項開頭補一段）就比得出來。
      const leaf = LEAVES.has(tag) || ((tag === 'LI' || tag === 'TD' || tag === 'TH' || tag === 'BLOCKQUOTE') && !hasBlockChild(el))
      if (leaf && out.slice(before).every((t) => t === '¶')) edge('∅')
      edge('¶')
    }
  }
  walk(doc.body, '', [], false)
  while (out.at(-1) === '¶' || out.at(-1) === ' ') out.pop()
  while (out[0] === '¶') out.shift()
  return out.join('\u0000')
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
  onLossy: () => void
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

  // 讀進來的內容跟 Tiptap 會寫出去的格式指紋不同 → 不交給所見即所得（掛上去前就判斷，正文一個字都不動）。
  const [lossy] = useState(() => formatSignature(toEditorHtml(value)) !== formatSignature(fromEditor(editor)))
  const onLossyRef = useRef(onLossy)
  useEffect(() => {
    onLossyRef.current = onLossy
  }, [onLossy])

  useEffect(() => {
    if (lossy) {
      onLossyRef.current()
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
    if (formatSignature(html) !== formatSignature(fromEditor(editor))) onLossyRef.current()
  }, [editor, value, lossy])

  if (lossy) return null

  return (
    <>
      <Toolbar editor={editor} inputClass={inputClass} buttonClass={buttonClass} />
      <div ref={host} />
    </>
  )
}
