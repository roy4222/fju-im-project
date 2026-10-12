import { PageCards, ToolCards } from "@/components/entry-cards"
import { PageShell } from "@/components/page-shell"
import { VersionCard } from "@/components/version-card"
import { PAGES, toolEntries } from "@/lib/data/hosts"
import { dataOrNull, readData } from "@/lib/data/read"
import { buildVersionRows } from "@/lib/data/version"

/** 總覽：版本卡片＋三頁入口＋三張工具卡。 */
export default async function OverviewPage() {
  const [github, vm, health] = await Promise.all([
    readData("github.json").then(dataOrNull),
    readData("vm.json").then(dataOrNull),
    readData("health.json").then(dataOrNull),
  ])
  const rows = buildVersionRows({ github, vm, health })
  return (
    <PageShell title="總覽">
      <VersionCard rows={rows} generatedAt={github?.generatedAt ?? null} />
      <PageCards pages={PAGES} />
      <ToolCards tools={toolEntries()} />
    </PageShell>
  )
}
