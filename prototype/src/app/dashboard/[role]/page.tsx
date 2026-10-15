import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { StudentHome } from "./home-student";
import { TeacherHome } from "./home-teacher-v2";
import { AdminHome } from "./home-admin";

/**
 * 後台首頁：三個角色各一套（Roy 2026-09-10 三角色分家）。
 * 學生＝v1（現在、待辦＋月曆、公告）；老師＝v2（現在、三張待辦卡、公告，Roy 2026-10-15）；管理員＝待處理清單。
 */
export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "admin") return <AdminHome role={role} />;
  if (role === "student") return <StudentHome />;
  return <TeacherHome />;
}
