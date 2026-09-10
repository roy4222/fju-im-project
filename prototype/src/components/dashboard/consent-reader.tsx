"use client";

import { useState, type ReactNode } from "react";
import { IconDownload, IconFileTypePdf } from "@tabler/icons-react";

/**
 * 同意書閱讀器（Roy 2026-09-09）：系辦上傳的 PDF 直接在這裡看原檔，看完勾「我已閱讀全文」才出現同意／不同意。
 * 原型用瀏覽器內建 PDF 檢視；正式版可換 pdf.js。
 */
export function ConsentReader({ file, updatedAt, children, alreadyDone }: { file: string; version?: string; updatedAt: string; children: ReactNode; alreadyDone?: boolean }) {
  const [read, setRead] = useState(false);
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/70 px-5 py-3 text-sm">
        <IconFileTypePdf className="size-5 text-destructive" />
        <span className="font-semibold">{file.split("/").pop()}</span>
        <span className="tabular text-xs text-muted-foreground">{updatedAt} 系辦上傳</span>
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
