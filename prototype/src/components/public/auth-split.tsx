import Image from "next/image";
import type { ReactNode } from "react";

/**
 * 註冊／登入／待審共用的左右分割外框（v2，2026-10-15）。
 * 桌機：左表單、右深藍視覺面板；手機：單欄，右面板藏起來，重點改由頁面自己放在表單下方。
 * 高度扣掉 80px 的站台導覽列。
 */
export function AuthSplit({ children, aside, width = "max-w-[440px]" }: { children: ReactNode; aside: ReactNode; width?: string }) {
  return (
    <div className="grid min-h-[calc(100dvh-5rem)] bg-background lg:grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_480px]">
      <div className="flex justify-center px-5 pt-8 pb-14 sm:px-8 sm:pt-12 lg:items-center lg:py-16">
        <div className={`w-full ${width}`}>{children}</div>
      </div>
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col">{aside}</aside>
    </div>
  );
}

export type AsideStep = { title: string; body: ReactNode };

/** 右側面板：上方校園照片、下方標題與編號步驟 */
export function AuthAside({ eyebrow, title, steps, photo = "/placeholder/campus.jpg", photoAlt = "輔仁大學校園", footnote }: { eyebrow: string; title: string; steps: AsideStep[]; photo?: string; photoAlt?: string; footnote?: ReactNode }) {
  return (
    <>
      <div className="relative h-[38%] min-h-[220px] shrink-0">
        <Image src={photo} alt={photoAlt} fill sizes="480px" className="object-cover" preload />
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-transparent via-primary/10 to-primary" />
      </div>
      <div className="flex flex-1 flex-col px-10 pt-4 pb-10 xl:px-12">
        <p className="text-[13px] font-bold tracking-[0.12em] text-brand">{eyebrow}</p>
        <h2 className="mt-2 text-[22px] leading-snug font-extrabold">{title}</h2>
        <AsideSteps steps={steps} tone="dark" className="mt-7" />
        {footnote ? <div className="mt-auto pt-8 text-[13px] leading-relaxed text-primary-foreground/75">{footnote}</div> : null}
      </div>
    </>
  );
}

/** 編號步驟清單。深色面板與手機版表單下方共用 */
export function AsideSteps({ steps, tone, className = "" }: { steps: AsideStep[]; tone: "dark" | "light"; className?: string }) {
  const dark = tone === "dark";
  return (
    <ol className={`flex flex-col ${className}`}>
      {steps.map((s, i) => (
        <li key={s.title} className="relative flex gap-4 pb-6 last:pb-0">
          {i < steps.length - 1 ? <span aria-hidden className={`absolute top-8 bottom-0 left-[15px] w-px ${dark ? "bg-white/20" : "bg-border"}`} /> : null}
          <span className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${dark ? "bg-brand text-brand-foreground" : "bg-brand-subtle text-brand-on-subtle"}`}>{i + 1}</span>
          <div className="pt-1">
            <p className={`font-bold ${dark ? "" : "text-foreground"}`}>{s.title}</p>
            <div className={`mt-1 text-[13px] leading-relaxed ${dark ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{s.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 註冊流程右側：註冊後會發生什麼 */
export const REGISTER_STEPS: AsideStep[] = [
  { title: "建立帳號", body: "用 Google 或 Email 都可以。用 Email 要先收一組 6 位數驗證碼。" },
  { title: "系辦核對身分", body: "用 Google 而且信箱和本屆專題名單登記的一樣，馬上開通；其他帳號請帶學生證到利瑪竇大樓 LM306 核對，通常 1～3 個工作天。" },
  { title: "開始使用", body: "開通後就能看專題事務、繳交文件，截止前會收到提醒。" },
];
