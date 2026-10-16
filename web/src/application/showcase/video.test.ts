import { describe, expect, it } from 'vitest'
import { youtubeEmbedUrl, youtubeVideoId } from '@/application/showcase/video'

describe('YouTube 影片網址 → 影片 ID（Q49）', () => {
  it('watch、youtu.be、shorts、手機版、直播網址都取得到同一個 ID；多餘參數忽略', () => {
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ?si=abc',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'http://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://youtu.be/dQw4w9WgXcQ/',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ/',
    ]) {
      expect(youtubeVideoId(url), url).toBe('dQw4w9WgXcQ')
    }
  })

  it('既有測試的假 ID（e2e、t25-demo、x）也算：只限字元集，不限 11 碼', () => {
    expect(youtubeVideoId('https://youtu.be/e2e')).toBe('e2e')
    expect(youtubeVideoId('https://youtu.be/t25-demo')).toBe('t25-demo')
    expect(youtubeVideoId('https://youtu.be/x')).toBe('x')
    expect(youtubeVideoId('https://youtu.be/abc')).toBe('abc')
  })

  it('頻道頁、播放清單、非 YouTube 主機、非影片路徑、javascript: 都不是影片', () => {
    for (const url of [
      'https://vimeo.com/123',
      'https://www.youtube.com/@fjuim',
      'https://www.youtube.com/playlist?list=PL1',
      'https://drive.google.com/file/d/x',
      'javascript:alert(1)',
      'https://www.youtube.com/channel/UC123',
      'https://www.youtube.com/c/fjuim',
      'https://www.youtube.com/user/fjuim',
      'https://www.youtube.com/',
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=',
      'https://youtu.be/',
      'https://evil.example/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'ftp://youtu.be/dQw4w9WgXcQ',
      'youtu.be/t25-demo',
      'not a url',
      '',
    ]) {
      expect(youtubeVideoId(url), url).toBeNull()
    }
  })

  it('ID 只收英數、底線、連字號，最多 64 碼：引號、斜線、編碼字元都擋（嵌入網址不可能被注入）', () => {
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abc%22onload%3D')).toBeNull()
    expect(youtubeVideoId('https://www.youtube.com/watch?v=abc/def')).toBeNull()
    expect(youtubeVideoId('https://youtu.be/第一組成果影片')).toBeNull()
    expect(youtubeVideoId(`https://youtu.be/${'a'.repeat(64)}`)).toBe('a'.repeat(64))
    expect(youtubeVideoId(`https://youtu.be/${'a'.repeat(65)}`)).toBeNull()
  })

  it('嵌入網址一律用 www.youtube.com（CSP frame-src 只放行它；youtube-nocookie 維持被擋）', () => {
    expect(youtubeEmbedUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ')
    expect(youtubeEmbedUrl(youtubeVideoId('https://www.youtube-nocookie.com/embed/e2e')!)).toBe('https://www.youtube.com/embed/e2e')
  })
})
