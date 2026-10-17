import 'server-only'
import sharp from 'sharp'

/**
 * 上傳頭像的影像處理（SH-9；設計方案 §2.2.2）。
 *
 * `FsFileStorage` 在內容檢查通過後、標 `stored` 之前呼叫（`composition/ops.ts` 登記成 `transforms.avatar`）：
 * 依 EXIF 轉正 → 裁成 256×256（`attention` 找臉或重點）→ WebP。sharp 預設**不帶任何 metadata**，
 * 所以輸出沒有 EXIF（GPS、相機型號）、ICC、XMP。
 *
 * 大小上限不在這裡管：超過 2 MiB 的檔在發 ticket 與 `upload()` 收位元組時就擋了。
 * 解不開的檔（檔頭偽造的 PNG）sharp 會丟錯，呼叫端把它變成 `FILE_TYPE_REJECTED`，那個檔永遠不會變成 `stored`。
 */

export const AVATAR_SIZE = 256

export async function avatarImageTransform(input: Buffer): Promise<{ bytes: Buffer; mime: string }> {
  const bytes = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer()
  return { bytes, mime: 'image/webp' }
}
