import 'server-only'
/**
 * 精選影片網址的讀取端解析（Q49）：作品頁用它把 YouTube 網址換成嵌入網址。
 * 純函式，從模組入口 re-export；app 只從 composition 拿執行期值。
 */
export { youtubeEmbedUrl, youtubeVideoId } from '@/application/showcase'
