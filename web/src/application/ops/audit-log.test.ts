import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_EXCLUDED_ACTIONS,
  AUDIT_UNKNOWN_ACTION_LABEL,
  AUDIT_WHO_FILTERS,
  AUDIT_WHO_LABEL,
  auditActionLabel,
  auditActionTitle,
  hasAuditActionLabel,
  auditWhoOf,
  describeAuditTarget,
  normalizeAuditWho,
} from '@/application/ops/audit-log'

/** 樣式抓不到（程式組出來）的稽核代碼。 */
const DYNAMIC_ONLY = new Set([
  'item.withdraw',
  'item.archive',
  'item.republish',
  'opportunity.publish',
  'opportunity.withdraw',
  'opportunity.republish',
  'cohort.activity.create',
  'cohort.activity.update',
  'cohort.activity.cancel',
])

/** 掃描會抓到、但不是稽核代碼的字串（檔名、故障注入點、冪等鍵等）。新增時要寫原因。 */
const NOT_AUDIT = new Set<string>([
  'demo.invalid', // 示範帳號的保留 Email 網域 `@demo.invalid`
  'showcase.jpg', // 示範資料的海報檔名
  'storage.ts', // 程式註解裡的檔名
  'session.create.before', // Better Auth 的 hook 名稱
  'signoff.void', // 冪等鍵（operationKind）；稽核代碼是 `signoff.version_void`
])

/**
 * 不是 `audit_events.action`、但對照表也要有中文的代碼：事件目錄裡的事件型別（方案 §10「操作紀錄與通知列表一律用對照表」），
 * 以及還在排隊合併的票會寫的稽核代碼（W3 首頁設定 `home.*`、W10 補交 `submission.reopen*`）。
 */
const ALSO_LABELED: readonly string[] = [
  'cohort.activated',
  'item.published',
  'item.withdrawn',
  'item.archived',
  'item.republished',
  'item.updated',
  'item.announced',
  'opportunity.published',
  'opportunity.republished',
  'opportunity.withdrawn',
  'opportunity.linked',
  'opportunity.unlinked',
  'opportunity.switched',
  'submission.submitted',
  'grading.override_review',
  'ops.worker_alert',
  'home.update',
  'home.updated',
  'home.reset',
  'submission.reopen',
  'submission.reopened',
]

/**
 * 實際寫進 `audit_events.action` 的代碼（2026-10-12 逐一查過寫入處：`#audit.append`、`insert into audit_events`、`scripts/seed-*.mjs`）。
 * 用明確清單而不是掃描：掃描樣式抓得寬，刪掉一個對照時可能被「事件型別」或「不是稽核」的排除吃掉。
 */
const WRITTEN_AUDIT_ACTIONS: readonly string[] = [
  'account.approve',
  'account.bind_google_preauthorized',
  'account.bulk_disable',
  'account.change_password',
  'account.complete_teacher_profile',
  'account.create_teacher',
  'account.deidentify',
  'account.disable',
  'account.export',
  'account.grant_role',
  'account.issue_temporary_password',
  'account.issue_temporary_password_failed',
  'account.link_google',
  'account.preauthorize_teacher',
  'account.reject',
  'account.repair_orphan',
  'account.restore',
  'account.revoke_role',
  'account.seed_e2e_admin',
  'account.seed_first_admin',
  'account.session_revocation.reconcile_limit',
  'account.set_password',
  'account.update_contact',
  'registration.apply',
  'registration.resubmit',
  'registration.revise',
  'roster.import',
  'session.revoke',
  'business_clock.set',
  'cohort.activate',
  'cohort.create',
  'cohort.save_schedule',
  'cohort.set_grouping_settings',
  'cohort.set_default_working',
  'cohort.set_registration_open',
  'cohort.activity.create',
  'cohort.activity.update',
  'cohort.activity.cancel',
  'activity.deleted',
  'advisor.assign',
  'advisor.reassign',
  'advisor.unassign',
  'advisor.claim',
  'advisor.batch',
  'group.establish',
  'group.export',
  'group.leader.change',
  'group.member.add',
  'group.member.remove',
  'group.proposal.confirm',
  'group.proposal.create',
  'group.proposal.terminate',
  'group.set_open_to_join',
  'group.type.change',
  'opportunity.create',
  'opportunity.update',
  'opportunity.publish',
  'opportunity.withdraw',
  'opportunity.republish',
  'opportunity.link',
  'opportunity.switch',
  'opportunity.unlink',
  'opportunity.deleted',
  'item.create',
  'item.save_draft',
  'item.publish',
  'item.update_published',
  'item.withdraw',
  'item.archive',
  'item.republish',
  'item.deleted',
  'submission.submit',
  'submission.advisor_visibility.enable',
  'submission.advisor_visibility.disable',
  'grading.assign',
  'grading.assignment_remove',
  'grading.export',
  'grading.override',
  'grading.override_resolve',
  'grading.requirement_set',
  'grading.return',
  'grading.save_draft',
  'grading.scheme_apply',
  'grading.scheme_create',
  'grading.scheme_publish',
  'grading.submit_final',
  'signoff.export',
  'signoff.remind',
  'signoff.respond',
  'signoff.version_create',
  'signoff.version_reopen',
  'signoff.version_reset',
  'signoff.version_supersede',
  'signoff.version_void',
  'showcase.draft_create',
  'showcase.draft_update',
  'showcase.published',
  'showcase.withdrawn',
  'showcase.republished',
  'showcase.award_set',
  'showcase.deleted',
  'showcase.backfill_create',
  'showcase.update_published',
  'showcase.home_position_set',
  'notification.test.send',
  'demo.seed',
  'demo.remove',
]

describe('操作紀錄的顯示規則（票 36）', () => {
  it('分頁參數：只收六個值，其他一律回「全部」', () => {
    expect(normalizeAuditWho('teacher')).toBe('teacher')
    expect(normalizeAuditWho('other')).toBe('other')
    expect(normalizeAuditWho(['system', 'admin'])).toBe('system')
    expect(normalizeAuditWho('root')).toBe('all')
    expect(normalizeAuditWho(undefined)).toBe('all')
  })

  it('系統與背景工作歸「系統」；沒有角色的本人動作歸「本人申請」', () => {
    expect(auditWhoOf({ actorKind: 'worker', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'system', role: null })).toBe('system')
    expect(auditWhoOf({ actorKind: 'user', role: 'admin' })).toBe('admin')
    expect(auditWhoOf({ actorKind: 'user', role: null })).toBe('other')
  })

  it('系3：每一筆都恰好落在一個非「全部」分頁，分頁數字加起來等於全部', () => {
    const samples = [
      { actorKind: 'user', role: 'admin' },
      { actorKind: 'user', role: 'teacher' },
      { actorKind: 'user', role: 'student' },
      { actorKind: 'user', role: null },
      { actorKind: 'system', role: null },
      { actorKind: 'worker', role: null },
    ] as const
    const tabs = AUDIT_WHO_FILTERS.filter((w) => w !== 'all')
    for (const s of samples) expect(tabs).toContain(auditWhoOf(s))
    expect(AUDIT_WHO_LABEL.other).toBe('本人申請')
  })

  it('動作有中文；沒登記的顯示「其他操作」，原代碼只放在滑過提示（第三波 Q26）', () => {
    expect(auditActionLabel('grading.override')).toBe('更正成績')
    expect(auditActionTitle('grading.override')).toBeUndefined()
    expect(auditActionLabel('something.new')).toBe(AUDIT_UNKNOWN_ACTION_LABEL)
    expect(AUDIT_UNKNOWN_ACTION_LABEL).toBe('其他操作')
    expect(auditActionTitle('something.new')).toBe('something.new')
    // 物件原型上的名字不能被當成「有登記」。
    expect(auditActionLabel('toString')).toBe('其他操作')
  })

  it('驗收時看到英文代碼的那幾筆（N-124、N-125、N-126）與第三波新代碼都有中文', () => {
    expect(auditActionLabel('item.republish')).toBe('重新發布專題事務')
    expect(auditActionLabel('item.archive')).toBe('下架專題事務')
    expect(auditActionLabel('account.seed_e2e_admin')).toBe('建立測試管理員帳號')
    expect(auditActionLabel('account.seed_first_admin')).toBe('建立第一位管理員')
    expect(auditActionLabel('cohort.set_registration_open')).toBe('設定新註冊學生加入的屆別')
    for (const code of [
      'item.deleted',
      'home.updated',
      'activity.deleted',
      'opportunity.deleted',
      'submission.reopen',
      'showcase.published',
      'showcase.withdrawn',
      'showcase.republished',
      'showcase.award_set',
      'showcase.deleted',
    ]) {
      expect(hasAuditActionLabel(code), code).toBe(true)
    }
  })

  it('程式裡出現的每一個動作代碼都登記了中文（新增代碼忘了登記，這裡會紅）', () => {
    // 掃 `src/` 與 `scripts/`（非測試檔）裡所有「前綴.名稱(.名稱)*」的字串，前綴取寫進稽核的全部領域。
    // 樣式刻意抓得寬：抓到的每一個不是有中文，就是下面 NOT_AUDIT 明列的「不是稽核代碼」，或是事件目錄裡的事件型別。
    const prefixes = [
      'account',
      'registration',
      'roster',
      'session',
      'cohort',
      'activity',
      'business_clock',
      'group',
      'advisor',
      'opportunity',
      'item',
      'submission',
      'grading',
      'signoff',
      'showcase',
      'home',
      'ops',
      'notification',
      'demo',
      'storage',
    ]
    const pattern = new RegExp(`['"\`]((?:${prefixes.join('|')})(?:\\.[a-z0-9_]+)+)['"\`]`, 'g')
    const webRoot = join(import.meta.dirname, '..', '..', '..')
    const codes = new Set<string>()
    for (const dir of ['src', 'scripts']) {
      for (const entry of readdirSync(join(webRoot, dir), {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile() || !/\.(tsx?|mjs)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
        for (const m of readFileSync(join(entry.parentPath, entry.name), 'utf8').matchAll(pattern)) codes.add(m[1]!)
      }
    }
    expect(codes.size).toBeGreaterThan(100)
    // 樣式抓不到、由程式組出來的稽核代碼，照產生的地方逐一列出：
    for (const code of [
      'item.withdraw',
      'item.archive',
      'item.republish', // pg-items.ts：`item.${LifecycleAction}`
      'opportunity.publish',
      'opportunity.withdraw',
      'opportunity.republish', // pg-opportunities.ts：`opportunity.${kind}`
      'cohort.activity.create',
      'cohort.activity.update',
      'cohort.activity.cancel', // pg-timeline.ts
      'account.seed_e2e_admin', // scripts/seed-e2e.mjs 直接寫 SQL
    ]) {
      expect(codes.has(code) || DYNAMIC_ONLY.has(code), code).toBe(true)
    }
    for (const code of DYNAMIC_ONLY) codes.add(code)

    // 事件型別（`application/notifications/events.ts` 的 EVENT_CATALOG 鍵）：跨模組不能在執行期引用，直接讀原始檔。
    const catalog = readFileSync(join(webRoot, 'src', 'application', 'notifications', 'events.ts'), 'utf8')
    const eventTypes = new Set([...catalog.matchAll(/^ {2}'([a-z0-9_.]+)': \{/gm)].map((m) => m[1]!))
    expect(eventTypes.has('item.archived')).toBe(true)
    const unlabeled = [...codes]
      .filter((code) => !hasAuditActionLabel(code))
      .filter((code) => !eventTypes.has(code) && !NOT_AUDIT.has(code) && !AUDIT_EXCLUDED_ACTIONS.includes(code))
      .sort()
    expect(unlabeled).toEqual([])
  })

  it('實際寫進稽核的代碼一筆一筆都有中文（刪掉任何一個對照都會紅）', () => {
    const missing = WRITTEN_AUDIT_ACTIONS.filter((code) => !hasAuditActionLabel(code))
    expect(missing).toEqual([])
  })

  it('事件型別與其他票即將寫入的代碼也有中文（對照表是操作紀錄與事件共用的）', () => {
    const missing = ALSO_LABELED.filter((code) => !hasAuditActionLabel(code))
    expect(missing).toEqual([])
  })

  it('對象：類型＋名字＋屆別代碼；屆別本身不重複寫', () => {
    expect(
      describeAuditTarget({
        targetType: 'user',
        targetName: '王小明',
        cohortCode: null,
      }),
    ).toBe('帳號・王小明')
    expect(
      describeAuditTarget({
        targetType: 'group',
        targetName: 'G03',
        cohortCode: '115',
      }),
    ).toBe('組別・G03（115）')
    expect(
      describeAuditTarget({
        targetType: 'cohort',
        targetName: '115',
        cohortCode: '115',
      }),
    ).toBe('屆別・115')
    expect(
      describeAuditTarget({
        targetType: 'evaluation',
        targetName: null,
        cohortCode: null,
      }),
    ).toBe('評分')
    expect(
      describeAuditTarget({
        targetType: 'roster_version',
        targetName: null,
        cohortCode: '115',
      }),
    ).toBe('匯入的學生名單（115）')
  })

  it('系1：屆別有名稱就寫名稱，沒有才退回代碼', () => {
    expect(
      describeAuditTarget({
        targetType: 'group',
        targetName: 'G03',
        cohortCode: '115',
        cohortName: '115 學年',
      }),
    ).toBe('組別・G03（115 學年）')
    expect(
      describeAuditTarget({
        targetType: 'group',
        targetName: 'G03',
        cohortCode: '115',
        cohortName: ' ',
      }),
    ).toBe('組別・G03（115）')
    expect(
      describeAuditTarget({
        targetType: 'cohort',
        targetName: '115 學年（115）',
        cohortCode: '115',
        cohortName: '115 學年',
      }),
    ).toBe('屆別・115 學年（115）')
  })
})
