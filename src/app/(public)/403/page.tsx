import type { Metadata } from "next";
import { NeedLogin } from "@/components/public/need-login";

export const metadata: Metadata = { title: "需要登入", robots: { index: false } };

export default async function ForbiddenPage({ searchParams }: PageProps<"/403">) {
  const sp = await searchParams;
  const returnTo = typeof sp.returnTo === "string" && sp.returnTo.startsWith("/") ? sp.returnTo : "/";
  return <NeedLogin returnTo={returnTo} />;
}
