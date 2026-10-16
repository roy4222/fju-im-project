import type { Metadata } from "next"
import Link from "next/link"

import { PageShell } from "@/components/page-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { UsageBar } from "@/components/usage-bar"
import { cn } from "@/components/utils"
import {
  buildBackupView,
  formatBytes,
  THRESHOLDS,
  type BackupSiteView,
  type DiskState,
  type DiskView,
} from "@/lib/backup/view"
import { dataOrNull, readData } from "@/lib/data/read"
import { formatTime } from "@/lib/deploy/view"
import type { GateResult } from "@/lib/gate/types"

export const metadata: Metadata = { title: "備份與儲存" }

const STATE_CLASS: Record<DiskState, string> = {
  green: "border-emerald-500/40 bg-emerald-50 dark:bg-emerald-950/40",
  yellow: "border-amber-500/40 bg-amber-50 dark:bg-amber-950/40",
  red: "border-red-500/40 bg-red-50 dark:bg-red-950/40",
  grey: "border-border bg-muted/60",
}

const TEXT_CLASS: Record<DiskState, string> = {
  green: "text-emerald-700 dark:text-emerald-400",
  yellow: "text-amber-700 dark:text-amber-400",
  red: "text-red-700 dark:text-red-400",
  grey: "text-muted-foreground",
}

const LINK = "underline-offset-4 hover:underline"

const SITE_LABEL = { test: "測試站", prod: "正式站" } as const

const OFFSITE_DIR_TEXT = { missing: "異地備份目錄不存在", empty: "異地備份目錄是空的" } as const

/** 「現在」：G4 判斷資料是否過期用。抽成函式讓頁面本體保持純粹。 */
const currentTime = () => new Date()

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  )
}

/** 一站最近一次備份（正本，§2）：時間、大小、成敗、錯誤；不成功時另列上次成功；異地最新檔。 */
function BackupCard({ site, view }: { site: "test" | "prod"; view: BackupSiteView }) {
  return (
    <Card data-testid={`backup-${site}`} data-state={view.state} className={cn("border", STATE_CLASS[view.state])}>
      <CardHeader>
        <CardDescription>{SITE_LABEL[site]}最近一次備份</CardDescription>
        <CardTitle data-testid="backup-result" className={cn("text-2xl", TEXT_CLASS[view.state])}>
          {view.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="flex flex-col gap-1.5 text-sm">
          <Row label="時間">{view.at ? <time dateTime={view.at}>{formatTime(view.at)}</time> : "—"}</Row>
          <Row label="大小">
            <span data-testid="backup-size">{view.bytes === null ? "—" : formatBytes(view.bytes)}</span>
          </Row>
          <Row label="錯誤">
            {view.error ? <span className={TEXT_CLASS[view.state]}>{view.error}</span> : "—"}
          </Row>
          {view.lastOk ? (
            <Row label="上次成功">
              <span data-testid="backup-last-ok">
                {view.lastOk === "never" ? (
                  "從沒成功過"
                ) : (
                  <>
                    <time dateTime={view.lastOk.at}>{formatTime(view.lastOk.at)}</time>
                    {view.lastOk.bytes === null ? null : `（${formatBytes(view.lastOk.bytes)}）`}
                  </>
                )}
              </span>
            </Row>
          ) : null}
          {view.offsite ? (
            <Row label="異地">
              <span data-testid="backup-offsite" data-offsite={view.offsite.status}>
                {view.offsite.status === "ok" ? (
                  <>
                    <code className="font-mono text-xs">{view.offsite.name}</code>（{formatBytes(view.offsite.bytes)}，
                    <time dateTime={view.offsite.mtime}>{formatTime(view.offsite.mtime)}</time>）
                  </>
                ) : (
                  OFFSITE_DIR_TEXT[view.offsite.status]
                )}
              </span>
            </Row>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  )
}

/** 主機儲存（正本，§2）：大進度條＋80／90 門檻線、已用／可用／共、量測時間與路徑。 */
function DiskCard({ disk }: { disk: DiskView }) {
  return (
    <Card data-testid="disk-usage" data-state={disk.state} className={cn("border", STATE_CLASS[disk.state])}>
      <CardHeader>
        <CardDescription>主機儲存（VM 根磁碟）</CardDescription>
        <CardTitle className={cn("text-3xl tabular-nums", TEXT_CLASS[disk.state])}>
          {disk.percent === null ? "—" : `${disk.percent}%`}
        </CardTitle>
        {disk.error ? (
          <CardDescription data-testid="disk-error">
            這一輪量不到（{disk.error}）
            {disk.checkedAt ? "，下面是上次量到的值，不是新資料。" : "，也還沒有量成功過。"}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {disk.percent === null ? null : (
          <UsageBar percent={disk.percent} thresholds={THRESHOLDS} state={disk.state} label="主機儲存用量" />
        )}
        {disk.usedBytes === null || disk.availBytes === null || disk.totalBytes === null ? null : (
          <p className="tabular-nums">
            已用 {formatBytes(disk.usedBytes)}／可用 {formatBytes(disk.availBytes)}／共 {formatBytes(disk.totalBytes)}
          </p>
        )}
        {disk.checkedAt ? (
          <p className="text-muted-foreground">
            量測時間 <time dateTime={disk.checkedAt}>{formatTime(disk.checkedAt)}</time>・路徑{" "}
            <code className="font-mono text-xs">{disk.path}</code>
          </p>
        ) : null}
        <p className="text-muted-foreground">
          超過 {THRESHOLDS[0]}% 要清，{THRESHOLDS[1]}% 會影響備份。
        </p>
      </CardContent>
    </Card>
  )
}

/** G4 一句判定（同 `/go-live`），連過去看全部五條。 */
function GateLine({ gate }: { gate: GateResult }) {
  return (
    <p data-testid="backup-gate" data-state={gate.state} className={cn("text-sm", TEXT_CLASS[gate.state])}>
      <Badge variant="outline" className="mr-2 font-mono">
        {gate.id}
      </Badge>
      {gate.title}：{gate.summary}・
      <Link href="/go-live" className={LINK}>
        看能不能上線
      </Link>
    </p>
  )
}

/** 備份與儲存（DV 設計方案 §5.4）：兩站最近一次備份、主機儲存、G4 判定。只讀 vm.json 一個檔（§8.3）。 */
export default async function BackupPage() {
  const vm = dataOrNull(await readData("vm.json"))
  const view = buildBackupView(vm, currentTime())

  return (
    <PageShell title="備份與儲存">
      <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
        <BackupCard site="test" view={view.sites.test} />
        <BackupCard site="prod" view={view.sites.prod} />
      </div>
      <DiskCard disk={view.disk} />
      <GateLine gate={view.gate} />
    </PageShell>
  )
}
