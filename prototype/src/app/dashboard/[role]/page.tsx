import { notFound } from "next/navigation";
import { HomeLayout } from "@/components/dashboard/home-widgets";
import { isValidRole } from "@/lib/nav-config";
import { studentHome } from "./home-student";
import { teacherHome } from "./home-teacher";
import { adminHome } from "./home-admin";

/**
 * 後台首頁：三個角色各一套（Roy 2026-09-10 三角色分家）。
 * 學生＝歡迎、公告、行事曆、接下來；老師＝評分工作台為主；管理員＝數據總覽。內容各在 home-*.tsx。
 */
export default async function DashboardPage({ params }: PageProps<"/dashboard/[role]">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  const model = role === "student" ? studentHome(role) : role === "teacher" ? teacherHome(role) : adminHome(role);
  return <HomeLayout model={model} />;
}
