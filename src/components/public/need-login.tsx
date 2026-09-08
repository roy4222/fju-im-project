import Link from "next/link";
import { IconLock } from "@tabler/icons-react";

/**
 * 403：需要登入。訪客點到登入後內容時整頁顯示（規格 §10.3 無權限狀態）。
 * 登入後回到原本要看的頁面。
 */
export function NeedLogin({ returnTo, what = "這一頁" }: { returnTo: string; what?: string }) {
  return (
    <div className="mx-auto flex min-h-[560px] max-w-xl flex-col items-center justify-center gap-4 px-5 py-16 text-center">
      <span className="tabular text-[88px] font-extrabold leading-none text-primary">403</span>
      <IconLock className="size-7 text-muted-foreground" aria-hidden />
      <h1 className="text-[28px] font-extrabold">{what}需要登入</h1>
      <p className="text-base leading-relaxed text-muted-foreground">歷屆專題一覽、產學合作與檔案下載只提供本系學生與老師。登入後會回到你原本要看的頁面。</p>
      <div className="mt-2 flex gap-3">
        <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="btn-fju h-11.5 px-7 text-[15px]">
          登入
        </Link>
        <Link href="/" className="btn-fju-outline h-11.5 px-7 text-[15px]">
          回首頁
        </Link>
      </div>
    </div>
  );
}
