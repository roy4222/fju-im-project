import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { StudentAffairs } from "./student-affairs";
import { AdminAffairs } from "./admin-affairs";
import { TeacherWork } from "./teacher-work";

export default async function AffairsPage({ params, searchParams }: PageProps<"/dashboard/[role]/affairs">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentAffairs tab={typeof sp.tab === "string" ? sp.tab : "open"} />;
  /* 老師 v2：作業區＝各組繳交｜同意書（Roy 2026-10-15） */
  if (role === "teacher") return <TeacherWork tab={typeof sp.tab === "string" ? sp.tab : undefined} />;
  return <AdminAffairs role={role} placement={typeof sp.placement === "string" ? sp.placement : "all"} />;
}
