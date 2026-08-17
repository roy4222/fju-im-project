import Link from "next/link";
import { IconBrandGoogleFilled, IconInfoCircle } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buttonVariants } from "@/components/ui/button";

export const metadata = { title: "登入" };

/**
 * 登入頁（原型，未接 Auth）。
 * MOC §2.3：Google OAuth 為主要方式，Email/密碼為備援；兩者登入後有相同的
 * 帳號狀態、角色與審核流程。畫面上要讓「主要／備援」的層級關係看得出來。
 */
export default function LoginPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col px-5 py-14 md:py-20">
      <h1 className="type-section">登入專題管理平台</h1>
      <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-muted-foreground">
        學生、指導老師與系辦使用同一個入口。登入後會依帳號角色進入對應的頁面。
      </p>

      {/* 主要方式 */}
      <button
        type="button"
        className="press mt-8 inline-flex h-12 items-center justify-center gap-2.5 rounded-xl bg-primary text-[0.9375rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <IconBrandGoogleFilled className="size-5" />
        使用 Google 帳號登入
      </button>
      <p className="mt-2 text-xs text-muted-foreground">建議使用學校配發的 Google 帳號。</p>

      <div className="my-8 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">或使用 Email 與密碼</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      {/* 備援方式 */}
      <form className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" className="mt-1.5 h-11" />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password">密碼</Label>
            <Link href="#" className="text-xs font-medium text-primary hover:underline">
              忘記密碼
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            className="mt-1.5 h-11"
          />
        </div>
        <button
          type="button"
          className="press h-11 w-full rounded-xl border border-border bg-background text-sm font-medium transition-colors hover:bg-accent"
        >
          登入
        </button>
      </form>

      <div className="mt-8 flex items-start gap-2.5 rounded-xl border border-info/25 bg-info-subtle px-4 py-3 text-sm text-info-on-subtle">
        <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">
          第一次使用請先註冊。系統會比對本屆名單；名單命中即自動通過，未命中則進入系辦審核。
        </p>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        還沒有帳號？
        <Link href="/register" className="ml-1 font-medium text-primary hover:underline">
          註冊帳號
        </Link>
      </p>

      <p className="mt-10 text-center text-xs text-muted-foreground">
        原型畫面，尚未連接實際登入服務。
      </p>
    </div>
  );
}
