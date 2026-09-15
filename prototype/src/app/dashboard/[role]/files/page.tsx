import { notFound } from "next/navigation";
import { FilesManager, type FileRow } from "./files-table";
import { isValidRole } from "@/lib/nav-config";
import { ADMIN_STATS, FILES } from "@/lib/fixtures";

/** 檔案管理（規格 §4.7）：同一檔案服務的檢視與篩選，不是另一套系統。上傳、刪除限制與引用在 FilesManager（client）。 */
export default async function FilesPage({ params, searchParams }: PageProps<"/dashboard/[role]/files">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const kind = typeof sp.kind === "string" ? sp.kind : "all";
  const s = ADMIN_STATS;
  /* 引用位置：對到 MANAGED_ITEMS 的 id，列表可點過去 */
  const refOf = (f: { category: string; name: string }) => (f.name.includes("指導老師") ? "mi-028" : f.category === "系統驗收" ? "mi-030" : f.category === "規則與說明" ? "mi-031" : "mi-014");
  const rows: FileRow[] = [
    ...FILES.map((f) => ({ ...f, kind: "public", uploader: "系辦管理員", refs: 1, refItemId: refOf(f) })),
    { id: "s-1", name: "第02組_系統驗收簡報_v2.pdf", category: "專題說明會出席與分組意向登記", size: "18.2 MB", date: "2026-08-15", cohort: "114", kind: "submission", uploader: "賴威廷", refs: 1, refItemId: "mi-011" },
    { id: "s-2", name: "第02組_操作說明_v2.pdf", category: "專題說明會出席與分組意向登記", size: "4.1 MB", date: "2026-08-15", cohort: "114", kind: "submission", uploader: "賴威廷", refs: 1, refItemId: "mi-011" },
    { id: "s-3", name: "第01組_系統驗收簡報_v1.pdf", category: "專題說明會出席與分組意向登記", size: "22.7 MB", date: "2026-08-12", cohort: "114", kind: "submission", uploader: "周子瑜", refs: 1, refItemId: "mi-011" },
    { id: "a-1", name: "114-1 專題時程表.pdf", category: "114 學年度專題分組作業與指導老師意願調查開始受理", size: "96 KB", date: "2026-08-10", cohort: "114", kind: "attachment", uploader: "系辦管理員", refs: 2, refItemId: "mi-031" },
    { id: "a-2", name: "工作坊海報.png", category: "雲端服務實務工作坊（8/28）報名", size: "1.4 MB", date: "2026-08-08", cohort: "114", kind: "attachment", uploader: "系辦管理員", refs: 0 },
  ];
  return <FilesManager role={role} rows={rows} initialKind={kind} storage={{ used: s.storageUsedGiB, total: s.storageTotalGiB, lastBackupAt: s.lastBackupAt }} />;
}
