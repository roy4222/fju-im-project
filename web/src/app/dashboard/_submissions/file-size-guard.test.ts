import { describe, expect, it } from 'vitest'
import { acceptOf, checkPickedFile, DEFAULT_FILE_RULES, limitText } from '@/app/dashboard/_submissions/file-size-guard'

const MIB = 1024 * 1024

describe('checkPickedFile：選檔當下的預檢（AC-17）', () => {
  const pdf20 = { allowedTypes: ['pdf'] as const, maxMiB: 20 }

  it('超過上限：寫上限與這個檔的大小（一位小數）', () => {
    expect(checkPickedFile({ name: 'report.pdf', size: 25 * MIB }, pdf20)).toBe('超過 20 MB 上限（這個檔 25.0 MB）')
    expect(checkPickedFile({ name: 'report.pdf', size: 23.4 * MIB }, pdf20)).toBe('超過 20 MB 上限（這個檔 23.4 MB）')
  })

  it('剛好等於上限、比上限小：通過', () => {
    expect(checkPickedFile({ name: 'report.pdf', size: 20 * MIB }, pdf20)).toBeNull()
    expect(checkPickedFile({ name: 'report.PDF', size: 10 * MIB }, pdf20)).toBeNull()
  })

  it('類型不符：只接受哪些（先於大小檢查）', () => {
    expect(checkPickedFile({ name: 'report.docx', size: 1 }, pdf20)).toBe('只接受 PDF')
    expect(checkPickedFile({ name: 'report.docx', size: 99 * MIB }, pdf20)).toBe('只接受 PDF')
    expect(checkPickedFile({ name: 'noext', size: 1 }, pdf20)).toBe('只接受 PDF')
    expect(checkPickedFile({ name: 'a.gif', size: 1 }, { allowedTypes: ['pdf', 'jpg', 'png'], maxMiB: 20 })).toBe('只接受 PDF、JPG、PNG')
  })

  it('jpg 也收 .jpeg；上限照欄位設定值（不寫死 20）', () => {
    const rules = { allowedTypes: ['jpg'] as const, maxMiB: 95 }
    expect(checkPickedFile({ name: 'photo.jpeg', size: 90 * MIB }, rules)).toBeNull()
    expect(checkPickedFile({ name: 'photo.jpg', size: 96 * MIB }, rules)).toBe('超過 95 MB 上限（這個檔 96.0 MB）')
  })
})

describe('上限字與 accept', () => {
  it('limitText：類型＋上限', () => {
    expect(limitText(DEFAULT_FILE_RULES)).toBe('PDF・20 MB 以內')
    expect(limitText({ allowedTypes: ['pdf', 'jpg', 'png'], maxMiB: 95 })).toBe('PDF、JPG、PNG・95 MB 以內')
  })

  it('acceptOf：副檔名清單', () => {
    expect(acceptOf({ allowedTypes: ['pdf', 'jpg'], maxMiB: 20 })).toBe('.pdf,.jpg,.jpeg')
  })
})
