'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Placeholder } from '@tiptap/extensions'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import {
  IconBlockquote,
  IconBold,
  IconItalic,
  IconLink,
  IconList,
  IconListNumbers,
  IconSeparatorHorizontal,
  IconStrikethrough,
  IconUnderline,
} from '@tabler/icons-react'
import { INPUT, SECONDARY } from '@/app/dashboard/admin/affairs/item-form-parts'
import { cn } from '@/shared/cn'

/**
 * 系辦正文的所見即所得編輯器（AD-B5，設計方案 §8.2）。只由 `rich-editor.tsx` 動態載入（不進 First Load JS）。
 *
 * 擴充**剛好對到** `application/items/rich-text.ts` 的白名單，原始 HTML 切過來才不會靜默丟內容：
 * 段落、h2～h4、粗斜體、底線、刪除線、清單、引言、程式碼、分隔線、換行、連結（只收 http／https／mailto，
 * 保留 title）、表格（只為保留既有內容，工具列不給新增表格）。白名單沒有 `img`，所以不提供正文插圖。
 * 伺服器存檔前仍會再清一次，這裡不是信任點。
 */

const SAFE_HREF = /^(https?:|mailto:)/i

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

const EXTENSIONS = (placeholder: string) => [
  StarterKit.configure({
    heading: { levels: [2, 3, 4] },
    // 表格、分隔線後面不自動補空段落：切換模式不該多出內容。
    trailingNode: false,
    link: {
      openOnClick: false,
      defaultProtocol: 'https',
      isAllowedUri: (url) => SAFE_HREF.test(url),
    },
  }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Placeholder.configure({ placeholder }),
]

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
      className={cn(
        'inline-flex h-7 min-w-7 items-center justify-center rounded px-1.5 text-xs font-semibold hover:bg-muted',
        active && 'bg-primary-subtle text-primary-on-subtle',
      )}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive('paragraph'),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      href: (e.getAttributes('link').href as string | undefined) ?? '',
    }),
  })
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
          <IconBold size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="斜體" active={s.italic} onClick={() => chain().toggleItalic().run()}>
          <IconItalic size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="底線" active={s.underline} onClick={() => chain().toggleUnderline().run()}>
          <IconUnderline size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="刪除線" active={s.strike} onClick={() => chain().toggleStrike().run()}>
          <IconStrikethrough size={15} aria-hidden />
        </ToolButton>
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <ToolButton label="項目清單" active={s.bullet} onClick={() => chain().toggleBulletList().run()}>
          <IconList size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="編號清單" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}>
          <IconListNumbers size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="引用" active={s.quote} onClick={() => chain().toggleBlockquote().run()}>
          <IconBlockquote size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="連結" active={s.link || linkOpen} onClick={() => (linkOpen ? setLinkOpen(false) : openLink())}>
          <IconLink size={15} aria-hidden />
        </ToolButton>
        <ToolButton label="分隔線" onClick={() => chain().setHorizontalRule().run()}>
          <IconSeparatorHorizontal size={15} aria-hidden />
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
            className={cn(INPUT, 'mt-0 h-8 min-h-8 min-w-0 flex-1 py-1')}
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
          <button type="button" className={cn(SECONDARY, 'h-8')} onClick={applyLink}>
            套用連結
          </button>
          {s.link ? (
            <button
              type="button"
              className={cn(SECONDARY, 'h-8')}
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
}: {
  value: string
  onChange: (html: string) => void
  /** 正文標題的 id（`aria-labelledby`）。 */
  labelledBy: string
  placeholder: string
}) {
  // 最近一次由編輯器送出去的字串：外面的 value 跟它不同，才是別處改了正文，要換掉編輯器內容。
  const emitted = useRef(value)
  const editor = useEditor({
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
        class: cn(
          'prose-item min-h-56 space-y-2 px-4 py-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap outline-none',
          '[&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-muted-foreground [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]',
          '[&_hr]:my-3 [&_hr]:border-border [&_.selectedCell]:bg-primary-subtle [&_td_p]:m-0 [&_th_p]:m-0',
        ),
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = fromEditor(e)
      emitted.current = html
      onChange(html)
    },
  })

  useEffect(() => {
    if (!editor || value === emitted.current) return
    emitted.current = value
    editor.commands.setContent(toEditorHtml(value), { emitUpdate: false })
  }, [editor, value])

  if (!editor) return null
  return (
    <>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </>
  )
}
