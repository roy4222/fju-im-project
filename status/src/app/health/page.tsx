import type { Metadata } from "next"
import Link from "next/link"

import { PageShell } from "@/components/page-shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata: Metadata = { title: "服務健康" }

/** 占位（DV-1）：服務健康頁由 DV-3 做；在那之前，測試站健康看能不能上線的 G3（Gatus 不對外）。 */
export default function HealthPage() {
  return (
    <PageShell title="服務健康">
      <Card data-testid="placeholder">
        <CardHeader>
          <CardTitle>這頁還在做</CardTitle>
          <CardDescription>
            先看{" "}
            <Link href="/go-live" className="underline underline-offset-4">
              能不能上線的 G3（測試站健康）
            </Link>
            。
          </CardDescription>
        </CardHeader>
      </Card>
    </PageShell>
  )
}
