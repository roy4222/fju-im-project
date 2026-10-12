import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { shortSha, type VersionRow } from "@/lib/data/version"

const SITE_LABEL = { test: "測試站", prod: "正式站" } as const

function Sha({ value }: { value: string | null }) {
  return value ? (
    <code className="font-mono text-xs" title={value}>{shortSha(value)}</code>
  ) : (
    <span className="text-muted-foreground">沒有資料</span>
  )
}

/** 頁首版本卡片（§3.8 補充）：三個 SHA 不同時整列標黃。只是資訊，不是上線條件。 */
export function VersionCard({ rows, generatedAt }: { rows: VersionRow[]; generatedAt: string | null }) {
  return (
    <Card data-testid="version-card">
      <CardHeader>
        <CardTitle>版本</CardTitle>
        <CardDescription>
          main 上 CI 的 SHA、最後一次部署的 tag、站台 /api/health 回報的 commit；不同時標黃。
          {generatedAt ? `（資料時間 ${generatedAt}）` : "（還沒有收集器資料）"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>站</TableHead>
              <TableHead>main 的 CI</TableHead>
              <TableHead>最後部署</TableHead>
              <TableHead>站台回報</TableHead>
              <TableHead className="hidden sm:table-cell" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.site}
                data-testid={`version-${r.site}`}
                data-mismatch={r.mismatch ? "true" : "false"}
                className={r.mismatch ? "bg-yellow-100 hover:bg-yellow-100 dark:bg-yellow-950/50" : undefined}
              >
                <TableCell className="font-medium">{SITE_LABEL[r.site]}</TableCell>
                <TableCell><Sha value={r.ciSha} /></TableCell>
                <TableCell><Sha value={r.deployedTag} /></TableCell>
                <TableCell><Sha value={r.healthCommit} /></TableCell>
                <TableCell className="hidden sm:table-cell">{r.mismatch ? <Badge variant="outline">版本不一致</Badge> : null}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
