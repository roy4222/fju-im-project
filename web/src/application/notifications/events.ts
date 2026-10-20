import type { ActorKind, Scope } from '@/application/ops'

/**
 * 「發事件」的型別與純規則（模組 08 §2、§5；契約 01 §4.5、§9；產品模組 08 §4「去重、補建與保存」）。
 *
 * 事件寫進去就改不掉（`domain_events` 不可變），而且**收件人在寫入當下就固定**：
 * 之後補建通知只能照這份名單，不能重新展開成另一批人。
 * 事件跟業務寫入在同一筆交易（`EventPublisher.publish(tx, …)`），交易回滾事件就一起消失，
 * 不會有「動作沒成功卻通知了人」。
 */

/** 事件的下游消費者（`event_projections.consumer` 的 CHECK 白名單）。 */
export type EventConsumer = 'notifications' | 'digest' | 'showcase'

export const EVENT_CONSUMERS: readonly EventConsumer[] = ['notifications', 'digest', 'showcase']

/**
 * 通知匣裡的分類標籤（原型的「截止／繳交／簽核／評分／帳號／系統」）。
 * 真實業務事件由各自的票加進目錄時選一種；目前只有系統類。
 */
export type NotificationKind = 'due' | 'submission' | 'signoff' | 'grading' | 'account' | 'group' | 'system'

/** 事件投影成通知時的樣子：分類與沒有帶標題時的預設標題。 */
export type NotificationPresentation = {
  readonly kind: NotificationKind
  readonly defaultTitle: string
  /** 加在標題前面的標示（例如修改後的通知寫「（已更新）」，跟第一次的通知分得出來）。 */
  readonly titlePrefix?: string
}

type CatalogEntry = {
  readonly consumers: readonly EventConsumer[]
  /** 有 `notifications` 消費者的事件必填：投影成通知時用。 */
  readonly notification?: NotificationPresentation
}

/**
 * 事件型別目錄（模組 08 §4：實作以產品事件矩陣為準，在這裡對照）。
 *
 * 每種事件在這裡登記一次，並寫明寫入時要替哪些消費者建「待投影」列。
 * **沒登記的型別一律拒絕寫入**——後面的票新增事件時，要先在這裡補一列並對照產品矩陣，
 * 才不會有人隨手發一種 worker 不認得、或不該進通知匣的事件。
 */
export const EVENT_CATALOG = {
  /**
   * 屆別從籌備中轉進行中（票 11）。產品矩陣沒有這一列：狀態變化不另發通知，
   * 進入該屆時直接顯示目前狀態（模組 08 §4「封存／解封」同理）。事件只留紀錄。
   */
  'cohort.activated': { consumers: [] },
  /**
   * 獨立活動新增、改期、取消（票 11；模組實作設計 02 §3「event upsert／cancel」）。
   * 站內日曆是查詢組出來的，不靠通知；產品矩陣也沒有「活動異動」通知，所以沒有消費者。
   */
  'calendar.changed': { consumers: [] },
  /**
   * 投影驗收用的測試事件（模組實作設計 08 §6；收件人由發送者指定）。
   * 管理端「發一則測試通知」只在測試站（`BUSINESS_CLOCK_OVERRIDE_ENABLED=true`）開放（票 12）。
   */
  'test.notification': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '測試通知' },
  },
  /**
   * 背景工作的維運告警（票 12；模組實作設計 08 §6「≥5 標 failed＋管理員告警事件」、
   * 模組 01 附錄 A 規則 5「自動收斂到上限告警」）。收件人是發生當下所有有效的管理員。
   * 產品矩陣「備份失敗通知管理員」同一類：全站維運事件，用真實時間。
   */
  'ops.worker_alert': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '背景工作需要處理' },
  },
  /**
   * 分組邀請（票 13；產品模組 08 §4「等待本人同意（分組邀請）→本人」）。收件人＝提案全員（含提案人，
   * 提案人也要按確認）。payload 帶 `title`、提案 id、到期時間，不帶其他人的聯絡資料。
   */
  'proposal.invited': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你收到一份分組邀請' },
  },
  /** 組別成立（票 13；產品模組 08 §4「組別成立→成立後全員一則」）。收件人＝全體成員。 */
  'group.established': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別已成立' },
  },
  /**
   * 提案終止（票 13；產品模組 08 §4「提案終止→提案人與全部被邀請者，按使用者去重」）。
   * payload 帶終止種類，**不帶系辦終止的理由**（S03-07：學生看到的通知不含內部備註）。
   * C3-05 用詞：畫面與通知叫「建立組別」，系辦作廢叫「系辦終止」（標籤在 `TERMINATION_KIND_LABEL`）。
   */
  'proposal.terminated': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '這次建立組別沒有成立' },
  },
  /**
   * 管理員加入或移出組員（票 14；產品模組 08 §4「成員加入／移出→異動前後成員的聯集與目前主指導」）。
   * 收件人＝異動**後**的全體成員（加入時含新成員）＋目前主指導（票 19 補上）；被移出的人改收下面的
   * `group.member_removed`，兩則合起來就是前後聯集。payload 帶 `title`、組別與異動的人，**不帶理由**。
   *
   * 重簽不靠這個事件：成員集合改變時，加入／移出組員的用例在**同一筆交易**直接呼叫模組 07 的
   * `supersedeForParticipantChange` 讓目前簽核版本失效（票 25；事件投影是非同步的，不能拿來守「同交易」）。
   * 只換組長不發這個事件、也不重簽。
   */
  'group.members_changed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別成員有異動' },
  },
  /** 被移出的本人（票 14；產品 08 §4「被移出者只取得本人異動說明」）：只說他離開了哪一組，不帶組別內容與理由。 */
  'group.member_removed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你已被移出組別' },
  },
  /**
   * 組別解散（開站後；產品 08 §4「組別解散→解散前有效成員、主指導、評分工作因此停止的老師，一則」）。
   * 收件人在解散當下固定、去重；payload 只帶組別代碼，不帶理由與成員名單。
   */
  'group.dissolved': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別已被系辦解散' },
  },
  /** 換組長（票 14；產品 08 §4「組長更換→全組，清楚列出新組長」）。收件人＝全體成員；不帶理由。 */
  'group.leader_changed': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你的組別換了組長' },
  },
  /**
   * 主指導首次指派、認領或重派後的新老師（票 19；產品模組 08 §4「指導指派／認領→該組全員與新老師」）。
   * 收件人＝組別目前全體成員＋新主指導。重派時原老師另收下面的 `advisor.replaced`。payload 不帶理由。
   */
  'advisor.assigned': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '組別的指導老師有更新' },
  },
  /** 重派時的原主指導（票 19；產品 08 §4「重派另通知原老師」）：只說他不再指導哪一組，不帶理由。 */
  'advisor.replaced': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '你不再是這組的指導老師' },
  },
  /**
   * 管理員解除主指導（票 19）。產品 08 矩陣沒有這一列，比照重派：通知全組與原老師（組別頁會變成「尚未指派」，
   * 不通知會讓人以為資料壞了）。payload 不帶理由。
   */
  'advisor.unassigned': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '組別目前沒有指導老師' },
  },
  /**
   * 新收件發布（票 15；產品模組 08 §4「新收件發布→收件名單成員：個人收件通知本人，組別收件展開通知該組有效成員」）。
   * 一定發；發布更新時新加入收件名單的人也收這一種（「加入收件名單→與發布時同一種新收件通知」）。
   * payload 只帶項目 id、標題、位置與截止，不帶正文。
   */
  'item.published': {
    consumers: ['notifications'],
    notification: { kind: 'submission', defaultTitle: '有一份新的作業' },
  },
  /**
   * 公告、資源發布（票 15；產品模組 08 §4「重要公告發布→受眾」）：管理員勾「重要」才發，一般公告只留發布紀錄。
   * 收件人＝對象展開：本屆學生、指定組別成員、全部老師；公開與所有登入者＝全站有效帳號
   * （Roy 2026-09-25 定：公開／所有登入者的公告只有重要的才逐人通知）。下架後重新發布時再勾「重要」也發這一種。
   */
  'item.announced': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '有新的公告' },
  },
  /**
   * 組別正式送出（票 21；產品模組 05 §4.6「每次正式送出版本通知其他有效組員；暫存不通知；老師不收」）。
   * 收件人＝送出當下的有效組員扣掉送出者本人（送出者拿的是收件章回執）。個人收件不發（本人就是送出者）。
   * payload 帶項目 id、標題、第幾次、送出者名字與組別代號，**不帶回答內容與檔名**。
   */
  'submission.submitted': {
    consumers: ['notifications'],
    notification: { kind: 'submission', defaultTitle: '你的組別已正式送出一份繳交' },
  },
  /**
   * 系辦讓單一學生或單一組補交（第三波 W10）。收件人＝那一位學生；整組一份＝那一組此刻有效、帳號正常的組員。
   * 其他人不收（其他人的截止規則沒有變）。payload 帶項目 id、標題、補交期限與理由，不帶任何回答。
   */
  'submission.reopened': {
    consumers: ['notifications'],
    notification: { kind: 'submission', defaultTitle: '系辦開放你補交一份作業' },
  },
  /**
   * 已發布項目的發布更新（票 15；產品模組 08 §4「小幅修改→管理員選擇」）：管理員選通知才發。
   * 標題前加「（已更新）」：不然跟第一次發布的通知同標題、只能靠時間分（驗收第 2 章 P-09）。
   */
  'item.updated': {
    consumers: ['notifications'],
    notification: { kind: 'system', defaultTitle: '公告或作業已更新', titlePrefix: '（已更新）' },
  },
  /**
   * 撤回、下架、重新發布（票 16；產品模組 04 §4.5）。產品事件矩陣沒有這三種的通知：
   * 舊通知點進去時由來源重驗顯示「來源已撤回」或「已下架」（模組 08「舊通知與失權」），不另發通知。事件只留紀錄。
   */
  /**
   * 評分指派（票 23；產品模組 08 §4「評分指派→被指派的老師」、NTF-17）。收件人＝被指派的老師一人。
   * payload 只帶組別代號、階段與 id，**沒有任何分數**；學生永遠不會收到評分類通知（產品 06 §7.6）。
   */
  'grading.assigned': {
    consumers: ['notifications'],
    notification: { kind: 'grading', defaultTitle: '你有一份新的評分指派' },
  },
  /**
   * 系辦退回某位老師的正式評分（票 24；產品 06 §7.5「退回通知仍有權處理該筆評分的老師，附可見理由與入口」）。
   * 收件人＝那一份評分的老師（指派仍有效、帳號正常才會退回）。payload 帶組別、階段與**退回理由**，沒有分數。
   */
  'grading.returned': {
    consumers: ['notifications'],
    notification: { kind: 'grading', defaultTitle: '你的評分被系辦退回，請修改後重新送出' },
  },
  /**
   * 成績更正進「待復核」（票 24；產品 06 §7.5「首次進入待復核時通知有處理權的管理員；未解決不反覆提醒」）。
   * 收件人＝此刻有效的管理員。payload 只有組別代號。
   */
  'grading.override_review': {
    consumers: ['notifications'],
    notification: { kind: 'grading', defaultTitle: '有一筆成績更正需要重新確認' },
  },
  /**
   * 系辦把老師移出某組某階段的評分指派（含改派時被換掉的原老師；票 24 建事件、票 43 補通知；
   * 產品模組 08 §4「評分指派→解除通知原老師」、NTF-07「T3 收解除通知」）。收件人＝被移出的老師一人，
   * 保留、替換、新增三種選擇都通知；新老師另收 `grading.assigned`（「保留」不帶新老師，所以不會有虛構的補評通知）。
   * payload 帶組別代號、階段與**移除理由**（本人異動說明），**沒有任何分數**。
   */
  'grading.assignment_ended': {
    consumers: ['notifications'],
    notification: { kind: 'grading', defaultTitle: '你已被移出一份評分指派' },
  },
  /**
   * 套用新方案版本、更正（票 24）。產品事件矩陣沒有這兩種的通知（更正完成不通知老師或學生）。事件只留紀錄。
   */
  'grading.scheme_applied': { consumers: [] },
  'grading.overridden': { consumers: [] },
  /**
   * 簽核建版：輪到本人同意（票 25；產品模組 08 §4「等待本人同意（簽核輪到本人）→本人」、NTF-05）。
   * 收件人＝這一版參與者快照裡的**學生**；主指導要等全員同意後才輪到（票 26 的 `teacher_turn`），管理員不收。
   * payload 只帶組別代號、用途與版本號，**不帶全文**。
   */
  'signoff.version_created': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '有一份同意書輪到你同意' },
  },
  /**
   * 簽核版本失效（票 25；模組 07 §3「any→superseded：只標狀態、寫 cause、發事件 signoff.superseded」）。
   * **只通知系辦**（Roy 2026-09-25 定案取代舊 D-11）：組員或主指導變更造成的失效，收件人＝發生當下所有有效的管理員
   * （要去建新版的是系辦）；學生與老師不收，舊頁上看得到失效原因與「等待管理員建立新版」。
   * 管理員自己在簽核頁建新版、重置造成的失效是自己的動作，不另發通知（收件人為空，比照「最終結果更正完成→不通知」）。
   */
  'signoff.superseded': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '有一份同意書已作廢，請建立新版' },
  },
  /**
   * 一筆表態（票 26）。`approvals.event_id` 指向它：每一票都有固定的事件 ID（產品「同意紀錄內容」）。
   * 表態本身不通知任何人（進度在簽核頁），只留紀錄；輪到老師、完成、退回另有事件。
   */
  'signoff.vote_recorded': { consumers: [] },
  /**
   * 全部學生同意、輪到主指導（票 26；產品模組 08 §4「等待本人同意（簽核輪到本人）→本人」、模組 07 §3 `signoff.teacher_turn`）。
   * 收件人＝這一版快照裡的主指導。
   */
  'signoff.teacher_turn': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '學生都已同意，輪到你回覆同意書' },
  },
  /**
   * 簽核完成（票 26；產品模組 08 §4「簽核完成→完成當下的有效參與成員與主指導，每人一則；文案『此版本站內簽核已完成』，
   * 不代表校方採認」）。以「組別＋簽核版本」為單位。
   */
  'signoff.completed': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '這一版同意書已全員同意' },
  },
  /**
   * 學生不同意或老師退回，版本回到修正中（票 26）。產品 08 矩陣沒有這一列；照 S11-05 暫定的收件人：
   * 所有有效管理員（要重開新版的是系辦）＋這一版的主指導（學生不同意時；老師自己退回就不再通知自己）。
   * payload 不帶理由（理由在簽核頁與匯出看得到）。
   */
  'signoff.returned': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '有一份同意書被退回修正' },
  },
  /** 管理員提醒未表態者（票 26／S11-11）。收件人＝這一版還沒表態的參與者（含還沒輪到但待簽的老師）。 */
  'signoff.reminded': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '提醒：有一份同意書還等你回覆' },
  },
  /**
   * 同意書作業改了正文或附件、建了新版（C 階段規格① §1.2、§6.4，#161）。`signoff.superseded` 只通知系辦、收件規則不動，
   * 所以另開這一種給**被取代那一版參與者快照裡的全部學生＋主指導**（含已同意的人：舊同意不計入新版，要重新閱讀）。
   * 一版只發一種建版通知：這種新版不再發 `signoff.version_created`。C1-05 只登記，發送在 C1-03 的 hook。
   */
  'signoff.content_changed': {
    consumers: ['notifications'],
    notification: { kind: 'signoff', defaultTitle: '同意書內容已更新，請重新閱讀並同意' },
  },
  /**
   * 管理員作廢、重置、重開（票 26）。版本的生命週期紀錄（匯出的「操作歷程」用它的事件 ID）；
   * 產品矩陣沒有這幾列，不另發通知——重置與重開建的新版照樣發「輪到你同意」（`signoff.version_created`）。
   */
  'signoff.voided': { consumers: [] },
  'signoff.restarted': { consumers: [] },
  /**
   * 系辦催繳一份作業（C 階段規格① §1.5、§8，A9）：作業繳交狀況頁的「催繳未繳」與首頁逾期卡的「催繳」都發這一種，一份作業一則。
   * 收件人＝此刻名單上尚未完成的人：個人收件是本人、整組收件展開成該組有效組員；站內同意書＝這一版還沒表態的人
   * （等老師時＝主指導），沒建包的組整組排除。標題「{作業標題} 尚未繳交，截止 {時間}」。
   * 同一份作業 24 小時只能催一次：以這份作業最後一則本事件的真實時間判斷（`source_id`＝作業）。
   */
  'item.reminded': {
    consumers: ['notifications'],
    notification: { kind: 'due', defaultTitle: '有一份作業尚未繳交' },
  },
  /**
   * 系辦催評分（C 階段規格① §1.5、§8）：首頁「評分還差 N 份」卡的「催繳」。一位老師一則（每人的未送份數不同，
   * 標題「您還有 N 份評分未送出」）；收件人＝本屆有未送齊指派的老師。來源是屆別（`grading_cohort`），
   * 同一屆 24 小時只能催一次：以這一屆最後一則本事件的真實時間判斷。payload 沒有任何分數。
   */
  'grading.reminded': {
    consumers: ['notifications'],
    notification: { kind: 'grading', defaultTitle: '您還有評分未送出' },
  },
  'item.withdrawn': { consumers: [] },
  'item.archived': { consumers: [] },
  'item.republished': { consumers: [] },

  // ── 產學合作案（票 20；產品 08 §4「合作案解除／換案→受影響的組員與案主」） ──
  /**
   * 合作案發布、下架、重新發布、組別類型變更（票 20）。產品事件矩陣沒有這幾種的通知：
   * 發布後列表就看得到；下架後已連結的組員點進去看到「合作案已下架」；類型變更記在組別歷程。事件只留紀錄。
   */
  'opportunity.published': { consumers: [] },
  'opportunity.withdrawn': { consumers: [] },
  'group.type_changed': { consumers: [] },
  /**
   * 組長（或系辦）首次把組別連結到合作案（票 20）。產品 08 矩陣只有「解除／換案」，首次連結不通知，
   * 事件只留紀錄（連結不代表企業或老師承諾合作，案主在自己的合作案頁看得到）。
   */
  'opportunity.linked': { consumers: [] },
  /**
   * 換案（票 20；GRP-19「站內通知 G2 全員、C1 與 C2 案主」）。收件人＝組別目前全體成員＋原案主＋新案主。
   * payload 帶組別、兩案名稱，不帶理由。
   */
  'opportunity.switched': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '組別換了合作案' },
  },
  /** 案主或系辦解除連結（票 20；GRP-19「案主解除需理由並通知該組」）。收件人＝該組全體成員＋案主。不帶理由。 */
  'opportunity.unlinked': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '組別與合作案的連結已解除' },
  },
  /**
   * 產學組選了合作案、等負責老師確認指導（C 階段規格③ §7.2、AC-C3-12）。收件人＝那個合作案的負責老師。
   * C3-05 只登記型別與消費者（照 `group.members_changed`）；發送與標題內文在 C3-11（成立交易）與 C3-09。
   */
  'opportunity.link_requested': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '有組別選了你的合作案，請確認是否指導' },
  },
  /**
   * 負責老師婉拒待確認的合作案連結（C 階段規格③ §7.2、AC-C3-26）。收件人＝該組全體成員。不帶理由。
   * C3-05 只登記；發送在 C3-09。
   */
  'opportunity.link_declined': {
    consumers: ['notifications'],
    notification: { kind: 'group', defaultTitle: '老師婉拒了你們選的合作案，請重新選合作案' },
  },

  // ── 專題時程 ──
  /**
   * 系辦改了階段日期（C 階段規格③ §9.2、AC-C3-39）。收件人＝變動後該階段內有整組作業的組的現任組員（去重）；
   * 只改名稱不發。標題由發送端帶（「專題時程更新：第 2 階段『…』改為 11/12–5/1」），連到 `/timeline`。
   * C3-05 只登記型別與消費者（照 `group.members_changed`）；發送與收件匣來源在 C3-13。
   */
  'timeline.stage_changed': {
    consumers: ['notifications'],
    notification: { kind: 'due', defaultTitle: '專題時程有更新' },
  },
} as const satisfies Record<string, CatalogEntry>

export type EventType = keyof typeof EVENT_CATALOG

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOG, value)
}

export function consumersOf(type: EventType): readonly EventConsumer[] {
  return EVENT_CATALOG[type].consumers
}

/** 這種事件投影成通知時的樣子；不進通知匣的事件回 null。 */
export function notificationPresentationOf(type: EventType): NotificationPresentation | null {
  const entry: CatalogEntry = EVENT_CATALOG[type]
  return entry.notification ?? null
}

export type EventActor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: Exclude<ActorKind, 'user'> }

/** 業務動作要發的一個事件。 */
export type DomainEventInput = {
  readonly type: EventType
  readonly scope: Scope
  /** `scope='cohort'` 時必填；`global` 時必須是空的（契約 01 §1 scope 規則）。 */
  readonly cohortId?: string | null
  /** 事件的來源物件與版本，例如 `{ type: 'project_event', id, version: 3 }`。 */
  readonly source: { readonly type: string; readonly id: string; readonly version?: number | null }
  readonly actor: EventActor
  /** 寫入當下就固定的收件人 user id。重複的會合併，順序不重要。 */
  readonly recipients: readonly string[]
  /** 收件人是怎麼算出來的（membership、名單版本、指派版本 ID），追溯用。 */
  readonly recipientBasis?: Record<string, unknown>
  /** 只放 ID 與標題；**不放私有正文**（契約 01 §4.5）。 */
  readonly payload?: Record<string, unknown>
  /** 真實時間與業務時間都要存（契約 01 §1）。 */
  readonly occurredRealAt: Date
  readonly occurredBusinessAt: Date
}

/** 寫入前整理好的事件：收件人已去重排序、消費者已依目錄決定。 */
export type NormalizedDomainEvent = Omit<DomainEventInput, 'recipients' | 'cohortId'> & {
  readonly cohortId: string | null
  readonly recipients: readonly string[]
  readonly consumers: readonly EventConsumer[]
}

/**
 * 事件內容不合規則。這是**程式寫錯**（型別不在目錄、scope 與屆別對不上），
 * 不是使用者輸入錯——所以丟例外讓整筆交易回滾，而不是回一個給使用者看的 Result。
 */
export class DomainEventRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DomainEventRejected'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeDomainEvent(input: DomainEventInput): NormalizedDomainEvent {
  if (!isEventType(input.type)) {
    throw new DomainEventRejected(`事件型別 ${String(input.type)} 沒有在 EVENT_CATALOG 登記`)
  }
  const cohortId = input.cohortId ?? null
  if ((input.scope === 'cohort') !== (cohortId !== null)) {
    throw new DomainEventRejected('scope=cohort 必須帶 cohortId；scope=global 不可以帶')
  }
  if (!UUID.test(input.source.id)) throw new DomainEventRejected('事件來源 id 必須是 uuid')
  for (const recipient of input.recipients) {
    if (!UUID.test(recipient)) throw new DomainEventRejected(`收件人 ${recipient} 不是 uuid`)
  }
  if (input.actor.kind === 'user' && !UUID.test(input.actor.userId)) {
    throw new DomainEventRejected('操作者 id 必須是 uuid')
  }

  // 同一人兼具多個收件身分也只收一則（產品模組 08 §4「去重」）：在寫入時就合併。
  const recipients = [...new Set(input.recipients.map((id) => id.toLowerCase()))].sort()

  return { ...input, cohortId, recipients, consumers: consumersOf(input.type) }
}
