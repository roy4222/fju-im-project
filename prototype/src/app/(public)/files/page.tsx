import Link from "next/link";
import type { Metadata } from "next";
import { IconDownload, IconFileText, IconSearch, IconSearchOff } from "@tabler/icons-react";
import { ListState, PageHead } from "@/components/public/blocks";
import { NeedLogin } from "@/components/public/need-login";
import { fileCategories, listFiles } from "@/lib/data/catalog";
import { getViewer } from "@/lib/data/viewer";

export const metadata: Metadata = { title: "檔案下載", robots: { index: false }, alternates: { canonical: "/files" } };

/** 檔案下載：登入後。系辦發布的範本、格式與附件，依分類檢索（需求表 3.4、規格 §4.7）。 */
export default async function FilesPage({ searchParams }: PageProps<"/files">) {
  const sp = await searchParams;
  const category = typeof sp.category === "string" ? sp.category : "全部";
  const q = typeof sp.q === "string" ? sp.q : "";
  const viewer = await getViewer();
  if (!viewer.isMember) return <NeedLogin returnTo="/files" what="檔案下載" />;
  const files = await listFiles(viewer, { category, q });
  const groups = [...new Set(files.map((f) => f.category))].map((c) => ({ c, files: files.filter((f) => f.category === c) }));

  return (
    <>
      <PageHead title="檔案下載" description="系辦發布的範本、格式與附件。下載經伺服器授權；檔名以安全化名稱顯示。" crumbs={[{ label: "檔案下載" }]} />
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside>
          <p className="text-[13px] font-bold tracking-wider text-muted-foreground">分類</p>
          <nav className="mt-2 flex flex-col gap-1" aria-label="檔案分類">
            {fileCategories().map((c) => (
              <Link key={c} href={c === "全部" ? "/files" : `/files?category=${encodeURIComponent(c)}`} aria-current={c === category ? "true" : undefined} className={`rounded-md px-3.5 py-2.5 ${c === category ? "bg-brand-subtle font-bold text-brand-on-subtle" : "hover:bg-accent"}`}>
                {c}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex flex-col gap-8">
          <form action="/files" className="relative w-full max-w-sm">
            {category !== "全部" ? <input type="hidden" name="category" value={category} /> : null}
            <label className="sr-only" htmlFor="files-q">搜尋檔名</label>
            <IconSearch className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input id="files-q" name="q" defaultValue={q} placeholder="搜尋檔名" className="h-11 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm" />
          </form>
          {files.length === 0 ? (
            <ListState icon={<IconSearchOff className="size-9" />} title="找不到符合的檔案" hint="換個關鍵字，或清除篩選條件。" action={<Link href="/files" className="font-bold text-brand hover:underline">清除條件</Link>} />
          ) : (
            groups.map((g) => (
              <section key={g.c} className="flex flex-col gap-3" aria-label={g.c}>
                <h2 className="text-xl font-bold text-primary">{g.c}</h2>
                <ul className="overflow-hidden rounded-xl border border-border">
                  {g.files.map((f) => (
                    <li key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-5 py-3.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_90px_110px_auto]">
                      <span className="flex items-center gap-2.5 font-semibold"><IconFileText className="size-5 shrink-0 text-brand" /><span className="truncate">{f.name}</span></span>
                      <span className="hidden text-sm text-muted-foreground sm:block">{f.size}</span>
                      <span className="tabular hidden text-[13px] font-semibold text-muted-foreground sm:block">{f.date}</span>
                      <a href="#" className="btn-fju h-9 px-3.5 text-[13px]" aria-label={`下載 ${f.name}`}><IconDownload className="size-4" />下載</a>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}
