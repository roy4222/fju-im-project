import { notFound } from "next/navigation";
import { TeacherConsent } from "./teacher-consent";
import { myConsents } from "@/lib/teacher-v2";

export default async function TeacherConsentPage({ params }: PageProps<"/dashboard/[role]/affairs/signoff/[groupId]">) {
  const { role, groupId } = await params;
  if (role !== "teacher") notFound();
  if (!myConsents().some((p) => p.groupId === groupId)) notFound();
  return <TeacherConsent groupId={groupId} />;
}
