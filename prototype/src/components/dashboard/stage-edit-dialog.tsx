"use client";

import type { ReactNode } from "react";
import type { Stage } from "@/lib/fixtures";

/**
 * 管理員「時間軸設定」的編輯面板：新增階段／編輯階段與日期（Codex 09-10 A-04）。
 * 樁：由管理員 agent 實作成 Dialog（名稱、起訖、關聯事務、預覽學生看到的結果）。
 */
export function StageEditDialog({ stage, trigger }: { stage?: Stage; trigger: ReactNode }) {
  void stage;
  return <>{trigger}</>;
}
