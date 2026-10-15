import { NextResponse } from "next/server";
import { ROLE_COOKIE, isViewerRole } from "@/lib/data/roles";

/**
 * 原型用：切換瀏覽身分。寫一顆 cookie，沒有任何真正的驗證。
 * 接 Better Auth 之後整個檔案移除。
 */
export async function POST(req: Request) {
  const form = await req.formData();
  return switchTo(String(form.get("role") ?? "guest"), String(form.get("returnTo") ?? "/"), 303);
}

/**
 * 直接進入用的網址：/api/proto-role?role=student&returnTo=/dashboard/student
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  return switchTo(url.searchParams.get("role") ?? "guest", url.searchParams.get("returnTo") ?? "/", 307);
}

function switchTo(role: string, returnTo: string, status: 303 | 307) {
  /* 只收站內路徑；「//evil.com」也擋掉 */
  const safe = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  /* 用相對路徑轉址：`next start --hostname 0.0.0.0` 時 req.url 的主機是 0.0.0.0，瀏覽器打不開（Roy 10-15） */
  const res = new NextResponse(null, { status, headers: { Location: safe } });
  res.cookies.set(ROLE_COOKIE, isViewerRole(role) ? role : "guest", { path: "/", sameSite: "lax", httpOnly: true });
  return res;
}
