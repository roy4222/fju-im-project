import { notFound } from "next/navigation";
import { isValidRole } from "@/lib/nav-config";
import { StudentGroup } from "./student-group";
import { GroupsOverview } from "./groups-overview";

export default async function GroupsPage({ params, searchParams }: PageProps<"/dashboard/[role]/groups">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role)) notFound();
  if (role === "student") return <StudentGroup tab={typeof sp.tab === "string" ? sp.tab : undefined} phase={typeof sp.phase === "string" ? sp.phase : undefined} />;
  return <GroupsOverview role={role} />;
}
