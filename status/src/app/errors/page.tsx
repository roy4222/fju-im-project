import type { Metadata } from "next"

import { PageShell } from "@/components/page-shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toolEntries } from "@/lib/data/hosts"

export const metadata: Metadata = { title: "錯誤紀錄" }

/** 占位（DV-1）：錯誤紀錄頁由 DV-5 做；在那之前直接看 Dozzle 的容器 log。 */
export default function ErrorsPage() {
  const dozzle = toolEntries().find((t) => t.key === "logs")
  return (
    <PageShell title="錯誤紀錄">
      <Card data-testid="placeholder">
        <CardHeader>
          <CardTitle>這頁還在做</CardTitle>
          <CardDescription>
            先看{" "}
            <a href={dozzle?.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              Dozzle（容器 log）
            </a>
            。
          </CardDescription>
        </CardHeader>
      </Card>
    </PageShell>
  )
}
