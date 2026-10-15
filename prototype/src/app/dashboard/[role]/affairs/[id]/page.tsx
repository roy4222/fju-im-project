import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { MANAGED_ITEMS } from "@/lib/fixtures";
import { StudentItem } from "./student-item";
import { StaffItem } from "./staff-item";
import { StudentConsent } from "./student-consent";

export default async function AffairItemPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs/[id]">) {
  const { role, id } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  /* 學生 v1：同意書是交作業裡的一張卡，詳情也在交作業底下（側欄停在「交作業」） */
  if (role === "student" && id === "consent") return <StudentConsent />;
  const item = MANAGED_ITEMS.find((i) => i.id === id);
  if (!item) notFound();
  const base = `/dashboard/${role}`;
  if (role === "student") return <StudentItem item={item} base={base} tab={typeof sp.tab === "string" ? sp.tab : undefined} />;
  return <StaffItem item={item} role={role} base={base} focus={typeof sp.group === "string" ? sp.group : undefined} />;
}
