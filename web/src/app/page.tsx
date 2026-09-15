import { EmptyState, LinkButton } from '@/app/_ui/primitives'
import { SiteShell } from '@/app/_ui/site-shell'

export default function HomePage() {
  return (
    <SiteShell>
      <h1 className="text-2xl font-semibold text-ink">輔仁大學資訊管理學系專題管理平台</h1>
      <p className="mt-2 max-w-prose text-muted-foreground">
        專題的名單、分組、繳交、評分與簽核都在這裡。學生用系上發的信箱或 Google 註冊，
        系辦核准後才會開通。
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <LinkButton href="/login">登入</LinkButton>
        <LinkButton href="/register" variant="secondary">
          我要註冊
        </LinkButton>
      </div>

      <div className="mt-10">
        <EmptyState
          pending
          title="公開內容還沒開放"
          description="最新消息、歷屆專題、競賽與產學合作會出現在這裡。這一批只做登入與後台骨架，公開頁在後面的切片。"
        />
      </div>
    </SiteShell>
  )
}
