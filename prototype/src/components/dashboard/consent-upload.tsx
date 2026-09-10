"use client";

import { useState } from "react";
import { IconFileTypePdf } from "@tabler/icons-react";

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
        <span className="tabular text-xs text-muted-foreground">{done ? "剛剛更新" : `${current.updatedAt} 上傳`}</span>
        <a href={current.file} target="_blank" rel="noreferrer" className="ml-auto text-xs font-semibold text-primary hover:underline">預覽</a>
      </div>
      {done ? (
        <p className="rounded-lg bg-success-subtle px-4 py-3 text-sm font-semibold text-success-on-subtle">已更新同意書（{done}），所有組別的同意狀態已重置，學生登入後會看到新的內容。</p>
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
