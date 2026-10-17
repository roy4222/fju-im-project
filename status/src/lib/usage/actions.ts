/**
 * `audit_events.action` 代碼 → 使用報表上的白話名（DV 設計方案 §7.5；Q-DV-7 定案：工程先填，Roy 看畫面再改字）。
 * 代碼來源：`web/src` 各處寫進 audit_events 的 `action`。對不到的代碼畫面直接顯示原代碼。
 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  // 帳號
  'account.change_password': '改密碼',
  'account.approve': '核准帳號',
  'account.reject': '退回帳號申請',
  'account.disable': '停用帳號',
  'account.bulk_disable': '批次停用帳號',
  'account.export': '匯出帳號',
  'account.issue_temporary_password': '發臨時密碼',
  'account.complete_teacher_profile': '老師補資料',
  'account.deidentify': '去識別化',
  'session.revoke': '強制登出',
  // 學生：報名、分組、繳交
  'registration.apply': '報名專題',
  'registration.revise': '修改報名',
  'group.proposal.create': '提出分組',
  'group.proposal.confirm': '確認分組',
  'group.proposal.terminate': '取消分組提案',
  'group.member.add': '加組員',
  'group.member.remove': '移除組員',
  'group.leader.change': '換組長',
  'group.set_open_to_join': '開放加入',
  'submission.upload': '上傳檔案',
  'submission.submit': '交作業',
  'showcase.draft_create': '建立成果頁',
  'showcase.draft_update': '編輯成果頁',
  'signoff.respond': '簽同意書',
  // 老師：指導、評分
  'advisor.claim': '認領指導',
  'advisor.batch': '批次指導',
  'submission.reopen': '退回重交',
  'submission.advisor_visibility.enable': '開放指導老師看',
  'grading.assign': '分派評分',
  'grading.return': '評分',
  'grading.override': '改分',
  'grading.export': '成績匯出',
  'grading.requirement_set': '設定評分項目',
  'signoff.remind': '催簽同意書',
  // 系辦：屆別、公告、名單
  'cohort.create': '建立屆別',
  'cohort.activate': '啟用屆別',
  'cohort.save_schedule': '排時程',
  'cohort.activity.create': '新增活動',
  'cohort.set_grouping_settings': '分組設定',
  'roster.import': '匯入名單',
  'group.establish': '成立分組',
  'group.export': '匯出分組',
  'group.type.change': '改分組類型',
  'grading.scheme_create': '建立評分方案',
  'grading.scheme_publish': '發布評分方案',
  'grading.scheme_apply': '套用評分方案',
  'item.create': '新增公告',
  'item.save_draft': '公告存草稿',
  'item.publish': '發布公告',
  'item.update_published': '修改已發布公告',
  'item.deleted': '刪除公告',
  'home.updated': '改首頁設定',
  'signoff.version_create': '同意書新版本',
  'signoff.export': '同意書匯出',
}

/** 白話名；對照表沒有的代碼原樣回傳。 */
export function actionLabel(action: string): string {
  return Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action]! : action
}
