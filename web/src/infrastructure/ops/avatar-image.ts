import 'server-only'
import { FileTransformRejected } from '@/infrastructure/ops/file-storage'

/**
 * 上傳頭像的影像處理（SH-9；設計方案 §2.2.2）。
 *
 * `FsFileStorage` 在內容檢查通過後、標 `stored` 之前呼叫（`composition/ops.ts` 登記成 `transforms.avatar`）：
 * 依 EXIF 轉正 → 裁成 256×256（`attention` 找臉或重點）→ WebP。sharp 預設**不帶任何 metadata**，
 * 所以輸出沒有 EXIF（GPS、相機型號）、ICC、XMP。
 *
 * - **sharp 只在真的轉頭像時才載入**（動態 import）：`composition/ops.ts` 也被背景工作進程（`dist/worker.mjs`）引用，
 *   而正式映像的 worker 用 `--prod --no-optional` 裝依賴，沒有 sharp 的原生套件；頂層 import 會讓 worker 一啟動就死（PR #585 Review）。
 * - **尺寸炸彈**：2 MiB 的檔案可以宣告 16000×16000，解碼要近 1 GiB 記憶體。先只讀檔頭拿寬高，超過
 *   `AVATAR_MAX_INPUT_PIXELS` 在解碼前就拒絕；sharp 的 `limitInputPixels` 再擋一次。
 *
 * 位元組大小上限不在這裡管：超過 2 MiB 的檔在發 ticket 與 `upload()` 收位元組時就擋了。
 * 解不開的檔（檔頭偽造的 PNG）sharp 會丟錯，呼叫端把它變成 `FILE_TYPE_REJECTED`，那個檔永遠不會變成 `stored`。
 */

export const AVATAR_SIZE = 256

/** 輸入最多 4096×4096 像素（16,777,216）；手機照片 4000×3000 在內。 */
export const AVATAR_MAX_INPUT_PIXELS = 4096 * 4096

const TOO_LARGE = '圖片尺寸太大，請用 4096×4096 像素以內的圖片。'

export async function avatarImageTransform(input: Buffer): Promise<{ bytes: Buffer; mime: string }> {
  const { default: sharp } = await import('sharp')
  // 只讀檔頭：不解碼像素，宣告的尺寸太大就不往下走（這一步不設 limitInputPixels，才拿得到尺寸、回中文理由）。
  const { width, height } = await sharp(input, { failOn: 'error', limitInputPixels: false }).metadata()
  if (!width || !height) throw new Error('讀不到圖片尺寸')
  if (width * height > AVATAR_MAX_INPUT_PIXELS) throw new FileTransformRejected(TOO_LARGE)

  // 真正解碼時再用 sharp 自己的像素上限擋一次（第二道）。
  const bytes = await sharp(input, { failOn: 'error', limitInputPixels: AVATAR_MAX_INPUT_PIXELS })
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer()
  return { bytes, mime: 'image/webp' }
}
