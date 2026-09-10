import { redirect } from "next/navigation";

/** 編輯器入口：側欄點進來直接開一份新草稿（/editor/new 會在瀏覽器建草稿 id 後導到 /editor/d-xxx）。 */
export default async function EditorIndex({ params }: PageProps<"/dashboard/[role]/editor">) {
  const { role } = await params;
  redirect(`/dashboard/${role}/editor/new`);
}
