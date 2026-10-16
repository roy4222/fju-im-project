import type { Metadata } from "next"

import { PageShell } from "@/components/page-shell"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { REPO_URL } from "@/lib/progress/progress"

export const metadata: Metadata = { title: "部署與 CI" }

/** 占位（DV-1）：部署與 CI 頁由 DV-4 做；在那之前看 GitHub Actions（版本卡仍在總覽與能不能上線）。 */
export default function DeployPage() {
  return (
    <PageShell title="部署與 CI">
      <Card data-testid="placeholder">
        <CardHeader>
          <CardTitle>這頁還在做</CardTitle>
          <CardDescription>
            先看{" "}
            <a href={`${REPO_URL}/actions`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              GitHub Actions
            </a>
            。
          </CardDescription>
        </CardHeader>
      </Card>
    </PageShell>
  )
}
