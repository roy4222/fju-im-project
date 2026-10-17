import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { build } from 'esbuild'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { AVATAR_MAX_INPUT_PIXELS, AVATAR_SIZE, avatarImageTransform } from '@/infrastructure/ops/avatar-image'
import { FileTransformRejected } from '@/infrastructure/ops/file-storage'

/**
 * 頭像縮圖（SH-9；AC-SH-44、AC-SH-84 的 sharp 失敗段）。
 *
 * `test/fixtures/exif.jpg`：400×300、左半紅右半藍、EXIF Orientation=6（要順時針轉 90° 才是正的）、
 * 帶相機型號與 GPS、嵌 sRGB ICC。轉正後應該是「上紅下藍」。
 */

const FIXTURE = new URL('../../../test/fixtures/exif.jpg', import.meta.url)

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** 檔頭宣告 width×height、交錯式 RGB 的 PNG；IDAT 只放幾 KB（解碼前就該被擋，內容不重要）。 */
function pngBomb(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 1], 8) // 8-bit、RGB、deflate、filter 0、Adam7 交錯
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(64 * 1024))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function pixel(image: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i]!, data[i + 1]!, data[i + 2]!]
}

describe('avatarImageTransform', () => {
  it('fixture 本身真的帶 EXIF（方向 6、相機型號）與 ICC：不然下面的「清掉了」證明不了什麼', async () => {
    const input = await fs.readFile(FIXTURE)
    const meta = await sharp(input).metadata()
    expect(meta.orientation).toBe(6)
    expect(meta.exif?.toString('latin1')).toContain('Fixture Cam')
    expect(meta.icc).toBeDefined()
  })

  it('輸出 256×256 WebP，不帶 EXIF／ICC／XMP，也沒有方向標記', async () => {
    const out = await avatarImageTransform(await fs.readFile(FIXTURE))
    expect(out.mime).toBe('image/webp')
    const meta = await sharp(out.bytes).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: AVATAR_SIZE, height: AVATAR_SIZE })
    expect(meta.exif).toBeUndefined()
    expect(meta.icc).toBeUndefined()
    expect(meta.xmp).toBeUndefined()
    expect(meta.orientation).toBeUndefined()
    expect(out.bytes.toString('latin1')).not.toContain('Fixture Cam')
    expect(out.bytes.length).toBeLessThanOrEqual(40 * 1024)
  })

  it('依 EXIF 轉正：原圖左紅右藍，轉正後上紅下藍', async () => {
    const out = await avatarImageTransform(await fs.readFile(FIXTURE))
    const [tr, , tb] = await pixel(out.bytes, AVATAR_SIZE / 2, 10)
    const [br, , bb] = await pixel(out.bytes, AVATAR_SIZE / 2, AVATAR_SIZE - 10)
    expect(tr).toBeGreaterThan(150)
    expect(tb).toBeLessThan(100)
    expect(bb).toBeGreaterThan(150)
    expect(br).toBeLessThan(100)
  })

  it('PNG 也收（轉成 WebP）', async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#3366cc' } }).png().toBuffer()
    const meta = await sharp((await avatarImageTransform(png)).bytes).metadata()
    expect(meta).toMatchObject({ format: 'webp', width: AVATAR_SIZE, height: AVATAR_SIZE })
  })

  it('檔頭偽造成 PNG、後面是亂碼：丟錯（呼叫端會變成 FILE_TYPE_REJECTED）', async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2048)])
    await expect(avatarImageTransform(fake)).rejects.toThrow()
  })

  it('尺寸炸彈（檔頭宣告 16000×16000 交錯 PNG）：解碼前就拒絕，帶給使用者看的理由', async () => {
    const bomb = pngBomb(16_000, 16_000)
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024)
    const rss = process.memoryUsage().rss
    const rejected = await avatarImageTransform(bomb).catch((error: unknown) => error)
    expect(rejected).toBeInstanceOf(FileTransformRejected)
    expect((rejected as Error).message).toContain('4096×4096')
    // 沒有解碼：記憶體不會跳幾百 MB（真的解碼約 866 MiB）。
    expect(process.memoryUsage().rss - rss).toBeLessThan(100 * 1024 * 1024)
  })

  it('剛好在上限（4096×4096 像素）以內的尺寸不擋在尺寸檢查；超過一列就擋', async () => {
    expect(AVATAR_MAX_INPUT_PIXELS).toBe(16_777_216)
    await expect(avatarImageTransform(pngBomb(4097, 4096))).rejects.toBeInstanceOf(FileTransformRejected)
    // 4096×4096 過了尺寸檢查，後面因為 IDAT 不完整而解碼失敗——是一般錯誤，不是「尺寸太大」。
    const atLimit = await avatarImageTransform(pngBomb(4096, 4096)).catch((error: unknown) => error)
    expect(atLimit).not.toBeInstanceOf(FileTransformRejected)
  })
})

describe('背景工作進程不在啟動時載入 sharp（PR #585 Review：正式映像的 worker 沒有 sharp 原生套件）', () => {
  it('照 scripts/build-worker.mjs 的設定打包 worker：sharp 只能以動態 import 出現，不能是頂層 import', async () => {
    const webRoot = path.join(import.meta.dirname, '../../..')
    const result = await build({
      absWorkingDir: webRoot,
      entryPoints: ['src/composition/worker-main.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      packages: 'external',
      tsconfig: 'tsconfig.json',
      metafile: true,
      logLevel: 'silent',
      plugins: [
        {
          name: 'empty-server-only',
          setup(builder) {
            builder.onResolve({ filter: /^server-only$/ }, () => ({ path: 'server-only', namespace: 'empty' }))
            builder.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export {}', loader: 'js' }))
          },
        },
      ],
    })
    const imports = Object.values(result.metafile.outputs).flatMap((o) => o.imports)
    const sharpImports = imports.filter((i) => i.path === 'sharp' || i.path.startsWith('@img/'))
    expect(sharpImports.filter((i) => i.kind !== 'dynamic-import')).toEqual([])
  }, 30_000)
})
