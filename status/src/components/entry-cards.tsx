import { ArrowUpRightIcon } from "lucide-react"
import Link from "next/link"

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { PageEntry, ToolEntry } from "@/lib/data/hosts"

/** 總覽的三頁入口。 */
export function PageCards({ pages }: { pages: PageEntry[] }) {
  return (
    <section aria-labelledby="pages-heading" className="flex flex-col gap-3">
      <h2 id="pages-heading" className="text-sm font-medium text-muted-foreground">三頁</h2>
      <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-3">
        {pages.map((p) => (
          <Link key={p.href} href={p.href} data-testid={`page-${p.href.slice(1)}`} className="group rounded-xl focus-visible:outline-2">
            <Card className="h-full transition-colors group-hover:bg-muted/50">
              <CardHeader>
                <CardTitle>{p.title}</CardTitle>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  )
}

/** 總覽的三張工具卡（Beszel、Dozzle、PgHero，各自在 Access 後面）。 */
export function ToolCards({ tools }: { tools: ToolEntry[] }) {
  return (
    <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
      <h2 id="tools-heading" className="text-sm font-medium text-muted-foreground">工具</h2>
      <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-3">
        {tools.map((t) => (
          <a key={t.key} href={t.url} target="_blank" rel="noreferrer" data-testid={`tool-${t.key}`} className="group rounded-xl focus-visible:outline-2">
            <Card className="h-full transition-colors group-hover:bg-muted/50">
              <CardHeader>
                <CardDescription>{t.tool}</CardDescription>
                <CardTitle className="flex items-center gap-1">
                  {t.title}
                  <ArrowUpRightIcon className="size-4 text-muted-foreground" aria-hidden />
                </CardTitle>
                <CardDescription>{t.description}</CardDescription>
              </CardHeader>
            </Card>
          </a>
        ))}
      </div>
    </section>
  )
}
