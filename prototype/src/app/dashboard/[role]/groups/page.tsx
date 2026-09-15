import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { StudentGroup } from "./student-group";
import { GroupsOverview } from "./groups-overview";

export default async function GroupsPage({ params }: PageProps<"/dashboard/[role]/groups">) {
  const { role } = await params;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentGroup />;
  return <GroupsOverview role={role} />;
}
