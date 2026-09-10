import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { StudentSignoff } from "./student-signoff";
import { TeacherSignoff } from "./teacher-signoff";
import { AdminSignoff } from "./admin-signoff";

export default async function SignoffPage({ params }: PageProps<"/dashboard/[role]/signoff">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentSignoff />;
  if (role === "teacher") return <TeacherSignoff />;
  return <AdminSignoff />;
}
