import type { Metadata } from "next"
import Link from "next/link"

import { PageShell } from "@/components/page-shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const metadata: Metadata = { title: "備份與儲存" }

/** 占位（DV-1）：備份與儲存頁由 DV-6 做；在那之前，備份判定看能不能上線的 G4。 */
export default function BackupPage() {
  return (
    <PageShell title="備份與儲存">
      <Card data-testid="placeholder">
        <CardHeader>
          <CardTitle>這頁還在做</CardTitle>
          <CardDescription>
            先看{" "}
            <Link href="/go-live" className="underline underline-offset-4">
              能不能上線的 G4（24 小時內有備份）
            </Link>
            。
          </CardDescription>
        </CardHeader>
      </Card>
    </PageShell>
  )
}
