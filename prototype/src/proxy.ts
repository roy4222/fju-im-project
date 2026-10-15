import { NextResponse, type NextRequest } from "next/server";
import { ROLE_COOKIE, isViewerRole } from "@/lib/data/roles";

/**
 * 原型用：後台身分看網址（/dashboard/<role>），前台身分看 cookie。
 * 直接打開 /dashboard/student 時把 cookie 補成同一個身分，回到前台（例如 /timeline）才不會變成訪客。
 * 接 Better Auth 之後整個檔案移除。
 */
export function proxy(req: NextRequest) {
  const role = req.nextUrl.pathname.split("/")[2];
  const res = NextResponse.next();
  if (isViewerRole(role) && role !== "guest" && req.cookies.get(ROLE_COOKIE)?.value !== role) {
    res.cookies.set(ROLE_COOKIE, role, { path: "/", sameSite: "lax", httpOnly: true });
  }
  return res;
}

export const config = {
  matcher: ["/dashboard/:role", "/dashboard/:role/:path*"],
};
