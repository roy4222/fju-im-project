import { NextResponse } from "next/server";
import { DASH_VARIANT_COOKIE, DEFAULT_DASH_VARIANT, isDashVariant } from "@/lib/data/dash-variant";

/** 原型用：切換後台版本。寫一顆 cookie 後導回原頁。定案後整個檔案移除。 */
export async function POST(req: Request) {
  const form = await req.formData();
  const variant = String(form.get("variant") ?? DEFAULT_DASH_VARIANT);
  const returnTo = String(form.get("returnTo") ?? "/dashboard");
  const res = NextResponse.redirect(new URL(returnTo.startsWith("/") ? returnTo : "/dashboard", req.url), 303);
  res.cookies.set(DASH_VARIANT_COOKIE, isDashVariant(variant) ? variant : DEFAULT_DASH_VARIANT, { path: "/", sameSite: "lax", httpOnly: true });
  return res;
}
