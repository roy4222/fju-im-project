import { notFound } from "next/navigation";
import { DraftEditor } from "@/components/dashboard/item-editor";
import { isValidRole } from "@/lib/nav-config";
import { FORM_SCHEMAS, MANAGED_ITEMS, type ManagedItem } from "@/lib/fixtures";
import { isDraftId, type Draft } from "@/lib/draft-store";

/** fixtures 的 ManagedItem → 編輯器草稿形狀（發布後再編輯同一件，不重建空白 item） */
function fromItem(i: ManagedItem): Draft {
  return {
    id: i.id,
    kind: i.placement,
    title: i.title,
    summary: i.summary,
    body: i.summary,
    audience: i.audience === "公開訪客" ? "公開訪客" : i.audience.includes("老師") ? "全部老師" : "本屆學生",
    groupIds: [],
    dueAt: i.dueAt ?? "",
    visibility: i.audience === "公開訪客" ? "public" : "students",
    notify: true,
    fields: FORM_SCHEMAS[i.id] ?? [],
    attachments: Array.from({ length: i.attachments ?? 0 }, (_, k) => `附件-${k + 1}.pdf`),
    status: i.status === "published" ? "published" : "draft",
    updatedAt: `${i.publishedAt} 09:00`,
    publishedAt: i.status === "published" ? `${i.publishedAt} 09:00` : undefined,
  };
}

export default async function EditorPage({ params }: PageProps<"/dashboard/[role]/editor/[id]">) {
  const { role, id } = await params;
  if (!isValidRole(role) || role !== "admin") notFound();
  const base = `/dashboard/${role}`;
  const item = id === "new" || isDraftId(id) ? undefined : MANAGED_ITEMS.find((i) => i.id === id);
  if (id !== "new" && !isDraftId(id) && !item) notFound();
  return (
    <DraftEditor
      key={id}
      id={id}
      base={base}
      fallback={item ? fromItem(item) : undefined}
      meta={{ schemaVersion: item?.schemaVersion ?? 1, hasResponses: !!item?.progress?.done, responses: item?.progress?.done ?? 0 }}
    />
  );
}
