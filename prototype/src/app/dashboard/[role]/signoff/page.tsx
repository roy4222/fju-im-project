import { notFound, redirect } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { TeacherSignoff } from "./teacher-signoff";
import { AdminSignoff } from "./admin-signoff";

export default async function SignoffPage({ params }: PageProps<"/dashboard/[role]/signoff">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  /* 學生 v1：同意書併進交作業（Roy 2026-10-15） */
  if (role === "student") redirect("/dashboard/student/affairs/consent");
  if (role === "teacher") return <TeacherSignoff />;
  return <AdminSignoff />;
}
