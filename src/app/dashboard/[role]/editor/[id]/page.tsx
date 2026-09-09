import Link from "next/link";
import { notFound } from "next/navigation";
import { IconArrowLeft } from "@tabler/icons-react";
import { PageTitle } from "@/components/dashboard/primitives";
import { ItemEditor } from "@/components/dashboard/item-editor";
import { isValidRole } from "@/lib/nav-config";
import { FORM_SCHEMAS, MANAGED_ITEMS } from "@/lib/fixtures";

export default async function EditorPage({ params }: PageProps<"/dashboard/[role]/editor/[id]">) {
  const { role, id } = await params;
  if (!isValidRole(role) || role !== "admin") notFound();
  const item = id === "new" ? undefined : MANAGED_ITEMS.find((i) => i.id === id);
  if (id !== "new" && !item) notFound();
  const base = `/dashboard/${role}`;
  return (
    <div className="flex flex-col gap-4">
      <Link href={`${base}/affairs`} className="inline-flex w-fit items-center gap-1 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground"><IconArrowLeft className="size-4" /> 專題事務工作台</Link>
      <PageTitle title={item ? "編輯項目" : "新增項目"} description="一個項目只選一個主要發布位置；Dashboard 與首頁自動引用。" />
      <ItemEditor key={id} item={item ?? {}} initialFields={item ? (FORM_SCHEMAS[item.id] ?? []) : []} hasResponses={!!item?.progress?.done} />
    </div>
  );
}
