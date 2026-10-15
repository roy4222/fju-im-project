"use client";

import { useRef, useState } from "react";
import { IconCheck, IconUpload } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AVATAR_PRESETS, setAvatar, useAvatar } from "@/lib/avatar-store";

/** 圓形頭像：讀使用者選的（或假資料預設的）圖 */
export function UserAvatar({ id, name, className = "size-10" }: { id: string; name: string; className?: string }) {
  const src = useAvatar(id);
  return (
    // eslint-disable-next-line @next/next/no-img-element -- 頭像可能是使用者上傳的 data URL
    <img src={src} alt={name} draggable={false} className={`shrink-0 rounded-full bg-muted object-cover ${className}`} />
  );
}

/** 上傳的照片裁成正方形、縮到 256px 再存，localStorage 才放得下 */
function toSquare(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      canvas.getContext("2d")!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/** 換頭像：上傳照片，或從 12 張預設選一張 */
export function AvatarDialog({ id, name, open, onOpenChange }: { id: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const current = useAvatar(id);
  const [picked, setPicked] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const shown = picked ?? current;

  function close(o: boolean) {
    onOpenChange(o);
    if (!o) setTimeout(() => setPicked(null), 200);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" data-avatar-dialog>
        <DialogTitle className="text-lg font-extrabold">換頭像</DialogTitle>
        <div className="flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={shown} alt="預覽" className="size-20 rounded-full bg-muted object-cover" />
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-bold">{name}</span>
            <button type="button" onClick={() => file.current?.click()} className="inline-flex h-10 items-center gap-1.5 self-start rounded-xl px-3.5 text-sm font-bold ring-1 ring-border transition-colors hover:bg-accent">
              <IconUpload className="size-4" /> 上傳照片
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="上傳照片"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPicked(await toSquare(f)); e.target.value = ""; }}
            />
          </div>
        </div>
        <div role="radiogroup" aria-label="預設頭像" className="grid grid-cols-6 gap-2">
          {AVATAR_PRESETS.map((src, i) => {
            const on = shown === src;
            return (
              <button key={src} type="button" role="radio" aria-checked={on} aria-label={`預設頭像 ${i + 1}`} onClick={() => setPicked(src)} className={`relative rounded-full transition-transform hover:scale-105 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring/40 ${on ? "ring-3 ring-brand ring-offset-2 ring-offset-background" : ""}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="aspect-square w-full rounded-full object-cover" />
                {on ? <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground"><IconCheck className="size-3" strokeWidth={3} /></span> : null}
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => close(false)} className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-bold text-muted-foreground hover:bg-accent">取消</button>
          <button type="button" disabled={!picked || picked === current} onClick={() => { if (picked) setAvatar(id, picked); close(false); }} className="inline-flex h-11 items-center rounded-xl bg-brand px-5 text-sm font-bold text-brand-foreground transition-colors hover:bg-brand/90 disabled:opacity-40">儲存</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
