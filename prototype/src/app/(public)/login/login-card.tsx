"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { IconAlertCircleFilled, IconArrowLeft, IconMailForward } from "@tabler/icons-react";
import { DemoBox, GoogleButton, OrDivider, PasswordField, TextField } from "@/components/public/auth-fields";

export type LoginMode = "login" | "forgot" | "sent";

/**
 * 登入 v2：同一張卡片切換「登入／忘記密碼／已寄出」，不換頁。
 * 打錯密碼時保留 Email、清掉密碼。原型：密碼輸入 wrong 模擬打錯，其他都當成登入成功（切成學生身分）。
 */
export function LoginCard({ initial, returnTo }: { initial: { mode: LoginMode; email: string; error: boolean }; returnTo: string }) {
  const [mode, setMode] = useState<LoginMode>(initial.mode);
  const [email, setEmail] = useState(initial.email);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initial.error ? "Email 或密碼不正確，請再試一次。" : "");
  const [resetEmail, setResetEmail] = useState(initial.email);
  const [resetError, setResetError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [mode]);

  function submitLogin(e: FormEvent<HTMLFormElement>) {
    if (!/^\S+@\S+\.\S+$/.test(email.trim()) || !password) {
      e.preventDefault();
      setError(!password && /^\S+@\S+\.\S+$/.test(email.trim()) ? "請輸入密碼。" : "請輸入 Email 與密碼。");
      return;
    }
    if (password === "wrong") {
      e.preventDefault();
      setError("Email 或密碼不正確，請再試一次。");
      setPassword("");
      passwordRef.current?.focus();
    }
    // 其他情況：照表單 POST 到 /api/proto-role，切成學生身分
  }

  function submitReset(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(resetEmail.trim())) {
      setResetError("請輸入有效的 Email");
      return;
    }
    setResetError("");
    setMode("sent");
  }

  function goForgot() {
    setResetEmail(email);
    setResetError("");
    setMode("forgot");
  }

  function backToLogin() {
    setError("");
    setMode("login");
  }

  return (
    <div className="flex flex-col gap-6">
      {mode === "login" ? (
        <>
          <Heading refEl={headingRef} title="登入" desc="學生、老師與系辦使用同一個入口。" />
          <form method="post" action="/api/proto-role">
            <input type="hidden" name="role" value="student" />
            <input type="hidden" name="returnTo" value={returnTo} />
            <GoogleButton type="submit">使用 Google 繼續</GoogleButton>
          </form>
          <OrDivider />
          <form method="post" action="/api/proto-role" noValidate onSubmit={submitLogin} className="flex flex-col gap-4">
            <input type="hidden" name="role" value="student" />
            <input type="hidden" name="returnTo" value={returnTo} />
            {error ? (
              <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive-subtle px-3 py-2.5 text-sm text-destructive-on-subtle">
                <IconAlertCircleFilled className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error}
              </p>
            ) : null}
            <TextField id="email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@mail.fju.edu.tw" autoComplete="username" required />
            <PasswordField
              ref={passwordRef}
              id="password"
              label="密碼"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              trailing={
                <button type="button" onClick={goForgot} className="text-[13px] font-semibold text-brand hover:underline">
                  忘記密碼？
                </button>
              }
            />
            <button type="submit" className="btn-fju mt-1 h-12 text-base">登入</button>
          </form>
          <p className="text-center text-sm text-muted-foreground">
            還沒有帳號？<Link href="/register" className="font-bold text-brand hover:underline">註冊</Link>
          </p>
          <DemoBox>密碼輸入 <code className="rounded bg-background px-1 font-mono">wrong</code> 會顯示打錯密碼（Email 會留著）；其他任何密碼都當成登入成功。</DemoBox>
        </>
      ) : null}

      {mode === "forgot" ? (
        <>
          <Heading refEl={headingRef} title="忘記密碼" desc="輸入 Email，我們寄重設連結給你。" />
          <form noValidate onSubmit={submitReset} className="flex flex-col gap-4">
            <TextField
              id="resetEmail"
              label="Email"
              type="email"
              value={resetEmail}
              onChange={(e) => setResetEmail(e.target.value)}
              placeholder="name@mail.fju.edu.tw"
              autoComplete="email"
              error={resetError}
              hint="用 Google 登入的帳號沒有密碼，直接回上一頁按「使用 Google 繼續」。"
              required
            />
            <button type="submit" className="btn-fju mt-1 h-12 text-base">送出</button>
          </form>
          <BackButton onClick={backToLogin} />
        </>
      ) : null}

      {mode === "sent" ? (
        <>
          <div className="flex size-12 items-center justify-center rounded-full bg-success-subtle">
            <IconMailForward className="size-6 text-success" aria-hidden />
          </div>
          <Heading refEl={headingRef} title="已寄出，請到信箱收信" desc="" />
          <p className="-mt-3 text-[15px] leading-relaxed text-muted-foreground">
            如果 <span className="font-bold break-all text-foreground">{resetEmail}</span> 有註冊過帳號，會收到一封重設密碼的信，連結 30 分鐘內有效。沒看到的話，找找垃圾郵件匣。
          </p>
          <BackButton onClick={backToLogin} />
        </>
      ) : null}
    </div>
  );
}

function Heading({ refEl, title, desc }: { refEl: RefObject<HTMLHeadingElement | null>; title: string; desc: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 ref={refEl} tabIndex={-1} className="text-[28px] leading-tight font-extrabold outline-none">{title}</h1>
      {desc ? <p className="text-[15px] leading-relaxed text-muted-foreground">{desc}</p> : null}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 self-center text-sm font-semibold text-muted-foreground hover:text-foreground hover:underline">
      <IconArrowLeft className="size-4" aria-hidden />返回登入
    </button>
  );
}
