import sanitizeHtml from 'sanitize-html'

/**
 * 正文的白名單清理（契約 03 §5：富文字 `sanitize-html` 白名單後存，輸出再逃逸）。
 *
 * 管理員在編輯器寫的是**受限 HTML**：段落、粗斜體、清單、標題、連結、引言、表格這幾種排版，
 * 其他一律拿掉——`<script>`、`<iframe>`、`<img>`（圖片走封面與附件，不嵌在正文裡）、
 * 任何 `on*` 事件屬性、`style`、`javascript:`／`data:` 連結都不會留下來。
 *
 * 沒有任何標籤的純文字（例如快速建立時只打幾行字）會先轉成段落：空一行＝新段落、單一換行＝`<br>`，
 * 文字本身逃逸，不會被當成 HTML。
 *
 * 存進資料庫的是清理後的結果；畫面輸出時再清一次（`renderBodyHtml`），就算資料庫被人直接改過也一樣安全。
 */

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'a',
  'hr',
  'code',
  'pre',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  // target／rel 由下面的 transformTags 加上，要在白名單裡才會留下；使用者自己寫的會被覆蓋。
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  // 被拿掉的標籤，裡面的文字留下來（例如 <span>重點</span> → 重點）；這幾種連內容一起丟。
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math'],
  disallowedTagsMode: 'discard',
  // 外部連結一律開新分頁、不帶來源、不傳權重。
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
  },
}

function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** 純文字 → 段落（逃逸過）。 */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${block.split('\n').map(escapeText).join('<br>')}</p>`)
    .join('')
}

const HAS_TAG = /<\/?[a-z][^>]*>/i

/** 管理員送來的正文 → 可以存的受限 HTML。 */
export function sanitizeBody(input: string): string {
  const source = HAS_TAG.test(input) ? input : plainTextToHtml(input)
  return sanitizeHtml(source, OPTIONS).trim()
}

/** 畫面輸出前再清一次（防資料庫被直接改過）。 */
export function renderBodyHtml(stored: string): string {
  return sanitizeHtml(stored, OPTIONS)
}
