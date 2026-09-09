import { NextResponse } from "next/server";
import { ROLE_COOKIE, isViewerRole } from "@/lib/data/roles";

/**
 * 原型用：切換瀏覽身分。寫一顆 cookie，沒有任何真正的驗證。
 * 接 Better Auth 之後整個檔案移除。
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const role = String(form.get("role") ?? "guest");
  const returnTo = String(form.get("returnTo") ?? "/");
  const res = NextResponse.redirect(new URL(returnTo.startsWith("/") ? returnTo : "/", req.url), 303);
  res.cookies.set(ROLE_COOKIE, isViewerRole(role) ? role : "guest", { path: "/", sameSite: "lax", httpOnly: true });
  return res;
}
