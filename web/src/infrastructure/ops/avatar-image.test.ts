import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { AVATAR_SIZE, avatarImageTransform } from '@/infrastructure/ops/avatar-image'

/**
 * 頭像縮圖（SH-9；AC-SH-44、AC-SH-84 的 sharp 失敗段）。
 *
 * `test/fixtures/exif.jpg`：400×300、左半紅右半藍、EXIF Orientation=6（要順時針轉 90° 才是正的）、
 * 帶相機型號與 GPS、嵌 sRGB ICC。轉正後應該是「上紅下藍」。
 */

const FIXTURE = new URL('../../../test/fixtures/exif.jpg', import.meta.url)

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
})
