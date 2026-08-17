import Link from "next/link";
import { IconBrandGoogleFilled, IconInfoCircle } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const metadata = { title: "註冊" };

/**
 * 註冊頁（原型，未接 Auth）。
 * 欄位依 MOC §2.4：姓名、學號、屆別、手機、聯絡 Email 為必填；
 * 不收生日、不收學生照片。
 */
export default function RegisterPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col px-5 py-14 md:py-20">
      <h1 className="type-section">註冊帳號</h1>
      <p className="mt-2.5 text-[0.9375rem] leading-relaxed text-muted-foreground">
        送出後系統會比對本屆名單。命中即自動通過；未命中或資料不一致會進入系辦審核，
        不會阻擋你送出。
      </p>

      <button
        type="button"
        className="press mt-8 inline-flex h-12 items-center justify-center gap-2.5 rounded-xl bg-primary text-[0.9375rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        <IconBrandGoogleFilled className="size-5" />
        使用 Google 帳號註冊
      </button>

      <div className="my-8 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">或填寫以下資料</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form className="space-y-4">
        <div>
          <Label htmlFor="name">
            姓名 <span className="text-destructive">*</span>
          </Label>
          <Input id="name" className="mt-1.5 h-11" autoComplete="name" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="studentNo">
              學號 <span className="text-destructive">*</span>
            </Label>
            <Input id="studentNo" className="mt-1.5 h-11" inputMode="numeric" />
          </div>
          <div>
            <Label htmlFor="cohort">
              屆別 <span className="text-destructive">*</span>
            </Label>
            <Input
              id="cohort"
              className="mt-1.5 h-11"
              defaultValue="114"
              inputMode="numeric"
            />
          </div>
        </div>

        <div>
          <Label htmlFor="phone">
            手機 <span className="text-destructive">*</span>
          </Label>
          <Input id="phone" className="mt-1.5 h-11" inputMode="tel" autoComplete="tel" />
          <p className="mt-1.5 text-xs text-muted-foreground">
            僅系辦與指導老師可見，不會出現在公開頁面或找組員名單。
          </p>
        </div>

        <div>
          <Label htmlFor="contactEmail">
            聯絡 Email <span className="text-destructive">*</span>
          </Label>
          <Input
            id="contactEmail"
            type="email"
            className="mt-1.5 h-11"
            autoComplete="email"
          />
        </div>

        <div>
          <Label htmlFor="pw">
            密碼 <span className="text-destructive">*</span>
          </Label>
          <Input id="pw" type="password" className="mt-1.5 h-11" autoComplete="new-password" />
          <p className="mt-1.5 text-xs text-muted-foreground">
            密碼以不可逆方式保存。任何人都無法查看既有密碼，包含系辦。
          </p>
        </div>

        <button
          type="button"
          className="press h-11 w-full rounded-xl bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          送出註冊
        </button>
      </form>

      <div className="mt-8 flex items-start gap-2.5 rounded-xl border border-info/25 bg-info-subtle px-4 py-3 text-sm text-info-on-subtle">
        <IconInfoCircle className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">
          不需要填寫生日，也不需要上傳照片。老師帳號由系辦建立或預授權，不從這裡註冊。
        </p>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        已經有帳號？
        <Link href="/login" className="ml-1 font-medium text-primary hover:underline">
          前往登入
        </Link>
      </p>

      <p className="mt-10 text-center text-xs text-muted-foreground">
        原型畫面，尚未連接實際註冊服務。
      </p>
    </div>
  );
}
