import { notFound } from "next/navigation";
import { IconDatabase, IconFolders, IconUpload } from "@tabler/icons-react";
import { PageTitle, Panel, StatTile } from "@/components/dashboard/primitives";
import { Ring, HBar } from "@/components/dashboard/charts";
import { FilesTable } from "./files-table";
import { isValidRole } from "@/lib/nav-config";
import { ADMIN_STATS, FILES } from "@/lib/fixtures";

const KINDS = [
  { key: "all", label: "全部" },
  { key: "public", label: "公開資源" },
  { key: "attachment", label: "公告附件" },
  { key: "submission", label: "組別繳交" },
];

/** 檔案管理（規格 §4.7）：同一檔案服務的檢視與篩選，不是另一套系統。 */
export default async function FilesPage({ params, searchParams }: PageProps<"/dashboard/[role]/files">) {
  const { role } = await params;
  const sp = await searchParams;
  if (!isValidRole(role) || role !== "admin") notFound();
  const kind = typeof sp.kind === "string" ? sp.kind : "all";
  const s = ADMIN_STATS;
  const rows = [
    ...FILES.map((f) => ({ ...f, kind: "public", uploader: "系辦管理員", refs: 1 })),
    { id: "s-1", name: "第02組_系統驗收簡報_v2.pdf", category: "系統驗收簡報與說明文件", size: "18.2 MB", date: "2026-08-15", cohort: "114", kind: "submission", uploader: "賴威廷", refs: 1 },
    { id: "s-2", name: "第02組_操作說明_v2.pdf", category: "系統驗收簡報與說明文件", size: "4.1 MB", date: "2026-08-15", cohort: "114", kind: "submission", uploader: "賴威廷", refs: 1 },
    { id: "s-3", name: "第01組_系統驗收簡報_v1.pdf", category: "系統驗收簡報與說明文件", size: "22.7 MB", date: "2026-08-12", cohort: "114", kind: "submission", uploader: "周子瑜", refs: 1 },
    { id: "a-1", name: "114-1 專題時程表.pdf", category: "第一階段時程公告", size: "96 KB", date: "2026-08-10", cohort: "114", kind: "attachment", uploader: "系辦管理員", refs: 2 },
  ];
  const byKind = KINDS.slice(1).map((k) => ({ ...k, count: rows.filter((r) => r.kind === k.key).length }));
  return (
    <div className="flex flex-col gap-5">
      <PageTitle title="檔案管理" description="公告附件、公開資源、表單上傳與組別繳交共用同一儲存核心。" actions={<button type="button" className="btn-fju h-10 px-4 text-sm"><IconUpload className="size-4" /> 上傳資源</button>} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        <StatTile label="儲存用量" icon={<IconDatabase />} value={`${s.storageUsedGiB}`} unit={`/ ${s.storageTotalGiB} GiB`} hint={`最近備份 ${s.lastBackupAt.slice(5)}`} chart={<Ring value={(s.storageUsedGiB / s.storageTotalGiB) * 100} size={52} stroke={6}><span className="tabular text-[11px] font-extrabold">{Math.round((s.storageUsedGiB / s.storageTotalGiB) * 100)}%</span></Ring>} />
        <StatTile label="檔案數" icon={<IconFolders />} value={rows.length} unit="個" hint="軟刪除，被引用者不可移除" />
        <Panel title="依類型" icon={<IconFolders />}>
          <ul className="flex flex-col gap-2.5 px-5 py-3">{byKind.map((k) => <li key={k.key}><HBar label={k.label} value={k.count} total={rows.length} suffix={`${k.count}`} /></li>)}</ul>
        </Panel>
      </div>
      <Panel title="檔案" icon={<IconFolders />} bodyClassName="p-4">
        <FilesTable rows={rows} initialKind={kind} />
      </Panel>
    </div>
  );
}
