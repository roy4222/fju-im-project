"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { IconArrowLeft, IconChevronDown, IconCircleCheckFilled, IconMailCheck, IconX } from "@tabler/icons-react";
import { DemoBox, GoogleButton, OrDivider, OtpInput, PasswordField, StepBar, TextField, type StepState } from "@/components/public/auth-fields";
import { AsideSteps, REGISTER_STEPS } from "@/components/public/auth-split";
import { GoogleIcon } from "@/components/public/google-icon";

export type Step = 1 | 2 | 3 | "done";
export type Via = "email" | "google";

type Props = {
  initial: { step: Step; via: Via; email: string; name: string };
  rosterEmails: string[];
  googleAccounts: { name: string; email: string; demo: string }[];
};

const RESEND_SECONDS = 120;

/**
 * 註冊 v2（Q53，2026-10-15）：① 建立帳號 → ② 驗證 Email → ③ 填學生資料。
 * 用 Google 會跳過 ②；送出後，Google 而且 Email 在名單上 → 已開通，其他 → 待審頁。
 * 原型：初始步驟可由網址帶入（?step=2&email=…），方便截圖與 Roy 直接跳到某一步。
 */
export function RegisterFlow({ initial, rosterEmails, googleAccounts }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initial.step);
  const [via, setVia] = useState<Via>(initial.via);
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState("");
  const [name, setName] = useState(initial.name);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pickerOpen, setPickerOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  // 換步驟後把焦點移到新標題，鍵盤與報讀器使用者才知道畫面換了
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
    window.scrollTo({ top: 0 });
  }, [step]);

  const google = via === "google";
  const stepStates: { label: string; state: StepState; note?: string }[] = [
    { label: "建立帳號", state: step === 1 ? "current" : "done" },
    { label: "驗證 Email", state: step === 1 ? "todo" : step === 2 ? "current" : google ? "skipped" : "done", note: google && step !== 1 ? "Google 已驗證" : undefined },
    { label: "填學生資料", state: step === 3 ? "current" : step === "done" ? "done" : "todo" },
  ];

  function chooseGoogle(account: { name: string; email: string }) {
    setPickerOpen(false);
    setVia("google");
    setEmail(account.email);
    setName(account.name);
    setErrors({});
    setStep(3);
  }

  function submitAccount(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = "請輸入有效的 Email，例如 name@mail.fju.edu.tw";
    if (password.length < 8) next.password = "密碼至少 8 個字元";
    setErrors(next);
    if (Object.keys(next).length) return;
    setVia("email");
    setStep(2);
  }

  function submitProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (k: string) => String(fd.get(k) ?? "").trim();
    const next: Record<string, string> = {};
    if (!get("name")) next.name = "請填姓名";
    if (!/^\d{9}$/.test(get("studentNo"))) next.studentNo = "學號是 9 位數字";
    if (!get("className")) next.className = "請填系級";
    if (!/^09\d{2}-?\d{3}-?\d{3}$/.test(get("phone"))) next.phone = "手機格式像 0912-345-678";
    setErrors(next);
    if (Object.keys(next).length) return;
    if (google && rosterEmails.includes(email.toLowerCase())) {
      setStep("done");
      return;
    }
    const q = new URLSearchParams({ name: get("name"), studentNo: get("studentNo"), className: get("className"), phone: get("phone"), email, via });
    router.push(`/register/pending?${q}`);
  }

  return (
    <div className="flex flex-col gap-7">
      <StepBar steps={stepStates} />

      {step === 1 ? (
        <section className="flex flex-col gap-5" aria-labelledby="reg-h">
          <Heading refEl={headingRef} title="建立帳號" desc="學生用這個頁面註冊；老師帳號由系辦建立。" />
          <GoogleButton onClick={() => setPickerOpen(true)} aria-haspopup="dialog">使用 Google 繼續</GoogleButton>
          <OrDivider />
          <form noValidate onSubmit={submitAccount} className="flex flex-col gap-4">
            <TextField id="email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@mail.fju.edu.tw" autoComplete="email" error={errors.email} required />
            <PasswordField id="password" label="密碼" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" hint="至少 8 個字元" error={errors.password} required />
            <button type="submit" className="btn-fju mt-1 h-12 text-base">下一步</button>
          </form>
          <p className="text-center text-sm text-muted-foreground">
            已經有帳號？<Link href="/login" className="font-bold text-brand hover:underline">登入</Link>
          </p>
          <PolicyNote />
        </section>
      ) : null}

      {step === 2 ? (
        <VerifyStep email={email} headingRef={headingRef} onBack={() => setStep(1)} onVerified={() => setStep(3)} />
      ) : null}

      {step === 3 ? (
        <section className="flex flex-col gap-5" aria-labelledby="reg-h">
          <Heading refEl={headingRef} title="填學生資料" desc="系辦用這些資料核對身分，請和學籍資料一致。" />
          <form noValidate onSubmit={submitProfile} className="flex flex-col gap-4">
            <TextField
              id="regEmail"
              label="Email"
              value={email}
              readOnly
              hint={google ? <span className="inline-flex items-center gap-1.5"><GoogleIcon />由 Google 帳號帶入，不能修改</span> : "已驗證"}
            />
            <TextField id="name" label="姓名" defaultValue={name} placeholder="和學籍相同" autoComplete="name" error={errors.name} required />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="studentNo" label="學號" placeholder="411410123" inputMode="numeric" maxLength={9} error={errors.studentNo} required />
              <TextField id="className" label="系級" placeholder="例：資管四甲" error={errors.className} required />
            </div>
            <TextField id="phone" label="手機" type="tel" placeholder="0912-345-678" autoComplete="tel" error={errors.phone} required />
            <button type="submit" className="btn-fju mt-1 h-12 text-base">送出</button>
          </form>
          {google ? (
            <button type="button" onClick={() => { setVia("email"); setEmail(""); setStep(1); }} className="self-center text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline">
              換一個帳號
            </button>
          ) : null}
        </section>
      ) : null}

      {step === "done" ? (
        <section className="flex flex-col gap-5" aria-labelledby="reg-h">
          <div className="flex size-14 items-center justify-center rounded-full bg-success-subtle">
            <IconCircleCheckFilled className="size-8 text-success" aria-hidden />
          </div>
          <Heading refEl={headingRef} title="帳號已開通" desc={`${email} 和本屆專題名單登記的 Email 相同，不用等系辦審核。`} />
          <form method="post" action="/api/proto-role">
            <input type="hidden" name="role" value="student" />
            <input type="hidden" name="returnTo" value="/dashboard/student" />
            <button type="submit" className="btn-fju h-12 w-full text-base">進入系統</button>
          </form>
          <p className="text-center text-[13px] text-muted-foreground">之後用「使用 Google 繼續」登入即可。</p>
        </section>
      ) : null}

      {step === 1 ? (
        <details className="group rounded-lg border border-border lg:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-bold [&::-webkit-details-marker]:hidden">
            註冊後會發生什麼？<IconChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <AsideSteps steps={REGISTER_STEPS} tone="light" className="px-4 pb-4" />
        </details>
      ) : null}

      {pickerOpen ? <GooglePicker accounts={googleAccounts} onPick={chooseGoogle} onClose={() => setPickerOpen(false)} /> : null}
    </div>
  );
}

function Heading({ refEl, title, desc }: { refEl: RefObject<HTMLHeadingElement | null>; title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 id="reg-h" ref={refEl} tabIndex={-1} className="text-[28px] leading-tight font-extrabold outline-none">{title}</h1>
      <p className="text-[15px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  );
}

function PolicyNote() {
  return (
    <p className="text-center text-xs leading-relaxed text-muted-foreground">
      繼續即表示你同意本站的<Link href="/privacy" className="font-semibold text-foreground underline underline-offset-2 hover:text-brand">隱私權政策</Link>。
    </p>
  );
}

function VerifyStep({ email, headingRef, onBack, onVerified }: { email: string; headingRef: RefObject<HTMLHeadingElement | null>; onBack: () => void; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [left, setLeft] = useState(RESEND_SECONDS);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);

  function verify(e: FormEvent) {
    e.preventDefault();
    // 原型：任意 6 位數都通過
    if (!/^\d{6}$/.test(code)) {
      setError("請輸入完整的 6 位數驗證碼");
      return;
    }
    onVerified();
  }

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");

  return (
    <section className="flex flex-col gap-5" aria-labelledby="reg-h">
      <div className="flex size-12 items-center justify-center rounded-full bg-brand-subtle">
        <IconMailCheck className="size-6 text-brand-on-subtle" aria-hidden />
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 id="reg-h" ref={headingRef} tabIndex={-1} className="text-[28px] leading-tight font-extrabold outline-none">驗證 Email</h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          驗證碼已寄到 <span className="font-bold break-all text-foreground">{email}</span>，10 分鐘內有效。
        </p>
      </div>
      <form noValidate onSubmit={verify} className="flex flex-col gap-4">
        <OtpInput value={code} onChange={(v) => { setCode(v); setError(""); }} invalid={!!error} />
        {error ? <p role="alert" className="text-[13px] text-destructive">{error}</p> : null}
        <button type="submit" className="btn-fju h-12 text-base">驗證</button>
      </form>
      <div className="flex flex-col items-center gap-3 text-sm">
        <p className="text-muted-foreground" aria-live="polite">
          沒收到？
          {left > 0 ? (
            <span className="tabular-nums">{mm}:{ss} 後可以重新寄送</span>
          ) : (
            <button type="button" onClick={() => { setLeft(RESEND_SECONDS); setResent(true); setCode(""); }} className="font-bold text-brand hover:underline">
              重新寄送
            </button>
          )}
          {resent && left > RESEND_SECONDS - 5 ? <span className="ml-1 font-semibold text-success">已重新寄出</span> : null}
        </p>
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 font-semibold text-muted-foreground hover:text-foreground hover:underline">
          <IconArrowLeft className="size-4" aria-hidden />Email 打錯了？回上一步修改
        </button>
      </div>
      <DemoBox>
        任意 6 位數都會通過。
        {left > 0 ? (
          <button type="button" onClick={() => setLeft(0)} className="ml-1 font-bold underline underline-offset-2">跳過倒數</button>
        ) : null}
      </DemoBox>
    </section>
  );
}

/** 仿 Google 帳號選擇器。兩個帳號就是「已開通／待審」的示範切換 */
function GooglePicker({ accounts, onPick, onClose }: { accounts: Props["googleAccounts"]; onPick: (a: { name: string; email: string }) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // 不在 cleanup 裡 close()：close 會觸發 onClose，StrictMode 重跑 effect 時會把剛開的選擇器關掉
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      aria-labelledby="gp-h"
      className="m-auto w-[min(420px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <GoogleIcon />
          <h2 id="gp-h" className="font-bold">選擇帳號</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="關閉" className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
          <IconX className="size-4.5" aria-hidden />
        </button>
      </div>
      <p className="px-5 pt-3 text-[13px] text-muted-foreground">繼續前往「輔大資管專題平台」</p>
      <ul className="flex flex-col p-2">
        {accounts.map((a) => (
          <li key={a.email}>
            <button type="button" onClick={() => onPick(a)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{a.name.slice(0, 1)}</span>
              <span className="min-w-0">
                <span className="block font-semibold">{a.name}</span>
                <span className="block truncate text-[13px] text-muted-foreground">{a.email}</span>
                <span className="mt-1 inline-block rounded bg-warning-subtle px-1.5 py-px text-[11px] font-semibold text-warning-on-subtle">示範：{a.demo}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
