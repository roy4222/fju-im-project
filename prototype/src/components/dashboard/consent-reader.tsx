"use client";

import { useState, type ReactNode } from "react";
import { IconDownload, IconExternalLink, IconFileTypePdf } from "@tabler/icons-react";

/**
 * 同意書閱讀器（Roy 2026-09-09）：看完勾「我已閱讀全文」才出現同意／不同意。
 * Codex 09-10 S-06：PDF 上方先放可讀的 HTML 條文摘要與版本日期；PDF 另開新視窗＋下載備援，內嵌只留 48vh。
 * 原型：條文摘要是假資料，正式版由系辦上傳時一併填。
 */
const CONSENT_SUMMARY: { no: string; text: string }[] = [
  { no: "一", text: "本組同意將專題成果（系統、文件、海報與影片）授權輔仁大學資訊管理學系作教學、展示與非營利用途。" },
  { no: "二", text: "著作權仍歸組員與指導老師共同所有；系上不得移作商業用途或轉授權第三方。" },
  { no: "三", text: "本組保證成果為原創，引用之程式碼、素材與資料皆已取得合法授權，並負相關責任。" },
  { no: "四", text: "系上公開展示前得遮蔽個資與敏感資料；組員得於發表後一年內申請下架。" },
  { no: "五", text: "同意以線上表態為準；五位組員各自同意後，由指導老師簽核，不需列印簽名。" },
  { no: "六", text: "任一組員不同意並退回時，本同意書回到修正狀態，修正後全組重新表態。" },
];

export function ConsentReader({ file, version, updatedAt, children, alreadyDone }: { file: string; version?: string; updatedAt: string; children: ReactNode; alreadyDone?: boolean }) {
  const [read, setRead] = useState(false);
  const name = file.split("/").pop();
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-[15px] font-bold">條文摘要</h3>
          <span className="tabular text-xs text-muted-foreground">版本 {version ?? "—"}・{updatedAt} 系辦上傳</span>
        </div>
        <ol className="flex flex-col gap-2 text-sm leading-relaxed">
          {CONSENT_SUMMARY.map((c) => (
            <li key={c.no} className="flex gap-3"><span className="w-6 shrink-0 font-bold text-primary">{c.no}、</span><span>{c.text}</span></li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">摘要僅供閱讀；以下方 PDF 全文為準。</p>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-5 py-3 text-sm">
        <IconFileTypePdf className="size-5 text-destructive" />
        <span className="font-semibold">{name}</span>
        <span className="ml-auto flex items-center gap-1">
          <a href={file} target="_blank" rel="noopener" className="inline-flex h-10 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold text-primary transition-colors hover:bg-accent"><IconExternalLink className="size-4" /> 另開新視窗</a>
          <a href={file} download className="inline-flex h-10 items-center gap-1 rounded-lg px-3 text-[13px] font-semibold text-primary transition-colors hover:bg-accent"><IconDownload className="size-4" /> 下載</a>
        </span>
      </div>
      <iframe src={`${file}#toolbar=0&navpanes=0&view=FitH`} title="同意書全文" className="h-[48vh] w-full bg-muted" />
      <div className="flex flex-col gap-4 border-t border-border/70 px-5 py-4">
        {alreadyDone ? children : (
          <>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="size-4 accent-[var(--brand)]" />
              我已完整閱讀同意書全文（摘要與 PDF）
            </label>
            <div className={read ? "" : "pointer-events-none opacity-40"} aria-disabled={!read}>{children}</div>
          </>
        )}
      </div>
    </div>
  );
}
