import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[560px] max-w-xl flex-col items-center justify-center gap-4 px-5 py-16 text-center">
      <span className="tabular text-[88px] font-extrabold leading-none text-primary">404</span>
      <h1 className="text-[28px] font-extrabold">找不到這一頁</h1>
      <p className="text-base leading-relaxed text-muted-foreground">網址可能打錯，或這則內容已下架。</p>
      <div className="mt-2 flex gap-3">
        <Link href="/" className="btn-fju h-11.5 px-7 text-[15px]">回首頁</Link>
        <Link href="/news" className="btn-fju-outline h-11.5 px-7 text-[15px]">最新公告</Link>
      </div>
    </div>
  );
}
