"use client";

import { useState, type ReactNode } from "react";
import { IconDownload, IconFileTypePdf } from "@tabler/icons-react";

/**
 * 同意書閱讀器（Roy 2026-09-09）：系辦上傳的 PDF 直接在這裡看原檔，看完勾「我已閱讀全文」才出現同意／不同意。
 * 原型用瀏覽器內建 PDF 檢視；正式版可換 pdf.js。
 */
export function ConsentReader({ file, version, updatedAt, children, alreadyDone }: { file: string; version: string; updatedAt: string; children: ReactNode; alreadyDone?: boolean }) {
  const [read, setRead] = useState(false);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3 text-sm">
        <IconFileTypePdf className="size-5 text-destructive" />
        <span className="font-semibold">{file.split("/").pop()}</span>
        <span className="tabular text-xs text-muted-foreground">v{version}・{updatedAt} 上傳</span>
        <a href={file} download className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"><IconDownload className="size-3.5" /> 下載 PDF</a>
      </div>
      <iframe src={`${file}#toolbar=0&navpanes=0&view=FitH`} title="同意書全文" className="h-[68vh] w-full bg-muted" />
      <div className="flex flex-col gap-4 border-t border-border/70 px-5 py-4">
        {alreadyDone ? children : (
          <>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
              <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} className="size-4 accent-[var(--brand)]" />
              我已完整閱讀上面的同意書全文
            </label>
            <div className={read ? "" : "pointer-events-none opacity-40"} aria-disabled={!read}>{children}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** 管理員：上傳新版同意書 PDF。原型只做前端流程；正式版接檔案儲存並重置所有人的同意。 */
export function ConsentUpload({ current }: { current: { file: string; version: string; updatedAt: string } }) {
  const [picked, setPicked] = useState<File | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const next = current.version.replace(/(\d+)$/, (m) => String(Number(m) + 1));
  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
        <IconFileTypePdf className="size-5 text-destructive" />
        <span className="font-semibold">{current.file.split("/").pop()}</span>
        <span className="tabular text-xs text-muted-foreground">v{done ?? current.version}・{current.updatedAt}</span>
        <a href={current.file} target="_blank" rel="noreferrer" className="ml-auto text-xs font-semibold text-primary hover:underline">預覽</a>
      </div>
      {done ? (
        <p className="rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle">已建立 v{done}，所有組別的同意狀態已重置，學生登入後會看到新版。</p>
      ) : (
        <>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-border px-4 py-8 text-center transition-colors hover:border-brand/60 hover:bg-brand-subtle/40">
            <input type="file" accept="application/pdf" className="sr-only" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
            <span className="text-sm font-semibold">{picked ? picked.name : "把新版 PDF 拖進來，或點這裡選檔"}</span>
            <span className="text-xs text-muted-foreground">{picked ? `${(picked.size / 1024).toFixed(0)} KB・將建立 v${next}` : "只收 PDF，上限 10 MB"}</span>
          </label>
          {picked ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-brand/30 bg-brand-subtle px-4 py-3 text-sm">
              <span className="text-brand-on-subtle">上傳新版會把 9 組、45 位學生與 4 位老師的同意全部重置，需要重新同意。</span>
              <button type="button" onClick={() => setDone(next)} className="btn-fju ml-auto h-9 rounded-md px-4 text-xs">確認建立 v{next}</button>
              <button type="button" onClick={() => setPicked(null)} className="text-xs font-semibold text-muted-foreground hover:text-foreground">取消</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
