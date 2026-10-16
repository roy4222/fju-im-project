/**
 * 精選影片連結只收 YouTube 影片（Q49；第 1 批設計方案 §3.3）。純函式，無 I/O。
 *
 * 草稿存使用者填的原字串（簽核 `contentHash` 把 `videoUrl` 當字串算，改寫網址會讓已簽核的草稿得重簽）；
 * 嵌入網址只在讀取端（作品頁）由這裡產生。
 */

/** 只用來取 ID 的主機；`youtube-nocookie.com` 也認得，但嵌入一律改回 `www.youtube.com`（CSP `frame-src` 只放行它）。 */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com'])

/** 路徑式網址：`/shorts/ID`、`/embed/ID`、`/live/ID`（可帶結尾斜線）。 */
const PATH_FORM = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/

/**
 * 真實 ID 是 11 碼；放寬到 1–64 碼是為了既有測試的假 ID（`youtu.be/e2e`、`youtu.be/t25-demo`）。
 * 字元集固定，所以嵌入網址不可能帶出其他主機或屬性。
 */
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/

/** YouTube 影片網址 → 影片 ID；頻道頁、播放清單、非 YouTube 主機、看不懂的一律 `null`。多餘參數（`t=`、`si=`、`list=`）忽略。 */
export function youtubeVideoId(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const host = parsed.hostname.toLowerCase()
  let id: string | null = null
  if (host === 'youtu.be') {
    id = /^\/([^/]+)\/?$/.exec(parsed.pathname)?.[1] ?? null
  } else if (YOUTUBE_HOSTS.has(host)) {
    id = parsed.pathname === '/watch' ? parsed.searchParams.get('v') : (PATH_FORM.exec(parsed.pathname)?.[1] ?? null)
  }
  return id !== null && VIDEO_ID.test(id) ? id : null
}

/** 作品頁 `<iframe>` 的網址。 */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube.com/embed/${id}`
}
