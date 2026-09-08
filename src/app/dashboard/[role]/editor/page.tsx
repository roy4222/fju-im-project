import { redirect } from "next/navigation";

/** 編輯器入口：直接到工作台選項目或新增 */
export default async function EditorIndex({ params }: PageProps<"/dashboard/[role]/editor">) {
  const { role } = await params;
  redirect(`/dashboard/${role}/affairs`);
}
