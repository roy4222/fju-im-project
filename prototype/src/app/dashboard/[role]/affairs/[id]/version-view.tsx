import Link from "next/link";
import { IconArrowLeft, IconPaperclip } from "@tabler/icons-react";
import { FORM_SCHEMAS, SUBMISSION_VERSIONS, type ManagedItem } from "@/lib/fixtures";

/**
 * 繳交歷史的「查看內容」（Codex 09-10 S-03）：某一版當時的欄位值、附件、提交者、時間，唯讀；不導到可編輯表單。
 * 原型假資料：正式版由 submission 快照提供。
 */
type Snapshot = { values: Record<string, string>; files?: { field: string; name: string; size: string }[] };

const VERSION_SNAPSHOTS: Record<string, Record<number, Snapshot>> = {
  "mi-011": {
    1: { values: { f3: "2", f4: "林彥廷 411410123\n黃詩涵 411410145\n吳柏諺 411410167\n蔡育瑄 411410189", f5: "一般專題" } },
    2: { values: { f3: "2", f4: "林彥廷 411410123\n黃詩涵 411410145\n吳柏諺 411410167\n蔡育瑄 411410189\n鄭凱文 411410201", f5: "一般專題", f6: "https://github.com/g07-fju/proposal" } },
  },
  "mi-013": {
    1: { values: { f2: "411410123", f3: "一般專題", f4: "五位組員皆為本屆學生、已閱讀專題規則第四節" } },
  },
};

export function VersionView({ item, version, base }: { item: ManagedItem; version: number; base: string }) {
  const meta = (SUBMISSION_VERSIONS[item.id] ?? []).find((v) => v.version === version);
  const snap = VERSION_SNAPSHOTS[item.id]?.[version];
  const fields = (FORM_SCHEMAS[item.id] ?? []).filter((f) => !["heading", "paragraph", "divider", "groupinfo", "attachment"].includes(f.type));
  const latest = (SUBMISSION_VERSIONS[item.id] ?? [])[0]?.version === version;
  const historyHref = `${base}/affairs/${item.id}?tab=history`;
  if (!meta || !snap) {
    return (
      <div className="p-6">
        <Link href={historyHref} className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground hover:text-foreground"><IconArrowLeft className="size-4" /> 繳交歷史</Link>
        <p className="mt-6 text-center text-sm text-muted-foreground">沒有第 {version} 次的內容。</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href={historyHref} className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted-foreground hover:text-foreground"><IconArrowLeft className="size-4" /> 繳交歷史</Link>
        <span className="text-xs text-muted-foreground">唯讀・這是第 {version} 次送出當時的內容</span>
      </div>
      <dl className="grid gap-x-8 gap-y-2 border-y border-border py-3 text-sm sm:grid-cols-2">
        <div className="flex gap-4"><dt className="w-16 shrink-0 text-muted-foreground">版本</dt><dd className="tabular font-semibold">第 {version} 次{latest ? <span className="ml-2 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success-on-subtle">採計</span> : <span className="ml-2 text-xs font-normal text-muted-foreground">已被後來的版本取代</span>}</dd></div>
        <div className="flex gap-4"><dt className="w-16 shrink-0 text-muted-foreground">提交者</dt><dd className="font-semibold">{meta.by}</dd></div>
        <div className="flex gap-4"><dt className="w-16 shrink-0 text-muted-foreground">時間</dt><dd className="tabular font-semibold">{meta.at}</dd></div>
        <div className="flex gap-4"><dt className="w-16 shrink-0 text-muted-foreground">表單版本</dt><dd className="tabular font-semibold">schema v{meta.schemaVersion}</dd></div>
        {meta.note ? <div className="flex gap-4 sm:col-span-2"><dt className="w-16 shrink-0 text-muted-foreground">備註</dt><dd>{meta.note}</dd></div> : null}
      </dl>
      <dl className="flex flex-col divide-y divide-border/70">
        {fields.map((f) => {
          const file = snap.files?.find((x) => x.field === f.id);
          const v = snap.values[f.id];
          return (
            <div key={f.id} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:gap-6">
              <dt className="text-sm font-semibold">{f.label}</dt>
              <dd className="text-sm">
                {file ? <span className="inline-flex items-center gap-1.5 font-semibold text-primary"><IconPaperclip className="size-4" />{file.name}<span className="text-xs font-normal text-muted-foreground">{file.size}</span></span> : v ? <span className="tabular whitespace-pre-wrap">{v}</span> : <span className="text-muted-foreground">（未填）</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
