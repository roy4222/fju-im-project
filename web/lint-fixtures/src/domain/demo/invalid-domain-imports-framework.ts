// 反例 1：domain 是純 TypeScript，不可以引用任何框架。
// 預期被擋：boundaries/external
import { NextResponse } from 'next/server'

export function build() {
  return NextResponse.json({})
}
