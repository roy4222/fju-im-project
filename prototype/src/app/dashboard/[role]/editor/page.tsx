import { redirect } from "next/navigation";

/** 編輯器入口：側欄點進來直接開完整編輯器（新項目）。Roy 2026-09-10：之前導回工作台他覺得「點不進去」。 */
export default async function EditorIndex({ params }: PageProps<"/dashboard/[role]/editor">) {
  const { role } = await params;
  redirect(`/dashboard/${role}/editor/new`);
}
